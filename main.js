const { app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { autoUpdater } = require("electron-updater");

// ── Joe Modules ──
const fileWatcher = require("./modules/file-watcher");
// const clipboardMonitor = require("./modules/clipboard-monitor"); // disabled
const emailMonitor = require("./modules/email-monitor");
const gmailMonitor = require("./modules/gmail-monitor");
const { getConfig } = require("./modules/config");
const joePersonality = require("./modules/joe-personality");
const joeMemory = require("./modules/joe-memory");
const joeCharacter = require("./modules/joe-character");

let mainWindow = null;
let tray = null;
let onboardingWindow = null;

const settingsPath = path.join(app.getPath("userData"), "joe-settings.json");

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
  catch(e) { return {}; }
}

function saveSettings(data) {
  const current = loadSettings();
  fs.writeFileSync(settingsPath, JSON.stringify({ ...current, ...data }));
}

// ── Calendar (safe version) ──
function checkCalendar() {
  const helperPath = path.join(
    app.isPackaged ? __dirname.replace("app.asar", "app.asar.unpacked") : __dirname,
    "cal-helper"
  );
  exec(`"${helperPath}"`, { timeout: 10000 }, (error, stdout) => {
    if (error || !stdout || !stdout.trim()) return;
    const lines = stdout.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) return;
    const events = lines.map(line => {
      const parts = line.split("|");
      return { name: parts[0].trim(), mins: parseInt(parts[1]) };
    }).filter(e => !isNaN(e.mins) && e.mins >= 0);
    if (mainWindow) {
      mainWindow.webContents.send("calendar-reminder", events);
    }
  });
}

// ── Active window detection ──
function checkActiveWindow() {
  const script = `
    try
      tell application "System Events"
        set appName to name of first application process whose frontmost is true
      end tell
      tell application appName to set winTitle to name of front window
      return appName & "|" & winTitle
    on error
      try
        tell application "System Events"
          return name of first application process whose frontmost is true
        end tell
      on error
        return ""
      end try
    end try
  `;
  exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 }, (error, stdout) => {
    if (error || !stdout || !mainWindow || mainWindow.isDestroyed()) return;
    const parts = stdout.trim().split("|");
    const appName = (parts[0] || "").toLowerCase();
    const winTitle = (parts[1] || "").toLowerCase();
    try { mainWindow.webContents.send("active-context", { appName, winTitle }); } catch(e) {}
  });
}

// ── Tray ──
function createTray() {
  const size = 18;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = size / 2, cy = size / 2, r = size / 2 - 1;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        buf[i] = 0; buf[i+1] = 215; buf[i+2] = 255; buf[i+3] = 255; // BGRA: yellow
      } else {
        buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 0;
      }
    }
  }
  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip("Joe");

  // Gmail tray items only if OAuth credentials exist (dev setup)
  const hasGmailOAuth = fs.existsSync(path.join(require("./modules/config").CONFIG_DIR, "gmail-oauth.json"));

  const menuItems = [
    {
      label: "Show / Hide  (Cmd+Shift+C)",
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    {
      label: "Quick Chat  (Ctrl+Q)",
      click: () => openQuickChat(),
    },
    {
      label: "Screenshot to Chat  (Ctrl+S)",
      click: () => takeScreenshot(),
    },
    { type: "separator" },
    {
      label: "Manage Projects",
      click: () => {
        mainWindow.webContents.send("manage-projects", loadSettings().projects || []);
      },
    },
    {
      label: "Tutorial",
      click: () => {
        showTutorial();
      },
    },
    {
      label: "Change Name",
      click: () => {
        showChangeName((name) => {
          mainWindow.webContents.send("set-username", name);
        });
      },
    },
    {
      label: "Sync Claude Memory",
      click: () => showSyncMemoryDialog(),
    },
    { type: "separator" },
    {
      label: "Shortcuts",
      submenu: [
        { label: "Cmd+Click Joe  →  Quick Ask (screenshot + AI)", enabled: false },
        { label: "Shift+Click Joe  →  Trillo", enabled: false },
        { label: "Ctrl+Q  →  Quick Chat", enabled: false },
        { label: "Ctrl+S  →  Screenshot to Chat", enabled: false },
        { label: "Ctrl+A  →  Next Calendar Event", enabled: false },
        { label: "Cmd+Shift+C  →  Show / Hide Joe", enabled: false },
        ...(hasGmailOAuth ? [{ label: "Ctrl+M  →  Check Gmail", enabled: false }] : []),
      ],
    },
  ];

  if (hasGmailOAuth) {
    menuItems.push(
      {
        label: "Check Gmail",
        click: () => {
          mainWindow.webContents.send("gmail-checking");
          gmailMonitor.runMorningCheck();
        },
      },
      {
        label: "Add Gmail Account",
        click: () => {
          gmailMonitor.authorize();
        },
      }
    );
  }

  menuItems.push(
    { type: "separator" },
    { label: "Quit Joe", click: () => app.quit() }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);

  tray.setContextMenu(contextMenu);
}

