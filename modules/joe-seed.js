// ── Joe Seed: initial knowledge for first boot ──
// Runs ONCE when joe-brain.json doesn't exist yet.
// Gives Joe a head start so he doesn't ask "what's JUJU?" on day one.

function getSeedData() {
  return {
    userFacts: [
      { fact: "co-founder of Banana Joe Games with Andrea, Jack, Guido, and Giovanni", confidence: 1.0, learnedFrom: "initial-setup", ts: Date.now() },
      { fact: "runs Numero 51 art gallery in Milan, focuses on East-Asian contemporary art", confidence: 1.0, learnedFrom: "initial-setup", ts: Date.now() },
      { fact: "speaks Italian, English, Japanese, Chinese, Spanish, Korean", confidence: 1.0, learnedFrom: "initial-setup", ts: Date.now() },
      { fact: "hands-on across game design, production, component design, artist coordination", confidence: 1.0, learnedFrom: "initial-setup", ts: Date.now() },
      { fact: "deeply into board games, art, design, travel, food", confidence: 1.0, learnedFrom: "initial-setup", ts: Date.now() },
    ],

    projectKnowledge: {
      DOOMTILE: {
        description: "tactical arena brawler board game, Kickstarter in planning",
        joesOpinion: "the big launch. no pressure or anything.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      JUJU: {
        description: "cooperative dungeon crawler with hex tiles, Fate Die, Hydra boss, 1-4 players",
        joesOpinion: "this one's getting a lot of attention right now. the hydra mechanic is clever.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      BOMBSHELL: {
        description: "post-apocalyptic pin-up gladiator card/arena game with gacha mechanics",
        joesOpinion: "wild concept. I respect the chaos.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      HUNGER_CHAIN: {
        description: "board game in development",
        joesOpinion: "haven't seen much of this one yet. mysterious.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      SOUND_OF_VIOLENCE: {
        description: "board game in development",
        joesOpinion: "the name alone is a statement.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      FOLDED_REALMS: {
        description: "monthly one-page dungeon zine, Memento Mori",
        joesOpinion: "small but consistent. respect the grind.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      NUMERO51: {
        description: "art gallery in Milan, East-Asian contemporary art, residencies, cross-cultural exhibitions",
        joesOpinion: "the gallery world is wild. love watching this side of things.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
      SATOSHI: {
        description: "Japanese ceramicist, artist residency project",
        joesOpinion: "the artisan angle. interesting.",
        frequency: "unknown",
        lastSeen: null,
        recentFiles: [],
        recentApps: [],
        lastMentionedInChat: null,
      },
    },

    callbacks: [],

    patterns: {
      averageWorkStart: null,
      averageWorkEnd: null,
      mostUsedApp: null,
      appSwitchRate: "unknown",
      interactionStyle: "unknown",
    },
  };
}

module.exports = { getSeedData };
