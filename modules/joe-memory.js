// ── Joe Memory: persistent brain for Joe ──
// Loads/saves ~/.clippy-claude/joe-brain.json
// Seeded on first run from joe-seed.js

const fs = require("fs");
const path = require("path");
const { CONFIG_DIR, log } = require("./config");
const { getSeedData } = require("./joe-seed");
// Claude API removed from memory — all memory ops are local only

const BRAIN_FILE = path.join(CONFIG_DIR, "joe-brain.json");

// Caps to keep file from bloating
const MAX_CONVERSATIONS = 50;
const MAX_USER_FACTS = 30;
const MAX_DAILY_SUMMARIES = 30;
const MAX_PENDING_QUESTIONS = 5;
const MAX_CALLBACKS = 20;
const MAX_MOOD_HISTORY = 10;

// ── Default structure ──
function defaultBrain() {
  const seed = getSeedData();
  return {
    // Relationship
    firstMeet: new Date().toISOString(),
    totalInteractions: 0,

    // Conversation memory
    conversations: [],

    // Learned facts about the user
    userFacts: seed.userFacts,

    // Running jokes / callbacks
    callbacks: seed.callbacks,

    // Mood
    currentMood: "content",
    moodHistory: [],

    // Daily summaries
    dailySummaries: [],

    // Behavioral patterns
    patterns: seed.patterns,

    // Project activity (seeded with known projects)
    projectActivity: seed.projectKnowledge,

    // Pending questions Joe has asked
    pendingQuestions: [],

    // Claude.ai memory sync tracking
    lastMemorySyncTs: null,
  };
}

// ── In-memory state ──
let brain = null;
let saveTimer = null;

// ── Load / Save ──
function load() {
  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const saved = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));
      // Merge seed project knowledge in case new projects were added
      const seed = getSeedData();
      const merged = { ...defaultBrain(), ...saved };
      // Add any new projects from seed that don't exist yet
      for (const [id, p] of Object.entries(seed.projectKnowledge)) {
        if (!merged.projectActivity[id]) merged.projectActivity[id] = p;
      }
      brain = merged;
    } else {
      brain = defaultBrain();
      saveNow();
      log("Joe brain: first boot, seeded with initial knowledge");
    }
  } catch (e) {
    log("Joe brain load error: " + e.message);
    brain = defaultBrain();
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 5000); // debounce: write 5s after last change
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
  const ms = Date.now() - new Date(brain.firstMeet).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function getTotalInteractions() {
  return brain.totalInteractions || 0;
}

function incrementInteractions() {
  brain.totalInteractions = (brain.totalInteractions || 0) + 1;
}

// ── Conversation memory ──
function addConversation(type, userSaid, joeSaid, context, mood) {
  incrementInteractions();

  const entry = {
    ts: Date.now(),
    type,                    // "quick-ask", "phrase", "file-watcher", etc.
    userSaid: userSaid || null,
    joeSaid,
    context: context || null,
    mood: mood || brain.currentMood,
  };

  brain.conversations.push(entry);

  // Cap at MAX_CONVERSATIONS, rotate oldest
  if (brain.conversations.length > MAX_CONVERSATIONS) {
    brain.conversations = brain.conversations.slice(-MAX_CONVERSATIONS);
  }

  scheduleSave();
  return entry;
}

function getRecentConversations(n) {
  return brain.conversations.slice(-(n || 5));
}

// Conversations relevant to a context (app name or project id)
function getRelevantConversations(context, n) {
  if (!context) return getRecentConversations(n || 3);
  const ctx = context.toLowerCase();
  const relevant = brain.conversations.filter(c =>
    (c.context || "").toLowerCase().includes(ctx) ||
    (c.userSaid || "").toLowerCase().includes(ctx) ||
    (c.joeSaid || "").toLowerCase().includes(ctx)
  );
  return relevant.slice(-(n || 3));
}

// Last N quick-ask exchanges from the same session (last 30 min)
function getQuickAskThread() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return brain.conversations
    .filter(c => c.type === "quick-ask" && c.ts > cutoff)
    .slice(-3);
}

// ── User facts ──
function learnFact(fact, source, confidence) {
  // Don't duplicate
  const already = brain.userFacts.find(f =>
    f.fact.toLowerCase() === fact.toLowerCase()
  );
  if (already) {
    already.confidence = Math.min(1.0, (already.confidence || 0.5) + 0.1);
    scheduleSave();
    return;
  }

  brain.userFacts.push({
    fact,
    confidence: confidence || 0.6,
    learnedFrom: source || "observation",
    ts: Date.now(),
  });

  if (brain.userFacts.length > MAX_USER_FACTS) {
    // Drop lowest-confidence facts first
    brain.userFacts.sort((a, b) => b.confidence - a.confidence);
    brain.userFacts = brain.userFacts.slice(0, MAX_USER_FACTS);
  }

  scheduleSave();
}