// ── Screenshot helper (uses screen-helper Swift binary with ScreenCaptureKit) ──
function captureScreenToFile(tmpFile) {
  // In packaged app, asarUnpack puts binaries in app.asar.unpacked/
  const helperPath = path.join(
    app.isPackaged ? __dirname.replace("app.asar", "app.asar.unpacked") : __dirname,
    "screen-helper"
  );
  return new Promise((resolve, reject) => {
    exec(`"${helperPath}" "${tmpFile}"`, (err, stdout, stderr) => {
      if (err || !fs.existsSync(tmpFile)) {
        console.error("screen-helper failed:", stderr || err);
        return reject(err || new Error(stderr || "no file"));
      }
      resolve(tmpFile);
    });
  });
}

// ── Screenshot to Chat ──
function takeScreenshot() {
  const { clipboard } = require("electron");
  const tmpFile = path.join(os.tmpdir(), `joe-screenshot-${Date.now()}.png`);
  mainWindow.hide();
  setTimeout(async () => {
    try {
      await captureScreenToFile(tmpFile);
      mainWindow.show();
      const img = nativeImage.createFromPath(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (img.isEmpty()) {
        mainWindow.webContents.send("show-bubble", "screenshot vuoto 😅");
        return;
      }
      clipboard.writeImage(img);
      mainWindow.webContents.send("open-chat-and-paste");
    } catch (e) {
      console.error("Screenshot failed:", e);
      mainWindow.show();
      mainWindow.webContents.send("show-bubble", "non riesco a catturare lo schermo 😅");
    }
  }, 300);
}

// ── Screenshot Watcher: detect new screenshots on Desktop ──
let screenshotWatcher = null;
const desktopPath = path.join(os.homedir(), "Desktop");

function startScreenshotWatcher() {
  // Watch for new files on Desktop matching screenshot patterns
  const seenFiles = new Set();
  // Seed with existing files so we don't trigger on old ones
  try {
    fs.readdirSync(desktopPath).forEach(f => seenFiles.add(f));
  } catch(e) {}

  screenshotWatcher = setInterval(() => {
    try {
      const files = fs.readdirSync(desktopPath);
      for (const f of files) {
        if (seenFiles.has(f)) continue;
        seenFiles.add(f);
        // Match macOS screenshot patterns: "Screenshot", "Schermata", "Capture d'écran", etc.
        const lower = f.toLowerCase();
        if ((lower.startsWith("screenshot") || lower.startsWith("schermata") || lower.startsWith("capture")) && (lower.endsWith(".png") || lower.endsWith(".jpg"))) {
          const filePath = path.join(desktopPath, f);
          // Small delay to make sure file is fully written
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("screenshot-detected", { fileName: f, filePath });
            }
          }, 500);
        }
      }
    } catch(e) {}
  }, 2000);
}

