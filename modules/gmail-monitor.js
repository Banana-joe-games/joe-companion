// ── Gmail Monitor: OAuth-based Gmail checking for unreplied emails ──
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { exec } = require("child_process");
const { callClaude, parseJSON } = require("./claude-api");
const { CONFIG_DIR, log } = require("./config");

const TOKENS_FILE = path.join(CONFIG_DIR, "gmail-tokens.json");
const OAUTH_FILE = path.join(CONFIG_DIR, "gmail-oauth.json");
const IGNORED_FILE = path.join(CONFIG_DIR, "gmail-ignored.json");
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const MORNING_QUERY = "to:bananajoe.games OR to:numerocinquantuno.com newer_than:7d -category:promotions -category:social -category:forums -category:updates -from:noreply -from:no-reply -from:notify -from:notifications -from:mailer-daemon";
const PERIODIC_QUERY = "to:bananajoe.games OR to:numerocinquantuno.com newer_than:2h -category:promotions -category:social -category:forums -category:updates -from:noreply -from:no-reply -from:notify -from:notifications -from:mailer-daemon";

let mainWindow = null;
let periodicInterval = null;
let morningPollInterval = null;
let morningCheckDone = false;
let lastActivityDate = null;
let wasIdle = false; // tracks whether user was idle before becoming active
let oauthServer = null;

// ── Ignored threads storage ──

function loadIgnored() {
  try { return JSON.parse(fs.readFileSync(IGNORED_FILE, "utf8")); }
  catch(e) { return []; }
}

function saveIgnored(list) {
  fs.writeFileSync(IGNORED_FILE, JSON.stringify(list, null, 2));
}

function ignoreThread(threadId) {
  var list = loadIgnored();
  if (!list.includes(threadId)) {
    list.push(threadId);
    saveIgnored(list);
    log("Gmail: ignored thread " + threadId);
  }
}

function filterIgnored(emails) {
  var ignored = loadIgnored();
  return emails.filter(function(e) { return !ignored.includes(e.threadId); });
}

// ── Token storage (supports multiple accounts) ──

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); }
  catch(e) { return []; }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function loadOAuthCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(OAUTH_FILE, "utf8"));
    // Support both flat format and Google's "installed" wrapper
    if (raw.installed) return raw.installed;
    if (raw.web) return raw.web;
    return raw;
  } catch(e) { return null; }
}

// ── OAuth flow ──

function authorize() {
  return new Promise((resolve, reject) => {
    const creds = loadOAuthCredentials();
    if (!creds || !creds.client_id || !creds.client_secret) {
      log("Gmail: no OAuth credentials found in " + OAUTH_FILE);
      return reject(new Error("Missing Gmail OAuth credentials. Place them in " + OAUTH_FILE));
    }

    const redirectUri = "http://localhost:3000/callback";
    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" +
      "client_id=" + encodeURIComponent(creds.client_id) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&response_type=code" +
      "&scope=" + encodeURIComponent(SCOPES.join(" ")) +
      "&access_type=offline" +
      "&prompt=consent";

    // Start local server to receive the callback
    if (oauthServer) {
      try { oauthServer.close(); } catch(e) {}
    }

    oauthServer = http.createServer((req, res) => {
      if (!req.url.startsWith("/callback")) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const url = new URL(req.url, "http://localhost:3000");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error || !code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='font-family:monospace;text-align:center;padding:60px;color:#888;background:#111;'><h2>authorization failed</h2><p>you can close this tab.</p></body></html>");
        oauthServer.close();
        oauthServer = null;
        return reject(new Error("OAuth denied: " + (error || "no code")));
      }

      // Exchange code for tokens
      exchangeCode(code, creds, redirectUri).then((tokenData) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='font-family:monospace;text-align:center;padding:60px;color:#4ade80;background:#111;'><h2>connected!</h2><p>you can close this tab and go back to Joe.</p></body></html>");
        oauthServer.close();
        oauthServer = null;

        // Save token (add to array, avoid duplicates by email)
        const tokens = loadTokens();
        const existing = tokens.findIndex(t => t.email === tokenData.email);
        if (existing >= 0) {
          tokens[existing] = tokenData;
        } else {
          tokens.push(tokenData);
        }
        saveTokens(tokens);
        log("Gmail: authorized account " + tokenData.email);
        resolve(tokenData);
      }).catch((err) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='font-family:monospace;text-align:center;padding:60px;color:#f87171;background:#111;'><h2>token exchange failed</h2><p>" + err.message + "</p></body></html>");
        oauthServer.close();
        oauthServer = null;
        reject(err);
      });
    });

    oauthServer.listen(3000, () => {
      log("Gmail: OAuth server listening on localhost:3000");
      exec('open "' + authUrl + '"');
    });

    oauthServer.on("error", (err) => {
      log("Gmail: OAuth server error: " + err.message);
      reject(err);
    });
  });
}

