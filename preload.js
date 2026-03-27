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
});
