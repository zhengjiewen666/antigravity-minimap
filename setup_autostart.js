const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const nodeExe = process.execPath;
const userProfile = process.env.USERPROFILE;
const targetDir = path.join(userProfile, '.gemini', 'antigravity');
const daemonJs = path.join(targetDir, 'toc_daemon.js');
const repoDaemonJs = 'C:\\Study\\antigravity-minimap\\toc_daemon.js';

// Ensure target directory and files exist
if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
if (fs.existsSync(repoDaemonJs)) {
  fs.copyFileSync(repoDaemonJs, daemonJs);
}

// Prepare VBS script with UTF-16LE and fallback
const vbsContent = `On Error Resume Next
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodeExe = "${nodeExe.replace(/\\/g, '\\')}"
daemonJs = "${daemonJs.replace(/\\/g, '\\')}"
fallbackJs = "${repoDaemonJs.replace(/\\/g, '\\')}"

targetScript = daemonJs
If Not fso.FileExists(targetScript) Then
  targetScript = fallbackJs
End If

ws.Run """" & nodeExe & """ """ & targetScript & """", 0, False
`;

const startupFolder = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsTarget = path.join(startupFolder, 'antigravity_minimap.vbs');

fs.writeFileSync(vbsTarget, Buffer.from('\ufeff' + vbsContent, 'utf16le'));
console.log('Successfully wrote Startup VBS in UTF-16LE to:', vbsTarget);

// Remove corrupted registry key
try {
  execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "AntigravityMinimap" /f', { stdio: 'ignore' });
  console.log('Cleaned up corrupted registry Run entry');
} catch (e) {}

// Also add a clean registry entry pointing directly to wscript running vbsTarget
try {
  const regCmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "AntigravityMinimap" /t REG_SZ /d "wscript.exe \\"${vbsTarget}\\"" /f`;
  execSync(regCmd, { stdio: 'ignore' });
  console.log('Registered clean HKCU Run entry');
} catch (e) {}
