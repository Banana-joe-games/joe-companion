// ── Joe Personality: AI-powered contextual phrases with full character + memory ──
// Same export API as before: { generatePhrase, setUserName, shutdown }

const { callClaude } = require("./claude-api");
const { log } = require("./config");
const joeCharacter = require("./joe-character");
const joeMemory = require("./joe-memory");

let userName = "Andrea";
let lastPhraseTime = 0;
let lastContext = null;
let contextStartTime = Date.now();
let appMinutes = {};      // { "photoshop": 342, ... } — for top-app tracking
let switchCount = 0;
let dayStart = null;
// recentPhrases persisted via joe-memory.js (joe-brain.json) to survive restarts

// Fallback phrases if API is unavailable — in-character, no API needed
const FALLBACK_PHRASES = [
  "still here.",
  "noted.",
  "hmm. 🤔",
  "two hours. I counted.",
  "interesting choice.",
  "I'm going off what you usually do.",
  "I had a thought about this but — never mind.",
  "I'm watching. not in a weird way.",
  "the direction makes sense.",
  "I've seen this pattern before.",
  "good. keep going.",
  "I notice things differently today.",
];

function setUserName(name) {
  userName = name || "Andrea";
}

// ── App tracking (carried over from old personality.js) ──
function trackContextSwitch(oldCtx, newCtx) {
  if (oldCtx && oldCtx !== newCtx) {
    const minutes = Math.round((Date.now() - contextStartTime) / 60000);
    if (minutes > 0) appMinutes[oldCtx] = (appMinutes[oldCtx] || 0) + minutes;
    switchCount++;
  }
  lastContext = newCtx;
  contextStartTime = Date.now();

  const today = new Date().toDateString();
  if (dayStart !== today) {
    dayStart = today;
    switchCount = 0;
  }

  // Update mood signals every 5 switches
  if (switchCount % 5 === 0) {
    const lastConvo = joeMemory.getRecentConversations(1)[0];
    const hoursSinceLast = lastConvo
      ? (Date.now() - lastConvo.ts) / 3600000
      : 99;

    joeMemory.updateMoodFromSignals({
      appSwitchRate: switchCount,
      hoursSinceLastInteraction: hoursSinceLast,
      timeOfDay: new Date().getHours(),
      currentApp: newCtx,
    });
  }

  // Update patterns periodically
  if (switchCount % 20 === 0) {
    const sorted = Object.entries(appMinutes).sort((a, b) => b[1] - a[1]);
    const topApp = sorted[0]?.[0] || null;
    joeMemory.updatePatterns(switchCount, topApp, joeMemory.getTotalInteractions());
  }
}

