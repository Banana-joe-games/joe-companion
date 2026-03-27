// ── File Watcher: monitors ~/Downloads and ~/Desktop ──
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { callClaude, parseJSON } = require("./claude-api");
const { getConfig, saveConfig, getFolderMap, saveFolderMap, CONFIG_DIR, log } = require("./config");

const WATCH_DIRS = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const MEMORY_FILE = path.join(CONFIG_DIR, "file-memory.json");
let watchers = [];
let mainWindow = null;
let cooldownUntil = 0;
let ignoreCount = 0;

// ── File memory: learns from user corrections ──
function getMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); }
  catch(e) { return { associations: [] }; }
}

function saveMemory(mem) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

function rememberAssociation(description, projectId) {
  const mem = getMemory();
  // Avoid duplicates
  const existing = mem.associations.find(a => a.description === description);
  if (existing) {
    existing.projectId = projectId;
  } else {
    mem.associations.push({ description, projectId, date: new Date().toISOString() });
  }
  // Keep last 50 associations
  if (mem.associations.length > 50) mem.associations = mem.associations.slice(-50);
  saveMemory(mem);
  log(`Remembered: "${description}" -> ${projectId}`);
}

function getMemoryContext() {
  const mem = getMemory();
  if (!mem.associations.length) return "";
  const recent = mem.associations.slice(-15);
  return "\n\nPast user associations (learn from these):\n" +
    recent.map(a => `- "${a.description}" -> ${a.projectId}`).join("\n");
}

function start(win) {
  mainWindow = win;
  log("File Watcher started");

  WATCH_DIRS.forEach((dir) => {
    try {
      const w = fs.watch(dir, (eventType, filename) => {
        if (eventType !== "rename" || !filename || filename.startsWith(".")) return;
        const filePath = path.join(dir, filename);
        // Small delay to let file finish writing, then check it exists and is a file
        setTimeout(() => {
          try {
            if (!fs.existsSync(filePath)) return;
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return;
            processFile(filename, dir);
          } catch(e) {}
        }, 2500);
      });
      watchers.push(w);
      log(`Watching: ${dir}`);
    } catch(e) {
      log(`File Watcher error on ${dir}: ${e.message}`);
    }
  });
}

function stop() {
  watchers.forEach(w => w.close());
  watchers = [];
  log("File Watcher stopped");
}

async function processFile(filename, sourceDir) {
  const filePath = path.join(sourceDir, filename);
  if (!fs.existsSync(filePath)) return;

  const ext = path.extname(filename).toLowerCase();
  const isImage = IMAGE_EXTS.includes(ext);

  // Show loading bubble right away — before the API call
  sendToRenderer("file-watcher-loading", { filename, isImage });

  try {
    let analysis;
    if (isImage) {
      const stat = fs.statSync(filePath);
      if (stat.size < 100) {
        log(`Skipping tiny image (${stat.size} bytes): ${filename}`);
        analysis = simpleMatch(filename);
      } else {
        analysis = await analyzeImage(filePath, filename);
      }
    } else {
      analysis = await analyzeFilename(filename);
    }

    log(`Analysis result for ${filename}: ${JSON.stringify(analysis)}`);

    if (!analysis) {
      log(`No analysis result for ${filename}, trying simple match`);
      analysis = simpleMatch(filename);
    }

    if (!analysis) {
      log(`No match at all for ${filename}`);
      return;
    }

    // Send to renderer with full context
    sendToRenderer("file-watcher-step", {
      step: "identify",
      filename,
      filePath,
      isImage,
      imageDescription: analysis.description || "",
      imageType: analysis.type || "",
      projectId: analysis.project || "none",
      projectName: getProjectName(analysis.project),
      reason: analysis.reason || "",
      confidence: analysis.confidence || "low",
    });

  } catch(e) {
    log(`File analysis error: ${e.message}`);
    // Fallback: simple pattern matching
    const simple = simpleMatch(filename);
    if (simple) {
      sendToRenderer("file-watcher-step", {
        step: "identify",
        filename,
        filePath,
        isImage: false,
        projectId: simple.project,
        projectName: getProjectName(simple.project),
        reason: simple.reason,
        confidence: simple.confidence,
      });
    }
  }
}

function getProjectName(projectId) {
  if (!projectId || projectId === "none") return "";
  const config = getConfig();
  const p = config.projects.find(pr => pr.id === projectId);
  return p ? p.name : projectId;
}

// AI-powered image analysis
async function analyzeImage(filePath, filename) {
  const config = getConfig();
  const projectList = config.projects.map(p => `${p.id} (${p.desc})`).join(", ");
  const memory = getMemoryContext();

  const imageData = fs.readFileSync(filePath).toString("base64");
  const ext = path.extname(filename).toLowerCase();
  const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";

  const prompt = `Describe this image briefly, then pick the BEST matching project. Projects: ${projectList}.${memory}

Rules:
- If the image clearly relates to one project, pick it with confidence "high"
- If it could relate to a project but you're not sure, pick the closest and set confidence "low"
- ONLY set project to "none" if the image is completely unrelated to any project (e.g. a UI screenshot, a system dialog, a random meme with no board game or art content)
- When in doubt, pick a project rather than "none"

Reply ONLY with JSON: {"project":"...","confidence":"high/medium/low","description":"brief image description in English","reason":"why this project, one sentence in English"}`;

  const response = await callClaude(prompt, {
    model: "claude-haiku-4-5-20251001",
    imageBase64: imageData,
    mediaType,
    maxTokens: 150,
  });

  return parseJSON(response);
}

