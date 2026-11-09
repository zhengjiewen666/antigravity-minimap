const http = require('http');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let responded = false;
function finish() {
  if (responded) return;
  responded = true;
  process.stdout.write('{}');
  process.exit(0);
}

function startDaemon() {
  const repoDaemonJs = 'C:\\Study\\antigravity-minimap\\toc_daemon.js';
  const userDaemonJs = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'toc_daemon.js');
  const daemonPath = fs.existsSync(repoDaemonJs) ? repoDaemonJs : userDaemonJs;

  try {
    // 使用 Windows WMI (Win32_Process.Create) 穿透控制台与父进程 Job Object，保证守护进程真正独立常驻
    const nodeExe = process.execPath;
    const cmd = `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='\\"${nodeExe}\\" \\"${daemonPath}\\"'}"`;
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
  } catch (e) {
    try {
      const vbsPath = 'C:\\Study\\antigravity-minimap\\run_daemon.vbs';
      if (fs.existsSync(vbsPath)) {
        execSync(`wscript.exe "${vbsPath}"`, { stdio: 'ignore', timeout: 3000 });
      }
    } catch (e2) {}
  }

  finish();
}

const req = http.get('http://127.0.0.1:48899/status', (res) => {
  finish();
});

req.on('error', startDaemon);
req.setTimeout(350, () => {
  req.destroy();
  startDaemon();
});
