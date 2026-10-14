const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const req = http.get('http://127.0.0.1:48899/status', (res) => {
  process.stdout.write('{}');
  process.exit(0);
});

function startDaemon() {
  const daemonPath = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'toc_daemon.js');
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
