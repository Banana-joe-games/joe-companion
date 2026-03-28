// ── File Watcher: monitors ~/Downloads, routes to project inboxes ──
// Joe detects files → user picks project → file goes to "To Organize" folder
// Cowork (Claude Desktop) handles the rest on its scheduled runs
const fs = require("fs");
const path = require("path");
const os = require("os");

const { getConfig, saveConfig, CONFIG_DIR, log } = require("./config");

const WATCH_DIRS = [
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
];

// Projects are loaded from joe-settings.json
// Each project: { id, name, inboxPath }
function getProjects() {
  try {
    const settingsPath = path.join(
      process.env.HOME || os.homedir(),
      "Library/Application Support/clippy-claude/joe-settings.json"
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings.projects || [];
  } catch (e) {
    return [];
  }
}

let watchers = [];
let mainWindow = null;
const recentFiles = new Set(); // debounce duplicate events

function start(win) {
  mainWindow = win;
  log("File Watcher started (no-API mode, routes to Cowork inboxes)");

  WATCH_DIRS.forEach((dir) => {
    try {
      const w = fs.watch(dir, (eventType, filename) => {
        if (eventType !== "rename" || !filename || filename.startsWith(".")) return;

        // Skip screenshots
        const fnLower = filename.toLowerCase();
        if (
          (fnLower.startsWith("screenshot") ||
            fnLower.startsWith("schermata") ||
            fnLower.startsWith("capture")) &&
          (fnLower.endsWith(".png") || fnLower.endsWith(".jpg"))
        )
          return;

        // Debounce: ignore if we just saw this file
        const key = filename;
        if (recentFiles.has(key)) return;
        recentFiles.add(key);
        setTimeout(() => recentFiles.delete(key), 10000);

        const filePath = path.join(dir, filename);

        // Wait for file to finish writing
        setTimeout(() => {
          try {
            if (!fs.existsSync(filePath)) return;
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return;
            showProjectPicker(filename, filePath);
          } catch (e) {}
        }, 2500);
      });
      watchers.push(w);
      log(`Watching: ${dir}`);
    } catch (e) {
      log(`File Watcher error on ${dir}: ${e.message}`);
    }
  });
}

function stop() {
  watchers.forEach((w) => w.close());
  watchers = [];
  log("File Watcher stopped");
}

// ── Show project picker (no API, instant) ──

function showProjectPicker(filename, filePath) {
  // Try simple pattern match first
  const autoMatch = simpleMatch(filename);

  if (autoMatch) {
    // Auto-detected project from filename
    sendToRenderer("file-watcher-step", {
      step: "identify",
      filename,
      filePath,
      projectId: autoMatch.id,
      projectName: autoMatch.name,
      confidence: "high",
    });
  } else {
    // No match — show all project buttons immediately
    sendToRenderer("file-watcher-step", {
      step: "pick-project",
      filename,
      filePath,
      allProjects: getProjects(),
    });
  }
}

// Simple pattern matching — check if filename contains project name/code
function simpleMatch(filename) {
  const lower = filename.toLowerCase();
  for (const p of getProjects()) {
    const name = p.name.toLowerCase();
    const id = p.id.toLowerCase();
    if (lower.includes(name) || lower.includes(id)) {
      return p;
    }
  }
  return null;
}

// ── Response handlers (called from main.js via IPC) ──

function handleResponse(action, data) {
  switch (action) {
    case "confirm-project":
    case "pick-project":
      moveToInbox(data.filePath, data.projectId);
      break;

    case "wrong-project":
      // Show full project list
      sendToRenderer("file-watcher-step", {
        step: "pick-project",
        filename: data.filename,
        filePath: data.filePath,
        allProjects: getProjects(),
      });
      break;

    case "trash":
      trashFile(data.filePath);
      break;

    case "leave":
      log("User left file in place");
      break;
  }
}

// ── Move file to project inbox ──

function moveToInbox(filePath, projectId) {
  const project = getProjects().find((p) => p.id === projectId);
  if (!project) {
    log(`Unknown project: ${projectId}`);
    sendToRenderer("show-bubble", "hmm, don't know that project...");
    return;
  }

  const inboxDir = project.inboxPath;
  const filename = path.basename(filePath);

  // Check inbox exists
  if (!fs.existsSync(inboxDir)) {
    log(`Inbox not found: ${inboxDir}`);
    sendToRenderer(
      "show-bubble",
      `can't find the ${project.name} inbox folder...`
    );
    return;
  }

  const dest = path.join(inboxDir, filename);

  try {
    // Try rename first (same volume), fallback to copy
    fs.renameSync(filePath, dest);
    sendToRenderer(
      "show-bubble",
      `sent to ${project.name} inbox ✓`
    );
    log(`Moved ${filename} → ${inboxDir}`);
  } catch (e) {
    try {
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
      sendToRenderer(
        "show-bubble",
        `sent to ${project.name} inbox ✓`
      );
      log(`Moved (copy) ${filename} → ${inboxDir}`);
    } catch (e2) {
      log(`Move error: ${e2.message}`);
      sendToRenderer("show-bubble", "ugh, can't move that file...");
    }
  }
}

// Move file to Trash
function trashFile(filePath) {
  const { shell } = require("electron");
  const filename = path.basename(filePath);
  shell
    .trashItem(filePath)
    .then(() => {
      sendToRenderer("show-bubble", `trashed ${filename} 🗑`);
      log(`Trashed: ${filename}`);
    })
    .catch((err) => {
      log(`Trash error: ${err.message}`);
      sendToRenderer("show-bubble", "can't trash that one...");
    });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

module.exports = { start, stop, handleResponse };