// IPC: copy screenshot to clipboard and delete file
ipcMain.on("screenshot-copy-delete", (event, filePath) => {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) {
      const { clipboard } = require("electron");
      clipboard.writeImage(img);
      fs.unlinkSync(filePath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("show-bubble", "copied, cmd+v to paste");
      }
    }
  } catch(e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("show-bubble", "oops, couldn't copy that");
    }
  }
});

ipcMain.on("screenshot-move", (event, filePath) => {
  const { dialog } = require("electron");
  dialog.showOpenDialog(mainWindow, {
    title: "Move screenshot to...",
    defaultPath: os.homedir(),
    properties: ["openDirectory"],
  }).then(result => {
    if (result.canceled || !result.filePaths.length) return;
    try {
      const dest = path.join(result.filePaths[0], path.basename(filePath));
      fs.renameSync(filePath, dest);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("show-bubble", "moved!");
      }
    } catch(e) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("show-bubble", "couldn't move it");
      }
    }
  });
});

// ── Quick Chat ──
function openQuickChat() {
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.webContents.send("quick-chat");
}

// ── Quick Ask: screenshot + question → AI bubble response ──
const { callClaude } = require("./modules/claude-api");

ipcMain.on("quick-ask", (event, question) => {
  if (!question || !question.trim()) return;
  const tmpFile = path.join(os.tmpdir(), `joe-quickask-${Date.now()}.png`);

  // Capture context before hiding window
  const days = joeMemory.getRelationshipDays();
  const totalInteractions = joeMemory.getTotalInteractions();
  const mood = joeMemory.getCurrentMood();
  const settings = loadSettings();
  const currentUserName = settings.name || "Andrea";

  const identity = joeCharacter.getIdentity(currentUserName, days, totalInteractions);
  const moodDirective = joeCharacter.getMoodDirective(mood);
  const memorySummary = joeMemory.getMemorySummary();

  // Thread: last 3 quick-ask exchanges from this session
  const thread = joeMemory.getQuickAskThread();
  const threadText = thread.length
    ? thread.map(c => `${currentUserName}: ${c.userSaid}\nJoe: ${c.joeSaid}`).join("\n\n")
    : null;

  // Recent quick-ask history (broader, for callbacks)
  const recentQA = joeMemory.getRecentConversations(5)
    .filter(c => c.type === "quick-ask" && c.userSaid);
  const recentQAText = recentQA.length
    ? recentQA.map(c => `- ${currentUserName} asked: "${c.userSaid}" → you said: "${c.joeSaid}"`).join("\n")
    : null;

  // Pending question: if user is answering something Joe just asked
  const pendingQ = joeMemory.getRecentPendingQuestion();

  mainWindow.hide();
  setTimeout(async () => {
    try {
      await captureScreenToFile(tmpFile);
      mainWindow.show();
      mainWindow.webContents.send("show-bubble", "let me look... 🤔");

      const rawImg = nativeImage.createFromPath(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch(e) {}
      if (rawImg.isEmpty()) {
        mainWindow.webContents.send("show-bubble", "screenshot vuoto 😅");
        return;
      }
      // Resize to max 1920px wide and convert to JPEG for smaller payload
      const resized = rawImg.resize({ width: Math.min(1920, rawImg.getSize().width) });
      const imgData = resized.toJPEG(90).toString("base64");
      const mediaType = "image/jpeg";
      console.log(`Quick Ask: sending ${Math.round(imgData.length / 1024)}KB to Claude`);

        const prompt = `${identity}

${moodDirective}

${recentQAText ? `WHAT YOU REMEMBER FROM PAST CONVERSATIONS:\n${recentQAText}\n` : ""}
${memorySummary ? `\n${memorySummary}\n` : ""}
${threadText ? `CONVERSATION SO FAR THIS SESSION:\n${threadText}\n` : ""}
${pendingQ ? `NOTE: you just asked "${pendingQ.question}" in a bubble — ${currentUserName} is likely responding to that. connect your answer to that context.\n` : ""}
${currentUserName} took a screenshot and asks: "${question}"

answer rules:
- look at the screenshot, answer based on what you actually see
- stay in character — you are joe, not a generic AI
- if you've answered something similar before, acknowledge it naturally ("again with the export button, ${currentUserName}...")
- if this continues the conversation thread above, keep the thread going
- be concise: 2-4 sentences, casual, in character
- answer in the same language ${currentUserName} used
- if relevant, add a brief personal observation or opinion at the end`;

        callClaude(prompt, {
          model: "claude-haiku-4-5-20251001",
          imageBase64: imgData,
          mediaType,
          maxTokens: 300,
        }).then((response) => {
          console.log("Quick Ask response received");
          const answer = response || "hmm, not sure about that one...";
          mainWindow.webContents.send("quick-ask-response", answer);

          // Store in memory
          const entry = joeMemory.addConversation("quick-ask", question, answer, null, mood);

          // Mark pending question as answered
          if (pendingQ) joeMemory.markQuestionAnswered(pendingQ.question);

          // maybeLearnFact removed — no more API calls from memory
        }).catch((e) => {
          console.log(`Quick Ask error: ${e.message}`);
          mainWindow.webContents.send("quick-ask-response", "couldn't figure that out, sorry...");
        });
    } catch (e) {
      console.error("Quick Ask screenshot failed:", e);
      mainWindow.show();
      mainWindow.webContents.send("show-bubble", "non riesco a catturare lo schermo 😅");
    }
  }, 500);
});

// ── Project management IPC ──
ipcMain.on("add-project", (event, projectData) => {
  // projectData: { name, parentFolder }
  const settings = loadSettings();
  const projects = settings.projects || [];
  const id = projectData.name.toUpperCase().replace(/\s+/g, "_");
  if (projects.find((p) => p.id === id)) return; // already exists

  // Create "Name - To Organize" inside the chosen parent folder
  const folderName = `${projectData.name} - To Organize`;
  const inboxPath = path.join(projectData.parentFolder, folderName);
  if (!fs.existsSync(inboxPath)) {
    fs.mkdirSync(inboxPath, { recursive: true });
    console.log(`Created inbox folder: ${inboxPath}`);
  }

  projects.push({ id, name: projectData.name, inboxPath });
  saveSettings({ projects });
  console.log(`Added project: ${projectData.name} → ${inboxPath}`);
  mainWindow.webContents.send("show-bubble", `added ${projectData.name} 👍`);
});

ipcMain.on("remove-project", (event, projectId) => {
  const settings = loadSettings();
  const projects = (settings.projects || []).filter((p) => p.id !== projectId);
  saveSettings({ projects });
  console.log(`Removed project: ${projectId}`);
});

ipcMain.on("pick-project-folder", (event) => {
  dialog.showOpenDialog({
    title: "Select project inbox folder",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Select",
  }).then((result) => {
    if (!result.canceled && result.filePaths.length > 0) {
      mainWindow.webContents.send("project-folder-picked", result.filePaths[0]);
    }
  });
});

// ── Window ──
function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 440,
    height: 760,
    x: width - 460,
    y: height - 780,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("shell.html");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Window stays at fixed size — panels show/hide via CSS only

  ipcMain.on("take-screenshot", () => takeScreenshot());

  ipcMain.on("set-ignore-mouse", (event, ignore) => {
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.on("shake-window", () => {
    if (!mainWindow) return;
    const pos = mainWindow.getBounds();
    const ox = pos.x, oy = pos.y;
    let i = 0;
    const shake = setInterval(() => {
      const dx = (i % 2 === 0 ? 1 : -1) * (8 - i);
      const dy = (i % 2 === 0 ? -1 : 1) * (6 - i);
      mainWindow.setBounds({ x: ox + dx, y: oy + dy, width: pos.width, height: pos.height });
      i++;
      if (i > 8) {
        clearInterval(shake);
        mainWindow.setBounds(pos);
      }
    }, 50);
  });
}

// ── Module IPC handlers ──
ipcMain.on("file-watcher-response", (event, action, data) => {
  fileWatcher.handleResponse(action, data);
});
// folder picker removed — files go directly to project "To Organize" inbox
// ipcMain.on("clipboard-response", (event, action, data) => {
//   clipboardMonitor.handleResponse(action, data);
// });
ipcMain.on("email-response", (event, action) => {
  emailMonitor.handleResponse(action);
});
ipcMain.on("joe-phrase-request", async (event, context, app, title) => {
  const phrase = await joePersonality.generatePhrase(context, app, title);
  if (phrase && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("joe-phrase", phrase);
  }
});
ipcMain.on("email-check-now", () => {
  emailMonitor.manualCheck();
});
ipcMain.on("gmail-authorize", () => {
  gmailMonitor.authorize().then(() => {
    if (mainWindow) mainWindow.webContents.send("show-bubble", "gmail connected!");
  }).catch((err) => {
    if (mainWindow) mainWindow.webContents.send("show-bubble", "gmail auth failed: " + err.message);
  });
});
ipcMain.on("gmail-check-now", () => {
  mainWindow.webContents.send("gmail-checking");
  gmailMonitor.runMorningCheck();
});
ipcMain.on("gmail-ignore", (event, threadId) => {
  gmailMonitor.ignoreThread(threadId);
});
ipcMain.on("gmail-open", (event, threadId, account) => {
  const acctNum = (account || "").includes("numerocinquantuno") ? "2" : "0";
  if (threadId) {
    exec('open "https://mail.google.com/mail/u/' + acctNum + '/#inbox/' + threadId + '"');
  } else {
    exec('open "https://mail.google.com/mail/u/' + acctNum + '/"');
  }
});
ipcMain.on("gmail-open-all", (event, threadIds) => {
  if (threadIds && threadIds.length > 0) {
    threadIds.forEach((tid, i) => {
      setTimeout(() => {
        exec('open "https://mail.google.com/mail/u/0/#inbox/' + tid + '"');
      }, i * 800);
    });
  } else {
    exec('open "https://mail.google.com"');
  }
});
ipcMain.on("save-api-key", (event, key) => {
  const { saveConfig } = require("./modules/config");
  saveConfig({ apiKey: key });
});

// ── Load character expressions from SVG files ──
ipcMain.handle("load-expressions", async () => {
  const charDir = path.join(__dirname, "joe-character");
  const moods = ["happy", "smirk", "worried", "suspicious", "sad", "neutral"];
  const expressions = {};

  for (const mood of moods) {
    try {
      const svgPath = path.join(charDir, `${mood}.svg`);
      if (!fs.existsSync(svgPath)) continue;
      const svg = fs.readFileSync(svgPath, "utf8");

      // Extract attributes — works with any attribute order (Illustrator puts class before d/id)
      function getAttrFromTag(svgStr, id, attr) {
        // Find the tag with this id, then get the attribute value
        var re = new RegExp('<[^>]*id="' + id + '"[^>]*>', 's');
        var tagMatch = svgStr.match(re);
        if (!tagMatch) {
          // Try id after other attrs: <path class="x" id="mouth" d="...">
          re = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>', 's');
          tagMatch = svgStr.match(re);
        }
        if (!tagMatch) return null;
        // Use word boundary \b to avoid matching "id" when looking for "d"
        var attrRe = new RegExp('\\b' + attr + '="([^"]+)"');
        var m = tagMatch[0].match(attrRe);
        return m ? m[1] : null;
      }

      // Check if brow has stroke-opacity:0 in its class (Illustrator style)
      function isBrowHidden(svgStr, id) {
        var cls = getAttrFromTag(svgStr, id, "class");
        if (!cls) return false;
        // Find the class definition in <style>
        var clsRe = new RegExp('\\.' + cls + '\\s*\\{([^}]+)\\}');
        var m = svgStr.match(clsRe);
        if (m && m[1].includes("stroke-opacity") && m[1].includes("0")) return true;
        return false;
      }

      var mouth = getAttrFromTag(svg, "mouth", "d");
      var lbD = getAttrFromTag(svg, "left-brow", "d");
      var rbD = getAttrFromTag(svg, "right-brow", "d");
      var lbOp = getAttrFromTag(svg, "left-brow", "opacity");
      var rbOp = getAttrFromTag(svg, "right-brow", "opacity");
      // If no explicit opacity attr, check CSS class for stroke-opacity: 0
      if (!lbOp && isBrowHidden(svg, "left-brow")) lbOp = "0";
      if (!rbOp && isBrowHidden(svg, "right-brow")) rbOp = "0";

      // Eye size: first <circle> inside left-eye group
      var eyeMatch = svg.match(/id="left-eye"[^>]*>[\s\S]*?<circle[^>]*r="([^"]+)"/);

      expressions[mood] = {
        mouth: mouth,
        leftBrow: { d: lbD, opacity: lbOp || "1" },
        rightBrow: { d: rbD, opacity: rbOp || "1" },
        eyeSize: eyeMatch ? parseFloat(eyeMatch[1]) : 24,
      };
    } catch (e) {
      console.log(`Failed to load expression ${mood}: ${e.message}`);
    }
  }
  return expressions;
});

// ── Onboarding ──
function showOnboarding(callback) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  onboardingWindow = new BrowserWindow({
    width: 380,
    height: 520,
    x: Math.round((width - 380) / 2),
    y: Math.round((height - 520) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    vibrancy: "under-window",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  onboardingWindow.loadFile("onboarding.html");

  ipcMain.once("onboarding-done", (event, data) => {
    saveSettings({ name: data.name });
    onboardingWindow.close();
    onboardingWindow = null;
    callback(data.name);
  });
}

// ── Change Name (simple, no tutorial) ──
function showChangeName(callback) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const w = 340, h = 220;
  const changeWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    vibrancy: "under-window",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  changeWin.loadFile("change-name.html");
  ipcMain.once("change-name-done", (event, data) => {
    saveSettings({ name: data.name });
    changeWin.close();
    callback(data.name);
  });
}

// ── Tutorial (no name step, just the walkthrough) ──
function showTutorial() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const w = 380, h = 520;
  const tutorialWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    vibrancy: "under-window",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  tutorialWin.loadFile("onboarding.html", { query: { mode: "tutorial" } });
  ipcMain.once("onboarding-done", () => {
    tutorialWin.close();
  });
}

// ── Sync Claude Memory dialog ──
let syncWindow = null;

function showSyncMemoryDialog() {
  if (syncWindow && !syncWindow.isDestroyed()) { syncWindow.focus(); return; }
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const w = 400, h = 440;
  syncWindow = new BrowserWindow({
    width: w, height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    vibrancy: "under-window",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  syncWindow.loadFile("sync-memory.html");
  syncWindow.on("closed", () => { syncWindow = null; });
}

ipcMain.on("sync-memory-submit", async (event, text) => {
  // Write the pasted text to the sync file
  const syncFile = require("path").join(require("./modules/config").CONFIG_DIR, "claude-memory-sync.txt");
  require("fs").writeFileSync(syncFile, text, "utf8");

  // Close the dialog
  if (syncWindow && !syncWindow.isDestroyed()) {
    syncWindow.webContents.send("sync-memory-done", { ok: true });
    setTimeout(() => { if (syncWindow && !syncWindow.isDestroyed()) syncWindow.close(); }, 900);
  }

  // Show loading bubble on Joe
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("show-bubble", "give me a sec... 🤔");
  }

  // Run the sync
  try {
    const result = await joeMemory.syncFromClaudeMemory();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const msg = result.added > 0
        ? `absorbed ${result.added} new things about you 👀`
        : result.updated > 0
          ? `updated ${result.updated} things I already knew 👀`
          : "nothing new. I knew it all already.";
      mainWindow.webContents.send("show-bubble", msg);
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("show-bubble", "sync failed. check the log.");
    }
  }
});

// ── Default projects for Banana Joe Games (auto-detected by Google Drive folder) ──
function initDefaultProjects() {
  const settings = loadSettings();
  if (settings.projects && settings.projects.length > 0) return; // already configured

  const gdriveBase = path.join(os.homedir(),
    "Library/CloudStorage/GoogleDrive-info@bananajoe.games/Shared drives/Banana Joe Production"
  );
  if (!fs.existsSync(gdriveBase)) return; // not a BJG machine

  const defaults = [
    { id: "DOOMTILE", name: "Doomtile" },
    { id: "JUJU", name: "Juju" },
    { id: "BOMBSHELL", name: "Bombshell" },
    { id: "HUNGER_CHAIN", name: "Hunger Chain" },
    { id: "SOUND_OF_VIOLENCE", name: "Sound of Violence" },
  ];

  const projects = defaults.map((p) => {
    const folderName = p.id.replace(/_/g, " ");
    return {
      ...p,
      inboxPath: path.join(gdriveBase, folderName, `${folderName} - To Organize`),
    };
  }).filter((p) => fs.existsSync(p.inboxPath));

  if (projects.length > 0) {
    saveSettings({ projects });
    console.log(`Auto-configured ${projects.length} BJG projects`);
  }
}

// ── App lifecycle ──
app.whenReady().then(() => {
  initDefaultProjects();
  const settings = loadSettings();

  function startApp(name) {
    createWindow();
    createTray();
    joePersonality.setUserName(name);

    // ── Daily summary at 22:00 ──
    function scheduleDailySummary() {
      const now = new Date();
      const target = new Date();
      target.setHours(22, 0, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const msUntil = target.getTime() - now.getTime();
      setTimeout(() => {
        const summary = joeMemory.generateDailySummary(name);
        if (summary) console.log("Joe daily summary:", summary.substring(0, 80));
        setInterval(() => {
          joeMemory.generateDailySummary(name);
        }, 24 * 60 * 60 * 1000);
      }, msUntil);
      console.log(`Joe daily summary scheduled in ${Math.round(msUntil / 60000)} minutes`);
    }
    scheduleDailySummary();

    // Silent boot sync — absorb any new Claude.ai memory since last run
    joeMemory.syncFromClaudeMemory().then((r) => {
      if (r && !r.skipped && r.added > 0) {
        console.log(`Joe boot sync: absorbed ${r.added} new facts from Claude.ai memory`);
      }
    }).catch(() => {});

    // Send name and initial mood to renderer
    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.webContents.send("set-username", name);
      mainWindow.webContents.send("joe-mood-update", joeMemory.getCurrentMood());
    });

    globalShortcut.register("CommandOrControl+Shift+C", () => {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });

    globalShortcut.register("Control+S", () => takeScreenshot());

    globalShortcut.register("Control+Q", () => openQuickChat());

    globalShortcut.register("Control+A", () => checkCalendar());

    globalShortcut.register("Control+M", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("gmail-checking");
        gmailMonitor.runMorningCheck();
      }
    });

    // Check active window every 3 seconds
    setTimeout(checkActiveWindow, 2000);
    setInterval(checkActiveWindow, 3000);

    // Watch Desktop for new screenshots
    startScreenshotWatcher();

    // Auto-update: check on launch, then every 4 hours
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);

    // ── Start Joe Modules ──
    const modConfig = getConfig();
    mainWindow.webContents.on("did-finish-load", () => {
      if (modConfig.modules?.fileWatcher !== false) fileWatcher.start(mainWindow);
      // clipboardMonitor disabled
      // emailMonitor disabled — using gmail-monitor instead (manual only)
      const hasOAuth = fs.existsSync(path.join(require("./modules/config").CONFIG_DIR, "gmail-oauth.json"));
      if (hasOAuth && modConfig.modules?.gmailMonitor !== false) gmailMonitor.start(mainWindow);
    });
  }

  if (settings.name) {
    startApp(settings.name);
  } else {
    showOnboarding((name) => startApp(name));
  }
});

// Auto-update events
autoUpdater.on("update-downloaded", (info) => {
  if (mainWindow) {
    mainWindow.webContents.send("show-bubble", `update ${info.version} ready — restarting soon`);
  }
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 10000);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  joePersonality.shutdown();
});
app.on("window-all-closed", () => app.quit());
