// ── Joe Memory: local brain + keylog-based knowledge ──
// Brain: ~/.clippy-claude/joe-brain.json (conversations, mood)
// Keylog: ~/.clippy-claude/keylog.jsonl (raw keystrokes from key-helper)
// Knowledge: ~/.clippy-claude/joe-knowledge.txt (compressed memory, built from keylog)

const fs = require("fs");
const path = require("path");
const { CONFIG_DIR, log } = require("./config");
const { callClaude } = require("./claude-api");

const BRAIN_FILE = path.join(CONFIG_DIR, "joe-brain.json");
const KEYLOG_FILE = path.join(CONFIG_DIR, "keylog.jsonl");
const KNOWLEDGE_FILE = path.join(CONFIG_DIR, "joe-knowledge.txt");

const MAX_CONVERSATIONS = 100;
const MAX_PENDING_QUESTIONS = 5;
const MAX_MOOD_HISTORY = 10;
const DIGEST_THRESHOLD = 5000; // compress keylog after this many chars of typed text
const MAX_KNOWLEDGE_LINES = 50; // re-compress knowledge when it exceeds this

// ── Default structure ──
function defaultBrain() {
  return {
    firstMeet: new Date().toISOString(),
    totalInteractions: 0,
    conversations: [],
    currentMood: "content",
    moodHistory: [],
    pendingQuestions: [],
    lastDigestOffset: 0, // byte offset of last processed keylog line
  };
}

let brain = null;
let saveTimer = null;

// ── Load / Save ──
function load() {
  try {
    if (fs.existsSync(BRAIN_FILE)) {
      brain = { ...defaultBrain(), ...JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8")) };
    } else {
      brain = defaultBrain();
      saveNow();
      log("Joe brain: fresh start");
    }
  } catch (e) {
    log("Joe brain load error: " + e.message);
    brain = defaultBrain();
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 5000);
}

function saveNow() {
  try {
    fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
  } catch (e) {
    log("Joe brain save error: " + e.message);
  }
}

// ── Relationship ──
function getRelationshipDays() {
  if (!brain.firstMeet) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(brain.firstMeet).getTime()) / 86400000));
}

function getTotalInteractions() {
  return brain.totalInteractions || 0;
}

// ── Conversations ──
function addConversation(type, userSaid, joeSaid, context, mood) {
  brain.totalInteractions = (brain.totalInteractions || 0) + 1;

  const entry = {
    ts: Date.now(),
    type,
    userSaid: userSaid || null,
    joeSaid,
    context: context || null,
    mood: mood || brain.currentMood,
  };

  brain.conversations.push(entry);
  if (brain.conversations.length > MAX_CONVERSATIONS) {
    brain.conversations = brain.conversations.slice(-MAX_CONVERSATIONS);
  }

  scheduleSave();
  return entry;
}

function getRecentConversations(n) {
  return brain.conversations.slice(-(n || 5));
}

function getRelevantConversations(context, n) {
  if (!context) return getRecentConversations(n || 3);
  const ctx = context.toLowerCase();
  return brain.conversations.filter(c =>
    (c.context || "").toLowerCase().includes(ctx) ||
    (c.userSaid || "").toLowerCase().includes(ctx) ||
    (c.joeSaid || "").toLowerCase().includes(ctx)
  ).slice(-(n || 3));
}

function getQuickAskThread() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return brain.conversations
    .filter(c => c.type === "quick-ask" && c.ts > cutoff)
    .slice(-3);
}

// ── Mood ──
function getCurrentMood() {
  return brain.currentMood || "content";
}

function updateMood(newMood, reason) {
  const valid = ["content", "concerned", "excited", "bored", "proud", "grumpy"];
  if (!valid.includes(newMood) || brain.currentMood === newMood) return;

  brain.moodHistory.push({ from: brain.currentMood, to: newMood, reason: reason || "", ts: Date.now() });
  if (brain.moodHistory.length > MAX_MOOD_HISTORY) {
    brain.moodHistory = brain.moodHistory.slice(-MAX_MOOD_HISTORY);
  }

  brain.currentMood = newMood;
  scheduleSave();
  log(`Joe mood: ${brain.moodHistory[brain.moodHistory.length - 1].from} → ${newMood} (${reason})`);
}

