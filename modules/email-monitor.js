// ── Email Monitor: checks Mail.app via AppleScript ──
const { exec } = require("child_process");
const { callClaude, parseJSON } = require("./claude-api");
const { getConfig, getContacts, saveContacts, log } = require("./config");

let checkInterval = null;
let activityPollInterval = null;
let morningPollInterval = null;
let mainWindow = null;
let cooldownUntil = 0;
let ignoreCount = 0;
let lastCheckedIds = new Set();
let pendingNotifications = []; // queued when user is idle
let morningCheckDone = false; // reset daily, fires once per day
let lastActivityDate = null; // tracks which day we last saw activity

// Our email domains — for filtering unreplied emails sent TO us
const OUR_DOMAINS = ["@numerocinquantuno.com", "@bananajoe.games"];

// Spam sender patterns — skip these entirely
const SPAM_SENDERS = [
  "noreply@", "no-reply@", "newsletter@", "marketing@", "mailer@",
  "notifications@", "digest@", "updates@", "promo@", "info@linkedin",
  "notify@", "donotreply@", "automated@", "support@", "billing@",
];

// Spam subject patterns
const SPAM_SUBJECTS = [
  "unsubscribe", "newsletter", "weekly digest", "daily digest",
  "your order", "shipping confirmation", "delivery notification",
  "password reset", "verify your", "confirm your account",
  "special offer", "limited time", "% off", "free trial",
  "click here", "act now", "don't miss",
];

function start(win) {
  mainWindow = win;
  log("Email Monitor started (morning-only + manual trigger)");

  // Poll for user activity every 30s to deliver queued notifications
  activityPollInterval = setInterval(deliverPendingIfActive, 30000);

  // Morning check: poll every 60s, fires once per day when user starts working
  morningPollInterval = setInterval(checkMorningActivity, 60000);

  // Test Mail.app access on startup
  exec("osascript -e 'tell application \"Mail\" to return \"ok\"'", { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) log("Mail.app access test failed — need permission: " + (stderr || err.message));
    else log("Mail.app access: " + stdout.trim());
  });

  // Fire morning check shortly after startup
  setTimeout(() => checkMorningActivity(), 10000);
}

function stop() {
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
  if (activityPollInterval) { clearInterval(activityPollInterval); activityPollInterval = null; }
  if (morningPollInterval) { clearInterval(morningPollInterval); morningPollInterval = null; }
  log("Email Monitor stopped");
}

// ── Work hours check (7:00 - 22:00) ──
function isWorkHours() {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 22;
}

function checkEmailsIfWorkHours() {
  if (!isWorkHours()) {
    log("Skipping email check — outside work hours");
    return;
  }
  checkEmails();
}

// ── Idle detection via macOS ioreg ──
function getUserIdleSeconds() {
  return new Promise((resolve) => {
    exec("ioreg -c IOHIDSystem | grep HIDIdleTime", { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(9999);
      const match = stdout.match(/= (\d+)/);
      if (!match) return resolve(9999);
      // HIDIdleTime is in nanoseconds
      resolve(parseInt(match[1]) / 1000000000);
    });
  });
}

async function isUserActive() {
  const idle = await getUserIdleSeconds();
  return idle < 300; // active if input in last 5 minutes
}

// ── Queue system: only notify when user is at the computer ──
async function queueNotification(type, data) {
  const active = await isUserActive();
  if (active) {
    sendNotification(type, data);
  } else {
    log(`User idle, queuing ${type} notification`);
    pendingNotifications.push({ type, data, queued: Date.now() });
  }
}

async function deliverPendingIfActive() {
  if (pendingNotifications.length === 0) return;
  const active = await isUserActive();
  if (!active) return;

  // Deliver oldest notification (one at a time)
  const notif = pendingNotifications.shift();
  // Skip if queued more than 6 hours ago
  if (Date.now() - notif.queued > 6 * 60 * 60 * 1000) {
    log(`Dropping stale notification: ${notif.type}`);
    return;
  }
  sendNotification(notif.type, notif.data);
}

function sendNotification(type, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(type, data);
}

