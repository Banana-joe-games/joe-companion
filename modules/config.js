// ── Config & persistent storage for Joe modules ──
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".clippy-claude");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const FOLDER_MAP_FILE = path.join(CONFIG_DIR, "folder-map.json");
const CONTACTS_FILE = path.join(CONFIG_DIR, "contacts.json");
const LOG_FILE = path.join(CONFIG_DIR, "clippy.log");

// Ensure directory exists
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch(e) { return fallback; }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(e) {}
}

// ── Config ──
const DEFAULTS = {
  apiKey: "",
  modules: {
    fileWatcher: true,
    clipboardMonitor: true,
    emailMonitor: true,
    appContext: true,
  },
  projects: [
    { id: "DOOMTILE", name: "DOOMTILE", desc: "tactical arena brawler board game, Kickstarter" },
    { id: "JUJU", name: "JUJU's Castle", desc: "card game fantasy, eroi e Hydra, cartoon" },
    { id: "BOMBSHELL", name: "Bombshell", desc: "post-apocalittico, pin-up gladiator, gacha" },
    { id: "FOLDED_REALMS", name: "Folded Realms", desc: "zine mensile, one-page dungeon, Memento Mori" },
    { id: "NUMERO51", name: "Numero 51", desc: "galleria arte contemporanea Milano, arte asiatica" },
    { id: "SATOSHI", name: "Satoshi", desc: "ceramista giapponese, residenza artistica" },
  ],
  cooldowns: {
    fileWatcher: 120000,
    clipboard: 120000,
    email: 300000,
    appContext: 120000,
  },
};

function getConfig() {
  const saved = readJSON(CONFIG_FILE, {});
  return { ...DEFAULTS, ...saved };
}

function saveConfig(data) {
  const current = getConfig();
  writeJSON(CONFIG_FILE, { ...current, ...data });
}

// ── Folder map ──
function getFolderMap() { return readJSON(FOLDER_MAP_FILE, {}); }
function saveFolderMap(map) { writeJSON(FOLDER_MAP_FILE, map); }

// ── Contacts ──
function getContacts() {
  return readJSON(CONTACTS_FILE, {
    priority: [],
    artists: [],
    galleries: [],
    keywords: ["doomtile", "kickstarter", "juju", "bombshell", "numero 51", "folded realms", "satoshi", "fattura", "invoice", "payment", "collaboration", "partnership", "commission", "artwork", "prototype", "playtest"],
  });
}
function saveContacts(data) { writeJSON(CONTACTS_FILE, data); }

module.exports = {
  CONFIG_DIR, getConfig, saveConfig,
  getFolderMap, saveFolderMap,
  getContacts, saveContacts,
  log,
};