function updateMoodFromSignals(signals) {
  const hour = signals.timeOfDay !== undefined ? signals.timeOfDay : new Date().getHours();

  if (hour < 8) { updateMood("grumpy", "early morning"); return; }
  if ((signals.appSwitchRate || 0) > 15) { updateMood("concerned", "frantic app switching"); return; }
  if ((signals.hoursSinceLastInteraction || 0) > 2) { updateMood("bored", "ignored for 2+ hours"); return; }

  const app = (signals.currentApp || "").toLowerCase();
  if (["figma", "illustrator", "photoshop", "procreate"].includes(app)) { updateMood("excited", "creative work"); return; }
  if (["xcode", "unity", "godot"].includes(app)) { updateMood("excited", "dev work"); return; }

  if (brain.currentMood === "bored" && (signals.hoursSinceLastInteraction || 0) < 0.5) {
    updateMood("content", "user came back");
  }
}

// ── Pending questions ──
function addPendingQuestion(question, context) {
  brain.pendingQuestions = brain.pendingQuestions || [];
  brain.pendingQuestions.push({ question, askedAt: new Date().toISOString(), context: context || null, answered: false });
  brain.pendingQuestions = brain.pendingQuestions.filter(q => !q.answered).slice(-MAX_PENDING_QUESTIONS);
  scheduleSave();
}

function getRecentPendingQuestion() {
  if (!brain.pendingQuestions?.length) return null;
  const cutoff = Date.now() - 2 * 60 * 1000;
  return brain.pendingQuestions.find(q => !q.answered && new Date(q.askedAt).getTime() > cutoff) || null;
}

function markQuestionAnswered(question) {
  const q = (brain.pendingQuestions || []).find(pq => pq.question === question);
  if (q) { q.answered = true; scheduleSave(); }
}

// ── Keylog: read unprocessed entries ──
function getUnprocessedKeylog() {
  try {
    if (!fs.existsSync(KEYLOG_FILE)) return { entries: [], totalChars: 0, lineCount: 0 };
    const content = fs.readFileSync(KEYLOG_FILE, "utf8");
    const allLines = content.trim().split("\n").filter(Boolean);
    const startLine = brain.lastDigestOffset || 0;
    const newLines = allLines.slice(startLine);

    let totalChars = 0;
    const entries = [];
    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
        totalChars += (entry.text || "").length;
      } catch(e) {}
    }
    return { entries, totalChars, lineCount: allLines.length };
  } catch(e) {
    return { entries: [], totalChars: 0, lineCount: 0 };
  }
}

// ── Knowledge: read current knowledge ──
function getKnowledge() {
  try {
    if (!fs.existsSync(KNOWLEDGE_FILE)) return "";
    return fs.readFileSync(KNOWLEDGE_FILE, "utf8").trim();
  } catch(e) {
    return "";
  }
}

