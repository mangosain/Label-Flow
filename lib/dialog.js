"use strict";
/**
 * Native OS folder picker, opened SERVER-side. Works because the admin UI is
 * loopback-only: whoever clicks the button is sitting at this machine, so
 * the dialog appears on their own screen. Windows Explorer dialog / macOS
 * Finder chooser / zenity or kdialog on Linux.
 */

const { execFile } = require("node:child_process");
const os = require("node:os");

const TIMEOUT = 5 * 60 * 1000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        notFound: Boolean(err && err.code === "ENOENT"),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

// Prefixes the one line of output we actually care about, so a stray banner,
// profile-script echo, or PSReadLine warning on stdout can never be mistaken
// for the chosen path (we only trust a line that starts with this marker).
const WIN_MARKER = "LABELER_PICKED_FOLDER::";

const winScript = (title) => `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Width = 0; Height = 0 }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${String(title).replace(/'/g, "''")}'
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine('${WIN_MARKER}' + $d.SelectedPath) }
`.trim();

// A bare `choose folder` (no enclosing `tell application X`) belongs to
// whatever process context is running this script -- osascript itself has
// no Dock presence or frontmost status, so without this the dialog can open
// BEHIND every other window (browser included) instead of on top of them.
// Explicitly activating System Events first -- the standard fix for this
// exact osascript quirk -- makes the dialog come forward like any other
// app-owned window.
const macScript = (title) => `
tell application "System Events" to activate
POSIX path of (choose folder with prompt "${String(title).replace(/"/g, '\\"')}")
`.trim();

/**
 * @param {string} [title] Prompt text -- reused for both the dataset folder
 *   and the (optional) annotations folder picker, so the dialog always says
 *   which one you're choosing.
 * @returns {Promise<{status:"selected",path:string}|{status:"cancelled"}|{status:"unavailable",message:string}>}
 */
async function pickFolder(title = "Select a dataset folder") {
  if (process.platform === "win32") {
    // Windows PowerShell (powershell.exe, ships with every Windows install)
    // is tried first; PowerShell 7+ (pwsh.exe) is a fallback for machines
    // where Windows PowerShell has been removed/disabled.
    let r = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", winScript(title)]);
    if (r.notFound) r = await run("pwsh.exe", ["-NoProfile", "-STA", "-Command", winScript(title)]);
    if (r.notFound) return { status: "unavailable", message: "PowerShell not found (tried powershell.exe and pwsh.exe)." };
    if (!r.ok) return { status: "unavailable", message: "Could not open the Windows folder dialog." };
    const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(WIN_MARKER));
    if (!line) return { status: "cancelled" };
    const p = line.slice(WIN_MARKER.length).trim();
    return p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  if (process.platform === "darwin") {
    const r = await run("osascript", ["-e", macScript(title)]);
    if (r.notFound) return { status: "unavailable", message: "osascript not found." };
    if (!r.ok) return /cancel/i.test(r.stderr) ? { status: "cancelled" } : { status: "unavailable", message: "Could not open the folder dialog." };
    const p = r.stdout.trim().replace(/\/$/, "");
    return p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  const z = await run("zenity", ["--file-selection", "--directory", `--title=${title}`]);
  if (!z.notFound) {
    const p = z.stdout.trim();
    return z.ok && p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  const k = await run("kdialog", ["--getexistingdirectory", os.homedir(), title]);
  if (!k.notFound) {
    const p = k.stdout.trim();
    return k.ok && p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  return { status: "unavailable", message: "No graphical folder picker available (headless, or zenity/kdialog missing)." };
}

module.exports = { pickFolder };