// AI-powered filename analysis
async function analyzeFilename(filename) {
  const config = getConfig();
  const projectList = config.projects.map(p => `${p.id} (${p.desc})`).join(", ");
  const memory = getMemoryContext();

  const prompt = `File downloaded: "${filename}". Pick the BEST matching project. Projects: ${projectList}.${memory}

Rules:
- If the filename clearly relates to one project, pick it with confidence "high"
- If it could relate to a project but you're not sure, pick the closest and set confidence "low"
- ONLY set project to "none" if the filename is completely generic (e.g. "Screenshot", "Untitled", "document.pdf") with no hint of any project
- When in doubt, pick a project rather than "none"

Reply ONLY with JSON: {"project":"...","confidence":"high/medium/low","reason":"why this project, one sentence in English"}`;

  const response = await callClaude(prompt, { maxTokens: 150 });
  return parseJSON(response);
}

// Simple pattern matching (fallback without AI)
function simpleMatch(filename) {
  const lower = filename.toLowerCase();
  const config = getConfig();
  for (const p of config.projects) {
    if (lower.includes(p.id.toLowerCase()) || lower.includes(p.name.toLowerCase())) {
      return { project: p.id, confidence: "high", reason: `filename contains "${p.id}"` };
    }
  }
  return null;
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Response handlers (called from main.js via IPC) ──

function handleResponse(action, data) {
  switch(action) {
    case "confirm-project":
      // User confirmed the suggested project — remember this
      if (data.description) rememberAssociation(data.description, data.projectId);
      initiateMove(data.filePath, data.projectId);
      ignoreCount = 0;
      break;

    case "wrong-project":
      // User said no, show project list
      sendToRenderer("file-watcher-step", {
        step: "pick-project",
        filename: data.filename,
        filePath: data.filePath,
        description: data.description || "",
        allProjects: getConfig().projects,
      });
      break;

    case "pick-project":
      // User picked a different project — remember the correction
      if (data.description) rememberAssociation(data.description, data.projectId);
      initiateMove(data.filePath, data.projectId);
      ignoreCount = 0;
      break;

    case "new-project":
      // User typed a new project name
      addProject(data.projectName);
      initiateMove(data.filePath, data.projectName.toUpperCase().replace(/\s+/g, "_"));
      ignoreCount = 0;
      break;

    case "set-folder":
      // User chose a folder via Finder picker
      setFolderAndMove(data.filePath, data.projectId, data.folderPath);
      break;

    case "trash":
      // User wants to trash the file
      trashFile(data.filePath);
      break;

    case "leave":
      // User wants to leave file in Downloads
      ignoreCount++;
      log(`User left file in Downloads (ignore count: ${ignoreCount})`);
      break;
  }
}

function addProject(name) {
  const config = getConfig();
  const id = name.toUpperCase().replace(/\s+/g, "_");
  if (!config.projects.find(p => p.id === id)) {
    config.projects.push({ id, name, desc: "" });
    saveConfig({ projects: config.projects });
    log(`Added new project: ${name} (${id})`);
  }
}

function initiateMove(filePath, projectId) {
  const folderMap = getFolderMap();
  const targetDir = folderMap[projectId];

  if (targetDir && fs.existsSync(targetDir)) {
    // Known folder — ask to confirm
    sendToRenderer("file-watcher-step", {
      step: "confirm-move",
      filename: path.basename(filePath),
      filePath,
      projectId,
      folderPath: targetDir,
      folderName: path.basename(targetDir),
    });
  } else {
    // Unknown folder — ask user to pick
    sendToRenderer("file-watcher-step", {
      step: "pick-folder",
      filename: path.basename(filePath),
      filePath,
      projectId,
      projectName: getProjectName(projectId) || projectId,
    });
  }
}

function setFolderAndMove(filePath, projectId, folderPath) {
  if (!folderPath) return;
  const folderMap = getFolderMap();
  folderMap[projectId] = folderPath;
  saveFolderMap(folderMap);
  log(`Saved folder mapping: ${projectId} -> ${folderPath}`);
  doMove(filePath, folderPath);
}

function doMove(filePath, targetDir) {
  const filename = path.basename(filePath);
  const dest = path.join(targetDir, filename);

  try {
    fs.renameSync(filePath, dest);
    sendToRenderer("show-bubble", `done! moved ${filename} ✓`);
    log(`Moved ${filename} to ${targetDir}`);
  } catch(e) {
    try {
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
      sendToRenderer("show-bubble", `done! moved ${filename} ✓`);
      log(`Moved (copy) ${filename} to ${targetDir}`);
    } catch(e2) {
      log(`Move error: ${e2.message}`);
      sendToRenderer("show-bubble", `ugh, can't move that file...`);
    }
  }
}

// Move file to Trash
function trashFile(filePath) {
  const { shell } = require("electron");
  const filename = path.basename(filePath);
  shell.trashItem(filePath).then(() => {
    sendToRenderer("show-bubble", `trashed ${filename} 🗑`);
    log(`Trashed: ${filename}`);
  }).catch((err) => {
    log(`Trash error: ${err.message}`);
    sendToRenderer("show-bubble", `can't trash that one...`);
  });
}

// Open Finder folder picker (called from main process)
function openFolderPicker(filePath, projectId) {
  const { dialog } = require("electron");
  const projectName = getProjectName(projectId) || projectId;
  dialog.showOpenDialog({
    title: `Where should I put ${projectName} files?`,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Scegli",
  }).then((result) => {
    if (result.canceled || !result.filePaths.length) {
      sendToRenderer("show-bubble", `ok, leaving it here for now.`);
      return;
    }
    setFolderAndMove(filePath, projectId, result.filePaths[0]);
  }).catch((err) => {
    log(`Folder picker error: ${err.message}`);
    sendToRenderer("show-bubble", `Ok, lo lascio qui per ora.`);
  });
}

module.exports = { start, stop, handleResponse, openFolderPicker };