// ── Digest: compress keylog into knowledge (called periodically) ──
async function digestKeylog() {
  const { entries, totalChars, lineCount } = getUnprocessedKeylog();
  if (totalChars < DIGEST_THRESHOLD) return { digested: false, chars: totalChars };

  // Group by app for cleaner input
  const byApp = {};
  for (const e of entries) {
    const app = e.app || "unknown";
    if (!byApp[app]) byApp[app] = [];
    byApp[app].push(e.text);
  }

  const rawText = Object.entries(byApp)
    .map(([app, texts]) => `[${app}]: ${texts.join(" ")}`)
    .join("\n")
    .substring(0, 8000);

  const existingKnowledge = getKnowledge();

  const prompt = `You are Joe's memory processor. You observe what the user types across their apps and extract what's worth remembering long-term.

${existingKnowledge ? `WHAT YOU ALREADY KNOW:\n${existingKnowledge}\n` : ""}
NEW RAW ACTIVITY:
${rawText}

Rules:
- Extract only things worth remembering: projects, people, topics, tools, habits, interests, decisions
- Skip noise: typos, random keystrokes, passwords, navigation, meaningless fragments
- Write short factual lines, one per insight. No fluff.
- If something updates or contradicts what you already know, write the updated version
- If nothing new or meaningful, respond with just: NOTHING_NEW
- Max 10 new lines
- No markdown, no bullet points, just plain lines`;

  try {
    const result = await callClaude(prompt, { maxTokens: 400, model: "claude-haiku-4-5-20251001" });

    if (result.trim() === "NOTHING_NEW") {
      brain.lastDigestOffset = lineCount;
      scheduleSave();
      log("Joe digest: nothing new");
      return { digested: true, added: 0 };
    }

    const newLines = result.trim().split("\n").filter(l => l.trim());
    if (newLines.length > 0) {
      const timestamp = new Date().toISOString().split("T")[0];
      const block = newLines.map(l => `[${timestamp}] ${l.trim()}`).join("\n");
      fs.appendFileSync(KNOWLEDGE_FILE, (existingKnowledge ? "\n" : "") + block + "\n");
      log(`Joe digest: +${newLines.length} knowledge lines`);
    }

    brain.lastDigestOffset = lineCount;
    scheduleSave();

    // Check if knowledge needs re-compression
    await maybeCompressKnowledge();

    return { digested: true, added: newLines.length };
  } catch(e) {
    log("Joe digest error: " + e.message);
    return { digested: false, error: e.message };
  }
}

// ── Re-compress knowledge when it gets too long ──
async function maybeCompressKnowledge() {
  const knowledge = getKnowledge();
  const lines = knowledge.split("\n").filter(l => l.trim());
  if (lines.length <= MAX_KNOWLEDGE_LINES) return;

  const prompt = `You are Joe's memory compressor. Merge and condense these knowledge lines into a tighter summary.
Keep the most important and recent information. Remove duplicates and outdated entries.
Output max 25 lines, plain text, no markdown. Keep the [date] prefixes.

${knowledge}`;

  try {
    const result = await callClaude(prompt, { maxTokens: 800, model: "claude-haiku-4-5-20251001" });
    fs.writeFileSync(KNOWLEDGE_FILE, result.trim() + "\n");
    log(`Joe knowledge compressed: ${lines.length} → ${result.trim().split("\n").length} lines`);
  } catch(e) {
    log("Joe knowledge compress error: " + e.message);
  }
}

// ── Memory summary for prompts ──
function getMemorySummary() {
  const parts = [];
  const days = getRelationshipDays();
  parts.push(`you've known them for ${days} days (${brain.totalInteractions} interactions)`);

  const knowledge = getKnowledge();
  if (knowledge) {
    parts.push("WHAT YOU KNOW ABOUT THEM (from observing their work over time):\n" + knowledge);
  }

  return parts.join("\n\n");
}

// ── Shutdown ──
function shutdown() {
  if (saveTimer) clearTimeout(saveTimer);
  saveNow();
}

// ── Init ──
load();

module.exports = {
  getRelationshipDays,
  getTotalInteractions,

  addConversation,
  getRecentConversations,
  getRelevantConversations,
  getQuickAskThread,

  getCurrentMood,
  updateMood,
  updateMoodFromSignals,

  addPendingQuestion,
  getRecentPendingQuestion,
  markQuestionAnswered,

  getKnowledge,
  getMemorySummary,
  digestKeylog,

  // Compatibility stubs
  learnFact() {},
  getUserFacts() { return []; },
  generateDailySummary() { return null; },
  syncFromClaudeMemory() { return { added: 0, updated: 0, skipped: true }; },
  updateProjectActivity() {},
  getProjectActivity() { return {}; },
  getRecentProjectActivity() { return []; },
  addCallback() {},
  updatePatterns() {},
  getRecentPhrases() { return brain.recentPhrases || []; },
  pushRecentPhrase(phrase) {
    if (!brain.recentPhrases) brain.recentPhrases = [];
    brain.recentPhrases.push(phrase);
    if (brain.recentPhrases.length > 15) brain.recentPhrases.shift();
    scheduleSave();
  },

  shutdown,
  saveNow,
};
