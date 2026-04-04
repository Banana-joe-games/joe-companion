import Cocoa
import ScreenCaptureKit

// screen-helper: captures the primary screen to a PNG file using ScreenCaptureKit
// Usage: screen-helper <output-path.png>

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: screen-helper <output.png>\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments[1]

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else {
            fputs("ERROR: no display found\n", stderr)
            exitCode = 2
            semaphore.signal()
            return
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width * 2  // retina
        config.height = display.height * 2
        config.showsCursor = false
        config.captureResolution = .best

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: config
        )

        let url = URL(fileURLWithPath: outputPath) as CFURL
        guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else {
            fputs("ERROR: cannot create image file\n", stderr)
            exitCode = 3
            semaphore.signal()
            return
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            fputs("ERROR: cannot write PNG\n", stderr)
            exitCode = 4
            semaphore.signal()
            return
        }

        print("OK")
        exitCode = 0
    } catch {
        fputs("ERROR: \(error.localizedDescription)\n", stderr)
        exitCode = 5
    }
    semaphore.signal()
}

semaphore.wait()
exit(exitCode)
