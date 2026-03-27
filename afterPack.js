const { execSync } = require("child_process");
const path = require("path");

exports.default = async function(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log("Stripping all xattrs recursively...");

  // Use find + xattr -c (clear ALL xattrs) on every single file and directory
  try {
    execSync(`find "${appPath}" -print0 | xargs -0 xattr -c 2>/dev/null`, { stdio: 'pipe' });
  } catch(e) {
    // some files may fail, that's ok
  }

  // Double check with a targeted approach on the known problem files
  const helpers = [
    "Clippy Claude Helper (GPU)",
    "Clippy Claude Helper (Renderer)",
    "Clippy Claude Helper (Plugin)",
    "Clippy Claude Helper"
  ];

  for (const h of helpers) {
    const dir = h === "Clippy Claude Helper"
      ? `${appPath}/Contents/Frameworks/${h}.app`
      : `${appPath}/Contents/Frameworks/${h}.app`;
    try {
      // Copy file content, remove original, write new file (no inherited xattrs on new inode)
      execSync(`find "${dir}" -type f -print0 | xargs -0 -I{} sh -c 'cat "{}" > "{}.tmp" && rm "{}" && mv "{}.tmp" "{}" && chmod 755 "{}"'`, { stdio: 'pipe' });
      console.log(`Cleaned: ${h}`);
    } catch(e) {
      console.log(`Skip ${h}: ${e.message}`);
    }
  }

  // Also clean main binary and framework
  try {
    execSync(`find "${appPath}/Contents/MacOS" -type f -print0 | xargs -0 -I{} sh -c 'cat "{}" > "{}.tmp" && rm "{}" && mv "{}.tmp" "{}" && chmod 755 "{}"'`, { stdio: 'pipe' });
    execSync(`find "${appPath}/Contents/Frameworks/Electron Framework.framework" -type f -name "Electron Framework" -print0 | xargs -0 -I{} sh -c 'cat "{}" > "{}.tmp" && rm "{}" && mv "{}.tmp" "{}" && chmod 755 "{}"'`, { stdio: 'pipe' });
  } catch(e) {}

  // Verify
  try {
    const result = execSync(`xattr "${appPath}/Contents/Frameworks/Clippy Claude Helper (GPU).app/Contents/MacOS/Clippy Claude Helper (GPU)" 2>&1`).toString().trim();
    console.log("GPU helper xattrs after clean:", result || "(none)");
  } catch(e) {
    console.log("Verify:", e.message);
  }

  console.log("Done — afterPack cleanup complete.");
};