function getUserFacts(minConfidence) {
  const min = minConfidence || 0;
  return brain.userFacts.filter(f => (f.confidence || 0) >= min);
}

// ── Mood ──
function getCurrentMood() {
  return brain.currentMood || "content";
}

function updateMood(newMood, reason) {
  const valid = ["content", "concerned", "excited", "bored", "proud", "grumpy"];
  if (!valid.includes(newMood)) return;
  if (brain.currentMood === newMood) return;

  brain.moodHistory.push({
    from: brain.currentMood,
    to: newMood,
    reason: reason || "",
    ts: Date.now(),
  });

  if (brain.moodHistory.length > MAX_MOOD_HISTORY) {
    brain.moodHistory = brain.moodHistory.slice(-MAX_MOOD_HISTORY);
  }

  brain.currentMood = newMood;
  scheduleSave();
  log(`Joe mood: ${brain.moodHistory[brain.moodHistory.length - 1].from} → ${newMood} (${reason})`);
}

// Update mood based on behavioral signals
function updateMoodFromSignals(signals) {
  // signals: { appSwitchRate, hoursSinceLastInteraction, timeOfDay, currentApp }
  const hour = signals.timeOfDay !== undefined ? signals.timeOfDay : new Date().getHours();

  if (hour < 8) {
    updateMood("grumpy", "early morning");
    return;
  }
  if ((signals.appSwitchRate || 0) > 15) {
    updateMood("concerned", "frantic app switching");
    return;
  }
  if ((signals.hoursSinceLastInteraction || 0) > 2) {
    updateMood("bored", "ignored for 2+ hours");
    return;
  }

  const app = (signals.currentApp || "").toLowerCase();
  if (app === "figma" || app === "illustrator" || app === "photoshop" || app === "procreate") {
    updateMood("excited", "creative work detected");
    return;
  }
  if (app === "xcode" || app === "unity" || app === "godot") {
    updateMood("excited", "dev/build work detected");
    return;
  }

  // Default back to content if nothing triggered
  if (brain.currentMood === "bored" && (signals.hoursSinceLastInteraction || 0) < 0.5) {
    updateMood("content", "user came back");
  }
}

// ── Daily summary (local, no API) ──
function generateDailySummary(userName) {
  const today = new Date().toDateString();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);

  const todayConvos = brain.conversations.filter(c => c.ts >= cutoff.getTime());
  if (todayConvos.length === 0) return null;

  const existing = brain.dailySummaries.find(s => s.date === today);
  if (existing) return existing.summary;

  // Build simple local summary from conversation types
  const types = {};
  for (const c of todayConvos) {
    types[c.type] = (types[c.type] || 0) + 1;
  }
  const parts = [];
  if (types["quick-ask"]) parts.push(`${types["quick-ask"]} quick-ask`);
  if (types["phrase"]) parts.push(`${types["phrase"]} phrases`);
  if (types["file-watcher"]) parts.push(`${types["file-watcher"]} file events`);
  const summary = `${userName}: ${todayConvos.length} interactions (${parts.join(", ") || "misc"})`;

  const entry = { date: today, summary, ts: Date.now() };
  brain.dailySummaries.push(entry);
  if (brain.dailySummaries.length > MAX_DAILY_SUMMARIES) {
    brain.dailySummaries = brain.dailySummaries.slice(-MAX_DAILY_SUMMARIES);
  }
  scheduleSave();
  return summary;
}

// evolveProjectOpinions removed — was using API credits for no real benefit

// ── Project activity ──
function updateProjectActivity(projectId, { file, app } = {}) {
  if (!brain.projectActivity[projectId]) {
    brain.projectActivity[projectId] = {
      description: "",
      joesOpinion: "",
      frequency: "unknown",
      lastSeen: null,
      recentFiles: [],
      recentApps: [],
      lastMentionedInChat: null,
    };
  }

  const p = brain.projectActivity[projectId];
  p.lastSeen = new Date().toISOString();

  if (file) {
    p.recentFiles = p.recentFiles || [];
    if (!p.recentFiles.includes(file)) p.recentFiles.push(file);
    if (p.recentFiles.length > 10) p.recentFiles = p.recentFiles.slice(-10);
  }

  if (app) {
    p.recentApps = p.recentApps || [];
    if (!p.recentApps.includes(app)) p.recentApps.push(app);
    if (p.recentApps.length > 10) p.recentApps = p.recentApps.slice(-10);
  }

  // Update frequency based on recency pattern
  const lastWeek = brain.conversations.filter(c =>
    c.ts > Date.now() - 7 * 86400000 &&
    (c.context || "").toLowerCase().includes(projectId.toLowerCase())
  ).length;
  if (lastWeek >= 5) p.frequency = "daily";
  else if (lastWeek >= 2) p.frequency = "weekly";
  else if (lastWeek >= 1) p.frequency = "occasional";
  else p.frequency = "dormant";

  scheduleSave();
}

