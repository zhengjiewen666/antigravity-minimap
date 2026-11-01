const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const nodeExe = process.execPath;
const repoDir = 'C:\\Study\\antigravity-minimap';
const repoDaemonJs = 'C:\\Study\\antigravity-minimap\\toc_daemon.js';
const repoVbs = 'C:\\Study\\antigravity-minimap\\run_daemon.vbs';
const userProfile = process.env.USERPROFILE;
const targetDir = path.join(userProfile, '.gemini', 'antigravity');
const daemonJs = path.join(targetDir, 'toc_daemon.js');

// Ensure target directory and files exist
if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
if (fs.existsSync(repoDaemonJs)) {
  fs.copyFileSync(repoDaemonJs, daemonJs);
}

// In VBScript, backslashes are literal characters (not escape characters)!
const vbsContent = `Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodeExe = "${nodeExe}"
repoDaemonJs = "${repoDaemonJs}"

targetScript = repoDaemonJs
ws.Run """" & nodeExe & """ """ & targetScript & """", 0, False
`;

// 1. Write run_daemon.vbs directly in repo directory (pure ASCII path)
fs.writeFileSync(repoVbs, vbsContent, 'utf8');
console.log('Successfully wrote pure ASCII VBS to:', repoVbs);

// 2. Write Startup folder VBS
const startupFolder = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsTarget = path.join(startupFolder, 'antigravity_minimap.vbs');

fs.writeFileSync(vbsTarget, vbsContent, 'utf8');
console.log('Successfully wrote Startup VBS to:', vbsTarget);

// 3. Register clean registry HKCU Run entry pointing to pure ASCII repoVbs
try {
  const regCmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "AntigravityMinimap" /t REG_SZ /d "wscript.exe \\"${repoVbs}\\"" /f`;
  execSync(regCmd, { stdio: 'ignore' });
  console.log('Registered clean HKCU Run entry pointing to:', repoVbs);
} catch (e) {
  console.error('Failed to register HKCU Run entry:', e.message);
}