// ── Spam detection ──
function isSpam(sender, subject) {
  const senderLower = sender.toLowerCase();
  const subjectLower = subject.toLowerCase();

  for (const pattern of SPAM_SENDERS) {
    if (senderLower.includes(pattern)) return true;
  }
  for (const pattern of SPAM_SUBJECTS) {
    if (subjectLower.includes(pattern)) return true;
  }
  return false;
}

// ── AI classification for ambiguous emails ──
async function classifyWithAI(emails) {
  if (emails.length === 0) return [];

  const emailList = emails.map((e, i) =>
    `${i + 1}. From: ${e.sender} | Subject: ${e.subject}`
  ).join("\n");

  const config = getConfig();
  const projects = config.projects.map(p => `${p.id} (${p.desc})`).join(", ");

  const prompt = `These are emails from an inbox. For each one, classify:
- "real": a real person writing to us about work/projects/business
- "spam": marketing, newsletter, automated, promotional, notification

Our projects: ${projects}

Emails:
${emailList}

Reply ONLY with JSON array: [{"index":1,"type":"real"|"spam","project":"project_id or none","reason":"brief reason"}]`;

  try {
    const response = await callClaude(prompt, { maxTokens: 300 });
    const result = parseJSON(response);
    if (Array.isArray(result)) return result;
    // Sometimes wrapped in an object
    if (result && Array.isArray(result.emails)) return result.emails;
    return [];
  } catch(e) {
    log(`AI email classification error: ${e.message}`);
    return [];
  }
}

// ── Main check: recent unread emails ──
async function checkEmails() {
  const config = getConfig();
  const cooldown = ignoreCount >= 3 ? 600000 : (config.cooldowns?.email || 300000);
  if (Date.now() < cooldownUntil) return;

  const script = `osascript -e '
    try
      tell application "Mail"
        set output to ""
        set recentMessages to (messages of inbox whose date received > (current date) - 7200 and read status is false)
        set counter to 0
        repeat with msg in recentMessages
          if counter >= 15 then exit repeat
          set msgId to id of msg as string
          set senderAddr to sender of msg
          set msgSubject to subject of msg
          set output to output & msgId & "|||" & senderAddr & "|||" & msgSubject & "\\n"
          set counter to counter + 1
        end repeat
        return output
      end tell
    on error
      return "ERROR"
    end try
  '`;

  exec(script, { timeout: 15000 }, async (err, stdout, stderr) => {
    if (err) {
      log("Mail check exec error: " + (stderr || err.message));
      return;
    }
    if (!stdout.trim() || stdout.trim() === "ERROR") {
      if (stdout?.trim() === "ERROR") log("Mail.app not accessible");
      return;
    }

    const emails = stdout.trim().split("\n").filter(l => l.includes("|||")).map(line => {
      const [id, sender, subject] = line.split("|||");
      return { id: id.trim(), sender: sender.trim(), subject: subject.trim() };
    });

    // Filter already seen
    const newEmails = emails.filter(e => !lastCheckedIds.has(e.id));
    if (newEmails.length === 0) return;
    newEmails.forEach(e => lastCheckedIds.add(e.id));

    // Step 1: remove obvious spam locally
    const notObviousSpam = newEmails.filter(e => !isSpam(e.sender, e.subject));
    if (notObviousSpam.length === 0) return;

    // Step 2: check against known contacts/keywords first
    const contacts = getContacts();
    const knownRelevant = [];
    const ambiguous = [];

    for (const email of notObviousSpam) {
      const relevance = checkRelevance(email, contacts);
      if (relevance) {
        knownRelevant.push({ email, relevance });
      } else {
        ambiguous.push(email);
      }
    }

    // Step 3: classify ambiguous ones with AI
    if (ambiguous.length > 0) {
      const classified = await classifyWithAI(ambiguous);
      for (const c of classified) {
        if (c.type === "real") {
          const email = ambiguous[c.index - 1];
          if (email) {
            knownRelevant.push({
              email,
              relevance: { type: "ai", match: c.project || "unknown", reason: c.reason },
            });
          }
        }
      }
    }

    // Step 4: notify (one at a time)
    if (knownRelevant.length > 0) {
      cooldownUntil = Date.now() + cooldown;
      const best = knownRelevant[0];
      const senderName = best.email.sender.replace(/<.*>/, "").trim() || best.email.sender;

      await queueNotification("email-alert", {
        sender: senderName,
        subject: best.email.subject,
        relevanceType: best.relevance.type,
        relevanceMatch: best.relevance.match,
        count: knownRelevant.length,
      });
    }
  });
}