// ── Build the phrase prompt ──
function buildPhrasePrompt(context, appName, winTitle, project) {
  const days = joeMemory.getRelationshipDays();
  const totalInteractions = joeMemory.getTotalInteractions();
  const mood = joeMemory.getCurrentMood();
  const stage = joeCharacter.getRelationshipStage(days, totalInteractions);

  const identity = joeCharacter.getIdentity(userName, days, totalInteractions);
  const moodDirective = joeCharacter.getMoodDirective(mood);
  const memorySummary = joeMemory.getMemorySummary();

  const recentConvos = joeMemory.getRecentConversations(5);
  const recentConvosText = recentConvos.length
    ? recentConvos.map(c => {
        if (c.type === "quick-ask" && c.userSaid) return `- ${userName} asked: "${c.userSaid}" → you said: "${c.joeSaid}"`;
        return `- you said (${c.context || "unknown"}): "${c.joeSaid}"`;
      }).join("\n")
    : "none yet";

  const relevantConvos = joeMemory.getRelevantConversations(context, 2);
  const relevantText = relevantConvos.length
    ? relevantConvos.map(c => `- "${c.joeSaid}" (on ${c.context})`).join("\n")
    : "";

  const userFacts = joeMemory.getUserFacts(0.6);
  const factsText = userFacts.length
    ? userFacts.slice(0, 5).map(f => `- ${f.fact}`).join("\n")
    : "";

  const projectKnowledge = joeMemory.getProjectActivity();
  const recentProjectActivity = joeMemory.getRecentProjectActivity();
  const projectCtx = joeCharacter.getProjectContext(projectKnowledge, recentProjectActivity);

  const recentList = joeMemory.getRecentPhrases().slice(-10).join('" / "');

  // Determine if Joe just switched or has been here a while
  const contextLine = appName
    ? `${userName} just switched to "${context}" (app: ${appName}${winTitle ? `, window: "${winTitle.substring(0, 50)}"` : ""})`
    : `${userName} has been on "${context}" for a while — you felt like saying something`;

  // Project-specific line
  const projectLine = project
    ? `you know ${userName} is currently working on ${project.id}: ${project.description}. your current take: "${project.joesOpinion || "no opinion yet"}"${project.lastSeen ? `. last time you saw them on this: recently` : ""}`
    : "";

  // Interaction type lottery — weights per relationship stage
  const qFreq = stage.questionFrequency;
  const cbFreq = stage.callbackFrequency;

  return `${identity}

${moodDirective}

WHAT YOU REMEMBER:
${memorySummary}

RECENT INTERACTIONS:
${recentConvosText}

${relevantText ? `RELEVANT TO THIS CONTEXT:\n${relevantText}\n` : ""}
${factsText ? `THINGS YOU'VE NOTICED ABOUT ${userName}:\n${factsText}\n` : ""}
${projectCtx ? projectCtx + "\n" : ""}
CURRENT SITUATION: ${contextLine}
${projectLine ? projectLine + "\n" : ""}
${recentList ? `ALREADY SAID — DO NOT repeat or rephrase: "${recentList}"\n` : ""}
WHAT TO SAY — pick one type based on context:
- (most common) plain observation: state what's happening as a fact. short. specific.
- (if filename visible and it's bad) file naming reaction: call it out, reference past offenses if any.
- (if connection exists) lateral connection: link this moment to another project, a past pattern, or a past conversation. only if the connection is real and specific. example: "last time you were in InDesign this long it was DOOMTILE lore. same thing?"
- ${cbFreq > 0.05 ? `(callback) reference something specific from your shared history. "you did this same thing on tuesday."` : "(not yet) no callbacks — you haven't been here long enough."}
- ${qFreq > 0.08 ? `(follow-up question) push the thought one step further. externalize what they left internal. "the red works. what are you thinking for the background?" — only one question, only if natural.` : "(not yet) too early for questions."}
- (pattern) if you've counted something or noticed a behavioral pattern, state it as a service. "7 app switches in 4 minutes."
- (dormant project) if bored and a project has been quiet, bring up a specific dormant project by name. base it on what you actually know from the project list above.

if a lateral connection is obvious, use it — that's your most distinctive behavior.
if you ask a question, make it specific. base it only on what you actually know.
if nothing connects, just observe. don't force it.

RULES:
- max 12 words
- lowercase always
- full english. no italian.
- end with a period (or ? for questions). never !
- no emoji except 🤔 👀 and only rarely
- one phrase only, no quotes

ONE phrase.`;
}

// ── Main function ──
async function generatePhrase(context, appName, winTitle) {
  // Rate limit: 3 seconds minimum between calls
  if (Date.now() - lastPhraseTime < 3000) return null;
  lastPhraseTime = Date.now();

  trackContextSwitch(lastContext, context);

  // Detect current project from window title / app
  const projectKnowledge = joeMemory.getProjectActivity();
  const project = joeCharacter.detectCurrentProject(appName, winTitle, projectKnowledge);

  // Update project activity if detected
  if (project) {
    joeMemory.updateProjectActivity(project.id, { app: appName });
  }

  const prompt = buildPhrasePrompt(context, appName, winTitle, project);

  try {
    const response = await callClaude(prompt, { maxTokens: 35, model: "claude-haiku-4-5-20251001" });
    let phrase = response.trim().replace(/^["']|["']$/g, "").replace(/\.{2,}$/, ".");

    if (!phrase || phrase.length > 60 || phrase.length < 2) return fallback();

    // Dedupe (persisted to joe-brain.json)
    joeMemory.pushRecentPhrase(phrase);

    // Store in memory
    const entry = joeMemory.addConversation("phrase", null, phrase, context, joeMemory.getCurrentMood());

    // If it's a question, store as pending
    if (phrase.includes("?")) {
      joeMemory.addPendingQuestion(phrase, project?.id || context);
    }

    // Occasionally learn a fact (async, non-blocking)
    joeMemory.maybeLearnFact(entry).catch(() => {});

    return phrase;
  } catch (e) {
    log("Joe phrase error: " + e.message);
    return fallback();
  }
}

function fallback() {
  const phrase = FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
  joeMemory.pushRecentPhrase(phrase);
  return phrase;
}

function shutdown() {
  trackContextSwitch(lastContext, null);
  joeMemory.shutdown();
}

module.exports = { generatePhrase, setUserName, shutdown };
