# Joe — Desktop Companion

A floating desktop companion for macOS. Joe is a banana-yellow character that lives on your screen, reacts to what you're doing, and gives you access to Claude AI chat.

## Features

- **Floating character** with eye tracking and mood expressions
- **Claude AI chat** — click Joe to open, click X to close
- **Context-aware comments** — Joe reacts when you switch apps (Mail, Chrome, VS Code, Slack, etc.)
- **Walkie Talkie** — real-time messaging with friends via Firebase (right-click Joe)
- **Secret trillo** — Shift+click Joe to send a nudge
- **Calendar events** — press Ctrl+A to cycle through today's upcoming events
- **Screenshot** — Cmd+Shift+S takes a screenshot and pastes it into Claude chat
- **Quick incognito chat** — Ctrl+Q opens a temporary chat window
- **Show/Hide** — Cmd+Shift+C toggles Joe's visibility

## Setup

```bash
git clone https://github.com/Banana-joe-games/joe-companion.git
cd joe-companion
npm install
```

## Run (dev)

```bash
npx electron .
```

Joe will ask your name on first launch.

## Build the app

```bash
npx electron-builder --mac --dir
```

The built app will be in `dist/mac-arm64/Clippy Claude.app`. Copy it to `/Applications/` to install.

## Customize

The project is simple — three main files:

| File | What it does |
|------|-------------|
| `main.js` | Main process: window, tray menu, shortcuts, calendar, screenshot |
| `shell.html` | UI: character, chat, walkie talkie, phrases, expressions |
| `preload.js` | IPC bridge between main and renderer |
| `onboarding.html` | First-launch name setup dialog |
| `firebase-config.js` | Firebase config for walkie talkie |

### Change Joe's phrases

In `shell.html`, find the `contextPhrases` object. Each app has an array of phrases. Add, remove, or change them.

### Change Joe's appearance

In `shell.html`, find the SVG character section. Joe is drawn with basic shapes — circles for eyes, paths for mouth. Colors are `#FFD700` (banana yellow) and `#CC9900` (darker shade).

### Change keyboard shortcuts

In `main.js`, look for `globalShortcut.register(...)` calls.

### Walkie Talkie

Uses Firebase Realtime Database. The config is in `firebase-config.js`. To use your own Firebase:

1. Create a project at https://console.firebase.google.com
2. Enable Realtime Database
3. Replace the config in `firebase-config.js`

## Requirements

- macOS
- Node.js 18+
- Calendar access permission (macOS will ask on first use)
