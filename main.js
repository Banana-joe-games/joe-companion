const { app, BrowserWindow, screen, globalShortcut, ipcMain, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { exec } = require("child_process");
const { autoUpdater } = require("electron-updater");

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
  const helperPath = path.join(__dirname, "cal-helper");
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
    if (error || !stdout || !mainWindow) return;
    const parts = stdout.trim().split("|");
    const appName = (parts[0] || "").toLowerCase();
    const winTitle = (parts[1] || "").toLowerCase();
    mainWindow.webContents.send("active-context", { appName, winTitle });
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
        buf[i] = 255; buf[i+1] = 215; buf[i+2] = 0; buf[i+3] = 255;
      } else {
        buf[i] = 0; buf[i+1] = 0; buf[i+2] = 0; buf[i+3] = 0;
      }
    }
  }
  const icon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  tray = new Tray(icon);
  tray.setToolTip("Joe");

  const contextMenu = Menu.buildFromTemplate([
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
      label: "Screenshot to Chat  (Cmd+Shift+S)",
      click: () => takeScreenshot(),
    },
    { type: "separator" },
    {
      label: "Change Name",
      click: () => {
        showOnboarding((name) => {
          mainWindow.webContents.send("set-username", name);
        });
      },
    },
    { type: "separator" },
    { label: "Quit Joe", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
  });
}

// ── Screenshot ──
function takeScreenshot() {
  mainWindow.hide();
  setTimeout(() => {
    exec("screencapture -ic", () => {
      mainWindow.show();
      mainWindow.webContents.send("open-chat-and-paste");
    });
  }, 300);
}

// ── Quick Chat ──
function openQuickChat() {
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.webContents.send("quick-chat");
}

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

// ── Onboarding ──
function showOnboarding(callback) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  onboardingWindow = new BrowserWindow({
    width: 340,
    height: 260,
    x: Math.round((width - 340) / 2),
    y: Math.round((height - 260) / 2),
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
    if (data.openPerms) {
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"');
    }
    onboardingWindow.close();
    onboardingWindow = null;
    callback(data.name);
  });
}

// ── App lifecycle ──
app.whenReady().then(() => {
  const settings = loadSettings();

  function startApp(name) {
    createWindow();
    createTray();
    // Send name to renderer
    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.webContents.send("set-username", name);
    });

    globalShortcut.register("CommandOrControl+Shift+C", () => {
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });

    globalShortcut.register("CommandOrControl+Shift+S", () => takeScreenshot());

    globalShortcut.register("Control+Q", () => openQuickChat());

    globalShortcut.register("Control+A", () => checkCalendar());

    // Check active window every 3 seconds
    setTimeout(checkActiveWindow, 2000);
    setInterval(checkActiveWindow, 3000);

    // Auto-update: check on launch, then every 4 hours
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
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

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
