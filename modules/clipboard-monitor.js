// ── Clipboard Monitor: watches pbpaste for patterns ──
const { exec } = require("child_process");
const { getConfig, log } = require("./config");

let interval = null;
let mainWindow = null;
let lastClipboard = "";
let cooldownUntil = 0;
let ignoreCount = 0;

function start(win) {
  mainWindow = win;
  log("Clipboard Monitor started");

  interval = setInterval(checkClipboard, 2000);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
  log("Clipboard Monitor stopped");
}

function checkClipboard() {
  exec("pbpaste", { timeout: 2000 }, (err, stdout) => {
    if (err || !stdout.trim()) return;
    const text = stdout.trim();

    // Skip if same as last check
    if (text === lastClipboard) return;
    lastClipboard = text;

    // Check cooldown
    const config = getConfig();
    const cooldown = ignoreCount >= 3 ? 600000 : (config.cooldowns?.clipboard || 120000);
    if (Date.now() < cooldownUntil) return;

    const match = detectPattern(text);
    if (match) {
      cooldownUntil = Date.now() + cooldown;
      showSuggestion(match);
    }
  });
}

function detectPattern(text) {
  // Email pattern
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return { type: "email", value: text, message: `copied an email: ${text}. create a reminder to contact them?` };
  }

  // IBAN pattern
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/.test(text.replace(/\s/g, ""))) {
    return { type: "iban", value: text, message: `IBAN copied. create a reminder?` };
  }

  // Phone pattern (international or Italian)
  if (/^(\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}$/.test(text.replace(/\s/g, ""))) {
    return { type: "phone", value: text, message: `phone number copied: ${text}. reminder to call?` };
  }

  // URL pattern
  if (/^https?:\/\//.test(text)) {
    return detectURL(text);
  }

  return null;
}

function detectURL(url) {
  const lower = url.toLowerCase();

  if (lower.includes("kickstarter.com")) {
    return { type: "url", subtype: "kickstarter", value: url, message: `Kickstarter link! save as DOOMTILE reference?` };
  }
  if (lower.includes("boardgamegeek.com")) {
    return { type: "url", subtype: "bgg", value: url, message: `BGG link, save it?` };
  }
  if (lower.includes("artstation.com") || lower.includes("behance.net")) {
    return { type: "url", subtype: "portfolio", value: url, message: `artist portfolio. save as reference?` };
  }

  // Don't suggest for common URLs
  if (lower.includes("google.com") || lower.includes("youtube.com") || lower.includes("github.com") || lower.includes("stackoverflow.com")) {
    return null;
  }

  return { type: "url", subtype: "other", value: url, message: `URL copied. save as reminder?` };
}

function showSuggestion(match) {
  if (!mainWindow) return;
  mainWindow.webContents.send("clipboard-suggestion", match);
}

// Called from renderer when user responds
function handleResponse(action, data) {
  if (action === "remind") {
    createReminder(data);
    ignoreCount = 0;
  } else if (action === "ignore") {
    ignoreCount++;
    log(`User ignored clipboard suggestion (count: ${ignoreCount})`);
  }
}

function createReminder(data) {
  const title = data.type === "email" ? `Contact ${data.value}`
    : data.type === "phone" ? `Call ${data.value}`
    : data.type === "iban" ? `IBAN: ${data.value.substring(0, 10)}...`
    : `Link: ${data.value.substring(0, 50)}`;

  const script = `osascript -e 'tell application "Reminders" to make new reminder with properties {name:"${title.replace(/"/g, '\\"')}"}'`;

  exec(script, { timeout: 5000 }, (err) => {
    if (err) {
      log(`Reminder error: ${err.message}`);
      mainWindow?.webContents.send("show-bubble", `can't create the reminder...`);
    } else {
      mainWindow?.webContents.send("show-bubble", `reminder created ✓`);
      log(`Created reminder: ${title}`);
    }
  });
}

module.exports = { start, stop, handleResponse };
