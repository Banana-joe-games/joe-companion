# Joe Companion — Project Context

## Cos'è
App Electron (macOS) che mostra un personaggio flottante "Joe" sempre visibile sul desktop. Joe è giallo banana (#FFD700), ha la personalità di Clippy di Word (awkward, un po' malizioso, in italiano). Si apre con `npm start` dalla cartella `/Users/andreadeotto/Desktop/clippy-v2/`.

## File principali
- `main.js` — processo principale Electron: tray, shortcuts, calendario, IPC handlers, onboarding
- `shell.html` — renderer principale: personaggio Joe SVG, speech bubble, chat AI, walkie-talkie
- `preload.js` — bridge IPC tra main e renderer
- `onboarding.html` — dialog centrato macOS per chiedere il nome al primo avvio
- `modules/file-watcher.js` — monitora ~/Downloads, analizza file con Claude API, propone progetto
- `modules/clipboard-monitor.js` — rileva email, URL, IBAN, telefoni negli appunti
- `modules/email-monitor.js` — controlla Mail.app via AppleScript ogni 5 min
- `modules/app-context-monitor.js` — rileva app attiva e mostra frasi contestuali
- `cal-helper` — binario Swift compilato che legge EventKit senza aprire Calendar.app

## Config e dati
- API key Anthropic: in `~/.clippy-claude/config.json` (chiave: `sk-ant-api03-...`)
- Settings (nome utente, ecc.): `~/Library/Application Support/clippy-claude/joe-settings.json`
- Progetti e cartelle: `~/.clippy-claude/folder-map.json`
- Log: `~/.clippy-claude/clippy.log`

## Modello Claude usato
- File watcher / image recognition: `claude-haiku-4-5`
- Chat AI: claude.ai aperto in webview

## Funzionalità attive
- Speech bubble contestuale per app attiva (Mail, Chrome, VS Code, Spotify, Finder, ecc.)
- Walkie-talkie via Firebase (left-click = AI chat, right-click = walkie)
- Shift+click su Joe = "trillo" (suono MGS-style, notifica all'altro utente)
- Calendario: legge eventi con `cal-helper`, Ctrl+A cicla gli eventi di oggi
- Onboarding al primo avvio (chiede nome), "Change Name" nel menu tray per ripetere
- File watcher: rileva nuovi file in ~/Downloads, mostra subito bubble di loading ("hmm... vediamo 🤔"), poi dopo ~5s propone progetto con Si/No buttons
- Shortcut Ctrl+A: mostra prossimo evento del giorno

## Stack tecnico
- Electron v33.4.11
- electron-builder per DMG
- Firebase Realtime Database (walkie-talkie)
- chokidar per file watching
- Apple Developer ID Application certificate per code signing
- GitHub Actions per build/sign/notarize automatico (repo: Banana-joe-games/joe-companion)

## Stato attuale (fine ultima sessione)
Tutto funziona. L'ultima modifica aggiunta è il loading indicator nel file watcher:
- `file-watcher.js` manda `"file-watcher-loading"` IPC subito quando rileva un file
- `preload.js` espone `onFileWatcherLoading`
- `shell.html` mostra frase di caricamento nella bubble immediatamente, poi `onFileWatcherStep` mostra la proposta progetto

## Prossime cose da fare (backlog)
- Testare il loading indicator del file watcher
- electron-updater per aggiornamenti automatici via GitHub releases
- Fix minori: bubble duplication, cooldown rimosso dal file watcher
- Primo DMG firmato e pubblicato su GitHub releases (Actions workflow già configurato)