function getProjectActivity() {
  return brain.projectActivity || {};
}

function getRecentProjectActivity() {
  const lines = [];
  const now = Date.now();

  for (const [id, p] of Object.entries(brain.projectActivity || {})) {
    if (!p.lastSeen) continue;
    const days = Math.floor((now - new Date(p.lastSeen).getTime()) / 86400000);
    if (days > 30) continue; // ignore dormant projects

    let line = `- ${id}`;
    if (days === 0) line += ": active today";
    else if (days === 1) line += ": active yesterday";
    else line += `: last active ${days} days ago`;
    if (p.recentFiles?.length) line += `, files: ${p.recentFiles.slice(-2).join(", ")}`;
    if (p.joesOpinion) line += `. joe's take: "${p.joesOpinion}"`;
    lines.push(line);
  }

  return lines;
}

// ── Pending questions ──
function addPendingQuestion(question, context) {
  brain.pendingQuestions = brain.pendingQuestions || [];
  brain.pendingQuestions.push({
    question,
    askedAt: new Date().toISOString(),
    context: context || null,
    answered: false,
  });
  // Keep only recent unanswered ones
  brain.pendingQuestions = brain.pendingQuestions
    .filter(q => !q.answered)
    .slice(-MAX_PENDING_QUESTIONS);
  scheduleSave();
}

function getRecentPendingQuestion() {
  if (!brain.pendingQuestions?.length) return null;
  // Only return if asked within last 2 minutes
  const cutoff = Date.now() - 2 * 60 * 1000;
  const recent = brain.pendingQuestions.find(q =>
    !q.answered && new Date(q.askedAt).getTime() > cutoff
  );
  return recent || null;
}

function markQuestionAnswered(question) {
  if (!brain.pendingQuestions) return;
  const q = brain.pendingQuestions.find(pq => pq.question === question);
  if (q) {
    q.answered = true;
    scheduleSave();
  }
}

// ── Memory summary for prompt injection ──
function getMemorySummary() {
  const parts = [];

  // Relationship duration
  const days = getRelationshipDays();
  parts.push(`you've known ${brain._userName || "them"} for ${days} days (${brain.totalInteractions} total interactions)`);

  // Recent daily summaries (last 3)
  if (brain.dailySummaries?.length) {
    const recent = brain.dailySummaries.slice(-3);
    parts.push("RECENT DAYS:\n" + recent.map(s => `${s.date}: ${s.summary}`).join("\n"));
  }

  // High-confidence user facts
  const facts = getUserFacts(0.7);
  if (facts.length) {
    parts.push("WHAT YOU KNOW ABOUT THEM:\n" + facts.map(f => `- ${f.fact}`).join("\n"));
  }

  // Callbacks
  if (brain.callbacks?.length) {
    const cbs = brain.callbacks.slice(-5);
    parts.push("RUNNING JOKES / CALLBACKS:\n" + cbs.map(c => `- "${c.joke}" (referenced ${c.timesReferenced}x)`).join("\n"));
  }

  // Patterns
  const p = brain.patterns;
  if (p?.mostUsedApp) {
    parts.push(`OBSERVED PATTERNS: mostly uses ${p.mostUsedApp}, app-switch rate: ${p.appSwitchRate}, interaction style: ${p.interactionStyle}`);
  }

  return parts.join("\n\n");
}

// ── Callbacks ──
function addCallback(joke) {
  brain.callbacks = brain.callbacks || [];
  const existing = brain.callbacks.find(c => c.joke === joke);
  if (existing) {
    existing.timesReferenced++;
    existing.lastMention = new Date().toISOString();
  } else {
    brain.callbacks.push({
      joke,
      firstMention: new Date().toISOString(),
      lastMention: new Date().toISOString(),
      timesReferenced: 1,
    });
    if (brain.callbacks.length > MAX_CALLBACKS) {
      brain.callbacks = brain.callbacks.slice(-MAX_CALLBACKS);
    }
  }
  scheduleSave();
}