function checkRelevance(email, contacts) {
  const senderLower = email.sender.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  // Check priority contacts
  for (const name of contacts.priority) {
    if (senderLower.includes(name.toLowerCase())) {
      return { type: "priority", match: name };
    }
  }

  // Check artists
  for (const name of contacts.artists) {
    if (senderLower.includes(name.toLowerCase())) {
      return { type: "artist", match: name };
    }
  }

  // Check galleries
  for (const name of contacts.galleries) {
    if (senderLower.includes(name.toLowerCase())) {
      return { type: "gallery", match: name };
    }
  }

  // Check keywords in subject
  for (const kw of contacts.keywords) {
    if (subjectLower.includes(kw.toLowerCase())) {
      return { type: "keyword", match: kw };
    }
  }

  return null;
}

// ── Morning check: unreplied emails from last 7 days sent to our domains ──

async function checkMorningActivity() {
  const today = new Date().toDateString();

  // Reset flag at midnight
  if (lastActivityDate !== today) {
    morningCheckDone = false;
  }

  // Already done today
  if (morningCheckDone) return;

  // Wait for user to start working (active = idle < 2 min, meaning just sat down)
  const idle = await getUserIdleSeconds();
  if (idle > 120) return; // still idle, wait

  // But also make sure they were idle before (just arrived, not mid-work)
  // We detect "morning start" by: it's a new day AND user just became active
  if (lastActivityDate === today) return; // already active today, not a "start"

  lastActivityDate = today;
  morningCheckDone = true;

  log("Morning activity detected, checking unreplied emails");

  // Small delay so Joe has time to load and user settles in
  setTimeout(checkUnrepliedEmails, 15000);
}

function checkUnrepliedEmails() {
  // Use spawn with stdin to avoid quoting issues with osascript
  const path = require("path");
  const scriptPath = path.join(__dirname, "..", "scripts", "check-unreplied.applescript");

  exec(`osascript "${scriptPath}"`, { timeout: 60000 }, async (err, stdout, stderr) => {
    if (err) {
      log("Morning mail check error: " + stderr);
      return;
    }
    if (!stdout.trim() || stdout.trim().startsWith("ERROR")) {
      if (stdout?.trim().startsWith("ERROR")) log("Morning mail check error: " + stdout.trim());
      else log("Morning check: no unreplied emails from Mail.app");
      return;
    }

    const emails = stdout.trim().split("\n").filter(l => l.includes("|||")).map(line => {
      const [sender, subject] = line.split("|||");
      return { sender: sender.trim(), subject: subject.trim() };
    });

    if (emails.length === 0) {
      log("Morning check: no unreplied emails");
      return;
    }

    // Filter out obvious spam
    const real = emails.filter(e => !isSpam(e.sender, e.subject));
    if (real.length === 0) return;

    log(`Morning check: ${real.length} unreplied emails`);

    const summary = real.slice(0, 5).map(e => {
      const name = e.sender.replace(/<.*>/, "").trim();
      return name + ": " + e.subject;
    }).join("\n");

    sendNotification("unreplied-emails", {
      count: real.length,
      emails: real.slice(0, 5),
      summary,
    });
  });
}

// Called from renderer
function handleResponse(action) {
  if (action === "open") {
    exec('open -a "Mail"');
    ignoreCount = 0;
  } else if (action === "ignore") {
    ignoreCount++;
  }
}

// Manual trigger — called from IPC when user asks for it
function manualCheck() {
  log("Manual email check triggered");
  checkEmails();
}

module.exports = { start, stop, handleResponse, manualCheck };