function exchangeCode(code, creds, redirectUri) {
  return new Promise((resolve, reject) => {
    const body = "code=" + encodeURIComponent(code) +
      "&client_id=" + encodeURIComponent(creds.client_id) +
      "&client_secret=" + encodeURIComponent(creds.client_secret) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&grant_type=authorization_code";

    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error_description || json.error));
          if (!json.refresh_token) return reject(new Error("No refresh token received. Try revoking access and re-authorizing."));

          // Get user email
          getEmailForToken(json.access_token).then((email) => {
            resolve({
              email,
              access_token: json.access_token,
              refresh_token: json.refresh_token,
              expires_at: Date.now() + (json.expires_in * 1000),
            });
          }).catch(() => {
            resolve({
              email: "unknown",
              access_token: json.access_token,
              refresh_token: json.refresh_token,
              expires_at: Date.now() + (json.expires_in * 1000),
            });
          });
        } catch(e) {
          reject(new Error("Token parse error: " + e.message));
        }
      });
    });
    req.on("error", (e) => reject(e));
    req.write(body);
    req.end();
  });
}

function getEmailForToken(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/gmail/v1/users/me/profile",
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json.emailAddress || "unknown");
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Token refresh ──

function refreshAccessToken(tokenEntry) {
  return new Promise((resolve, reject) => {
    const creds = loadOAuthCredentials();
    if (!creds) return reject(new Error("No OAuth credentials"));

    const body = "refresh_token=" + encodeURIComponent(tokenEntry.refresh_token) +
      "&client_id=" + encodeURIComponent(creds.client_id) +
      "&client_secret=" + encodeURIComponent(creds.client_secret) +
      "&grant_type=refresh_token";

    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error_description || json.error));
          tokenEntry.access_token = json.access_token;
          tokenEntry.expires_at = Date.now() + (json.expires_in * 1000);
          // Persist updated token
          const tokens = loadTokens();
          const idx = tokens.findIndex(t => t.email === tokenEntry.email);
          if (idx >= 0) {
            tokens[idx] = tokenEntry;
            saveTokens(tokens);
          }
          resolve(tokenEntry);
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getValidToken(tokenEntry) {
  // Refresh if expiring in less than 2 minutes
  if (!tokenEntry.access_token || Date.now() > (tokenEntry.expires_at - 120000)) {
    return await refreshAccessToken(tokenEntry);
  }
  return tokenEntry;
}

// ── Gmail API calls ──

function gmailGet(accessToken, endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/gmail/v1/users/me/" + endpoint,
      method: "GET",
      headers: { Authorization: "Bearer " + accessToken },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message || JSON.stringify(json.error)));
          resolve(json);
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function searchEmails(accessToken, query) {
  const encoded = encodeURIComponent(query);
  const result = await gmailGet(accessToken, "messages?q=" + encoded + "&maxResults=30");
  return result.messages || [];
}

