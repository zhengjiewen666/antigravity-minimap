const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const req = http.get('http://127.0.0.1:48899/status', (res) => {
  process.stdout.write('{}');
  process.exit(0);
});

function startDaemon() {
  const repoDaemonJs = 'C:\\Study\\antigravity-minimap\\toc_daemon.js';
  const userDaemonJs = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'toc_daemon.js');
  const daemonPath = fs.existsSync(repoDaemonJs) ? repoDaemonJs : userDaemonJs;

  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  process.stdout.write('{}');
  process.exit(0);
}

req.on('error', startDaemon);
req.setTimeout(300, () => {
  req.destroy();
  startDaemon();
});
