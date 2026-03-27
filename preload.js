const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  resizeWindow: (width, height) =>
    ipcRenderer.send("resize-window", { width, height }),
  takeScreenshot: () =>
    ipcRenderer.send("take-screenshot"),
  setIgnoreMouse: (ignore) =>
    ipcRenderer.send("set-ignore-mouse", ignore),
  onOpenChatAndPaste: (callback) =>
    ipcRenderer.on("open-chat-and-paste", callback),
  onCalendarReminder: (callback) =>
    ipcRenderer.on("calendar-reminder", (event, data) => callback(data)),
  onQuickChat: (callback) =>
    ipcRenderer.on("quick-chat", callback),
  onActiveContext: (callback) =>
    ipcRenderer.on("active-context", (event, data) => callback(data)),
  onSetUsername: (callback) =>
    ipcRenderer.on("set-username", (event, name) => callback(name)),
  onChangeName: (callback) =>
    ipcRenderer.on("change-name", callback),
  shakeWindow: () =>
    ipcRenderer.send("shake-window"),

  // ── Module events ──
  onFileWatcherLoading: (callback) =>
    ipcRenderer.on("file-watcher-loading", (event, data) => callback(data)),
  onFileWatcherStep: (callback) =>
    ipcRenderer.on("file-watcher-step", (event, data) => callback(data)),
  fileWatcherResponse: (action, data) =>
    ipcRenderer.send("file-watcher-response", action, data),
  openFolderPicker: (filePath, projectId) =>
    ipcRenderer.send("open-folder-picker", filePath, projectId),

  onClipboardSuggestion: (callback) =>
    ipcRenderer.on("clipboard-suggestion", (event, data) => callback(data)),
  clipboardResponse: (action, data) =>
    ipcRenderer.send("clipboard-response", action, data),

  onEmailAlert: (callback) =>
    ipcRenderer.on("email-alert", (event, data) => callback(data)),
  onUnrepliedEmails: (callback) =>
    ipcRenderer.on("unreplied-emails", (event, data) => callback(data)),
  emailResponse: (action) =>
    ipcRenderer.send("email-response", action),
  emailCheckNow: () =>
    ipcRenderer.send("email-check-now"),

  onGmailChecking: (callback) =>
    ipcRenderer.on("gmail-checking", () => callback()),
  onGmailMorningReport: (callback) =>
    ipcRenderer.on("gmail-morning-report", (event, data) => callback(data)),
  onGmailNewImportant: (callback) =>
    ipcRenderer.on("gmail-new-important", (event, data) => callback(data)),
  gmailAuthorize: () =>
    ipcRenderer.send("gmail-authorize"),
  gmailCheckNow: () =>
    ipcRenderer.send("gmail-check-now"),
  gmailOpen: (threadId, account) =>
    ipcRenderer.send("gmail-open", threadId, account),
  gmailOpenAll: (threadIds) =>
    ipcRenderer.send("gmail-open-all", threadIds),
  gmailIgnore: (threadId) =>
    ipcRenderer.send("gmail-ignore", threadId),

  onShowBubble: (callback) =>
    ipcRenderer.on("show-bubble", (event, text) => callback(text)),

  // Screenshot watcher
  onScreenshotDetected: (callback) =>
    ipcRenderer.on("screenshot-detected", (event, data) => callback(data)),
  screenshotCopyDelete: (filePath) =>
    ipcRenderer.send("screenshot-copy-delete", filePath),
  screenshotMove: (filePath) =>
    ipcRenderer.send("screenshot-move", filePath),

  // Joe personality
  requestJoePhrase: (context, app, title) =>
    ipcRenderer.send("joe-phrase-request", context, app, title),
  onJoePhrase: (callback) =>
    ipcRenderer.on("joe-phrase", (event, phrase) => callback(phrase)),

  saveApiKey: (key) =>
    ipcRenderer.send("save-api-key", key),
});