// ── Patterns ──
function updatePatterns(appSwitchCount, topApp, interactionCount) {
  if (!brain.patterns) brain.patterns = {};

  if (appSwitchCount !== undefined) {
    if (appSwitchCount > 20) brain.patterns.appSwitchRate = "frantic";
    else if (appSwitchCount > 10) brain.patterns.appSwitchRate = "moderate";
    else brain.patterns.appSwitchRate = "low";
  }

  if (topApp) brain.patterns.mostUsedApp = topApp;

  if (interactionCount !== undefined) {
    if (interactionCount > 10) brain.patterns.interactionStyle = "chatty";
    else if (interactionCount > 3) brain.patterns.interactionStyle = "brief";
    else brain.patterns.interactionStyle = "only-when-needed";
  }

  scheduleSave();
}

// maybeLearnFact removed — was using API credits after every Quick Ask

// ── Claude.ai Memory Sync ──
const SYNC_FILE = path.join(CONFIG_DIR, "claude-memory-sync.txt");
const STOP_WORDS = new Set(["a","an","the","in","of","for","is","are","was","were","and","or","to","at","on","with","has","have","had","that","this","from","by","it","its","be","as","do","did","not","but","so","if","my","your","his","her","their","our","i","they","he","she","we","you","about","also","just","very"]);

function fuzzyMatchFact(newFact, existingFacts) {
  const words = (s) => s.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const newWords = words(newFact);
  for (const existing of existingFacts) {
    const exWords = words(existing.fact);
    const common = newWords.filter(w => exWords.includes(w));
    if (common.length >= 3) return existing;
  }
  return null;
}

// syncFromClaudeMemory: reads facts line-by-line from sync file (no API)
function syncFromClaudeMemory() {
  try {
    if (!fs.existsSync(SYNC_FILE)) return { added: 0, updated: 0, skipped: true };

    const stat = fs.statSync(SYNC_FILE);
    const fileMtime = stat.mtimeMs;

    if (brain.lastMemorySyncTs && fileMtime <= brain.lastMemorySyncTs) {
      return { added: 0, updated: 0, skipped: true };
    }

    const text = fs.readFileSync(SYNC_FILE, "utf8").trim();
    if (!text) return { added: 0, updated: 0, skipped: true };

    // Each non-empty line is treated as a fact
    const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    let added = 0;

    for (const line of lines.slice(0, 50)) {
      const existing = fuzzyMatchFact(line, brain.userFacts);
      if (!existing) {
        brain.userFacts.push({
          fact: line,
          confidence: 0.8,
          learnedFrom: "claude-memory-sync",
          ts: Date.now(),
        });
        added++;
      }
    }

    if (brain.userFacts.length > MAX_USER_FACTS) {
      brain.userFacts.sort((a, b) => b.confidence - a.confidence);
      brain.userFacts = brain.userFacts.slice(0, MAX_USER_FACTS);
    }

    brain.lastMemorySyncTs = fileMtime;
    saveNow();
    if (added > 0) log(`Joe memory sync: +${added} new facts (local)`);
    return { added, updated: 0, skipped: false };
  } catch (e) {
    log("Joe memory sync error: " + e.message);
    return { added: 0, updated: 0, skipped: false, error: e.message };
  }
}

// ── Shutdown ──
function shutdown() {
  if (saveTimer) clearTimeout(saveTimer);
  saveNow();
}

// ── Init ──
load();

module.exports = {
  // Relationship
  getRelationshipDays,
  getTotalInteractions,

  // Conversations
  addConversation,
  getRecentConversations,
  getRelevantConversations,
  getQuickAskThread,

  // Facts
  learnFact,
  getUserFacts,

  // Mood
  getCurrentMood,
  updateMood,
  updateMoodFromSignals,

  // Daily
  generateDailySummary,

  // Projects
  updateProjectActivity,
  getProjectActivity,
  getRecentProjectActivity,

  // Pending questions
  addPendingQuestion,
  getRecentPendingQuestion,
  markQuestionAnswered,

  // Summary
  getMemorySummary,

  // Callbacks
  addCallback,

  // Patterns
  updatePatterns,

  // Claude.ai memory sync
  syncFromClaudeMemory,

  // Recent phrases (persisted for dedup across restarts)
  getRecentPhrases() { return brain.recentPhrases || []; },
  pushRecentPhrase(phrase) {
    if (!brain.recentPhrases) brain.recentPhrases = [];
    brain.recentPhrases.push(phrase);
    if (brain.recentPhrases.length > 15) brain.recentPhrases.shift();
    scheduleSave();
  },

  // Persistence
  shutdown,
  saveNow,
};