async function getMessageHeaders(accessToken, messageId) {
  const msg = await gmailGet(accessToken, "messages/" + messageId + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date");
  const headers = msg.payload?.headers || [];
  const from = (headers.find(h => h.name === "From") || {}).value || "";
  const subject = (headers.find(h => h.name === "Subject") || {}).value || "";
  const date = (headers.find(h => h.name === "Date") || {}).value || "";
  return { from, subject, date, threadId: msg.threadId || messageId };
}

// ── Check if email has been replied to ──

async function isUnreplied(accessToken, threadId) {
  try {
    const thread = await gmailGet(accessToken, "threads/" + threadId + "?format=metadata&metadataHeaders=From");
    const messages = thread.messages || [];
    if (messages.length <= 1) return true; // single message = unreplied

    // Check if the LAST message in the thread was sent by us
    // If we sent the last message, we already replied — thread is handled
    // If someone else sent the last message, we haven't replied yet
    const lastMsg = messages[messages.length - 1];
    const lastLabels = lastMsg.labelIds || [];
    if (lastLabels.includes("SENT")) return false;
    return true;
  } catch(e) {
    // If we can't check, assume unreplied
    return true;
  }
}

// ── Spam filter (local, no AI) ──

const SPAM_SENDERS = [
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply",
  "newsletter@", "marketing@", "mailer-daemon@",
  "notifications@", "notification@", "notify@",
  "updates@", "support@", "auto-confirm@",
  "news@", "promo@", "digest@", "alert@", "alerts@",
  "feedback@", "team@", "hello@",
];
// Known automated sender brands/services
const SPAM_BRANDS = [
  "anthropic", "google", "github", "trello", "slack", "notion",
  "figma", "stripe", "paypal", "amazon", "apple", "microsoft",
  "dropbox", "zoom", "calendly", "mailchimp", "hubspot",
  "asana", "jira", "atlassian", "heroku", "vercel", "netlify",
  "firebase", "cloudflare", "godaddy", "squarespace", "shopify",
  "gemini", "openai", "canva", "adobe", "spotify", "linkedin",
  "facebook", "instagram", "twitter", "tiktok", "pinterest",
  "the board game", "boardgamegeek",
];
const SPAM_SUBJECTS = [
  "unsubscribe", "your order", "shipping confirmation", "tracking number",
  "password reset", "verify your", "confirm your", "activate your",
  "welcome to", "your receipt", "invoice #", "payment received",
  "security alert", "sign-in", "log in", "logging in", "secure link",
  "new activity", "new comment", "mentioned you", "assigned to you",
  "invitation to", "has been shared", "action required",
];

function isAutomated(email) {
  const from = (email.from || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const fromEmail = from.match(/<([^>]+)>/) ? from.match(/<([^>]+)>/)[1] : from;
  const fromName = from.replace(/<.*>/, "").trim();

  // Blacklisted sender patterns
  for (const s of SPAM_SENDERS) {
    if (fromEmail.includes(s)) return true;
  }
  // Known automated brands (check sender name and email domain)
  for (const b of SPAM_BRANDS) {
    if (fromName === b || fromEmail.includes("@" + b + ".") || fromEmail.includes("." + b + ".")) return true;
  }
  // Blacklisted subjects
  for (const s of SPAM_SUBJECTS) {
    if (subject.includes(s)) return true;
  }
  return false;
}

// ── Idle detection ──

function getUserIdleSeconds() {
  return new Promise((resolve) => {
    exec("ioreg -c IOHIDSystem | grep HIDIdleTime", { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(9999);
      const match = stdout.match(/= (\d+)/);
      if (!match) return resolve(9999);
      resolve(parseInt(match[1]) / 1000000000);
    });
  });
}

// ── Work hours check ──

function isWorkHours() {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 22;
}

// ── Morning check logic ──

async function checkMorningActivity() {
  const today = new Date().toDateString();

  // Reset flag at midnight
  if (lastActivityDate !== today) {
    morningCheckDone = false;
    wasIdle = false;
  }

  if (morningCheckDone) return;

  const idle = await getUserIdleSeconds();

  // Track if user was idle (> 30 min)
  if (idle > 1800) {
    wasIdle = true;
    return;
  }

  // User is now active (idle < 2 min) and was idle before
  if (idle < 120 && wasIdle) {
    lastActivityDate = today;
    morningCheckDone = true;
    wasIdle = false;

    log("Gmail: morning activity detected, checking unreplied emails");
    setTimeout(() => runMorningCheck(), 15000);
  }

  // First check of the day (app just launched, user already active)
  if (idle < 120 && lastActivityDate !== today && !wasIdle) {
    lastActivityDate = today;
    morningCheckDone = true;

    log("Gmail: first check of the day");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gmail-checking");
    }
    setTimeout(() => runMorningCheck(), 15000);
  }
}

async function runMorningCheck() {
  try {
    const tokens = loadTokens();
    if (tokens.length === 0) {
      log("Gmail: no authorized accounts, skipping morning check");
      return;
    }

    const allEmails = [];

    for (const tokenEntry of tokens) {
      try {
        const token = await getValidToken(tokenEntry);
        const messages = await searchEmails(token.access_token, MORNING_QUERY);

        for (const msg of messages.slice(0, 20)) {
          try {
            const unreplied = await isUnreplied(token.access_token, msg.threadId || msg.id);
            if (!unreplied) continue;

            const headers = await getMessageHeaders(token.access_token, msg.id);
            headers.account = tokenEntry.email || "";
            allEmails.push(headers);
          } catch(e) {
            log("Gmail: error checking message " + msg.id + ": " + e.message);
          }
        }
      } catch(e) {
        log("Gmail: error with account " + tokenEntry.email + ": " + e.message);
      }
    }

    if (allEmails.length === 0) {
      log("Gmail: morning check - no unreplied emails");
      return;
    }

    // Filter out automated/spam emails (local blacklist, no AI)
    const realEmails = allEmails.filter(e => !isAutomated(e));
    log("Gmail: morning report - " + realEmails.length + " real, " + (allEmails.length - realEmails.length) + " automated filtered out");

    // Filter out ignored threads
    var filtered = filterIgnored(realEmails);
    if (filtered.length > 0) {
      log("Gmail: morning report - " + filtered.length + " real unreplied emails (" + (realEmails.length - filtered.length) + " ignored)");
      sendToRenderer("gmail-morning-report", filtered.slice(0, 20));
    } else {
      log("Gmail: morning report - all emails ignored or none found");
    }
  } catch(e) {
    log("Gmail: morning check error: " + e.message);
  }
}

// ── Periodic check (every 2 hours) ──

async function runPeriodicCheck() {
  if (!isWorkHours()) return;

  const idle = await getUserIdleSeconds();
  if (idle > 300) return; // only when user is active (idle < 5 min)

  try {
    const tokens = loadTokens();
    if (tokens.length === 0) return;

    const allEmails = [];

    for (const tokenEntry of tokens) {
      try {
        const token = await getValidToken(tokenEntry);
        const messages = await searchEmails(token.access_token, PERIODIC_QUERY);

        for (const msg of messages.slice(0, 15)) {
          try {
            const headers = await getMessageHeaders(token.access_token, msg.id);
            headers.account = tokenEntry.email || "";
            allEmails.push(headers);
          } catch(e) {
            log("Gmail: error fetching message: " + e.message);
          }
        }
      } catch(e) {
        log("Gmail: periodic check error for " + tokenEntry.email + ": " + e.message);
      }
    }

    if (allEmails.length === 0) return;

    // Filter automated (local blacklist)
    const realEmails = allEmails.filter(e => !isAutomated(e));

    var filteredPeriodic = filterIgnored(realEmails);
    if (filteredPeriodic.length > 0) {
      log("Gmail: periodic check - " + filteredPeriodic.length + " new important emails");
      sendToRenderer("gmail-new-important", filteredPeriodic.slice(0, 5));
    }
  } catch(e) {
    log("Gmail: periodic check error: " + e.message);
  }
}

// ── Renderer communication ──

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Public API ──

function start(win) {
  mainWindow = win;
  log("Gmail Monitor started");

  // Auto-authorize if no tokens exist
  const tokens = loadTokens();
  if (tokens.length === 0) {
    log("Gmail: no accounts authorized, starting OAuth flow...");
    authorize().then(() => {
      log("Gmail: first account authorized successfully");
    }).catch(err => {
      log("Gmail: auto-authorize failed: " + err.message);
    });
  }

  // Morning check: poll every 60s
  morningPollInterval = setInterval(() => checkMorningActivity(), 60000);
  // Fire shortly after startup
  setTimeout(() => checkMorningActivity(), 10000);

  // Periodic check disabled — only morning check + manual "Check Gmail" from tray
}

function stop() {
  if (periodicInterval) { clearInterval(periodicInterval); periodicInterval = null; }
  if (morningPollInterval) { clearInterval(morningPollInterval); morningPollInterval = null; }
  if (oauthServer) { try { oauthServer.close(); } catch(e) {} oauthServer = null; }
  log("Gmail Monitor stopped");
}

module.exports = { start, stop, authorize, runMorningCheck, runPeriodicCheck, ignoreThread };
