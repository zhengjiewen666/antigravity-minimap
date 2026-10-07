const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');

// 静默守护模式下，安全处理断开的管道输出，防止无终端窗口时抛出 EPIPE 崩溃
if (process.stdout) process.stdout.on('error', () => {});
if (process.stderr) process.stderr.on('error', () => {});
const origLog = console.log;
console.log = (...args) => {
  try {
    if (process.stdout && process.stdout.writable) origLog(...args);
  } catch (e) {}
};

const logFile = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'daemon.log');
function log(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ` + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '\n';
  try {
    fs.appendFileSync(logFile, line);
    if (fs.statSync(logFile).size > 1024 * 1024) {
      fs.truncateSync(logFile, 0);
    }
  } catch (e) {}
}

process.on('uncaughtException', (err) => { log('uncaughtException:', err.message); });
process.on('unhandledRejection', (reason) => { log('unhandledRejection:', String(reason)); });

let lastConvId = null;
let lastPromptsHash = '';
let ws = null;
let reconnectTimer = null;
let lastFlagsChecked = 0;
let lastForksScan = 0;

// 分支管理与元数据持久化
const metaFilePath = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'forks_meta.json');
let cachedForks = {};
let cachedParents = {};

function loadPersistedForks() {
  try {
    if (fs.existsSync(metaFilePath)) {
      const data = JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
      if (data && data.forks) cachedForks = data.forks;
      if (data && data.parents) cachedParents = data.parents;
    }
  } catch (e) {}
}

function savePersistedForks() {
  try {
    fs.writeFileSync(metaFilePath, JSON.stringify({
      forks: cachedForks,
      parents: cachedParents,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {}
}

loadPersistedForks();

function scanForks() {
  const brainDir = path.join(process.env.USERPROFILE, '.gemini', 'antigravity', 'brain');
  if (!fs.existsSync(brainDir)) return;

  const entries = fs.readdirSync(brainDir, { withFileTypes: true });
  const convMap = {};

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cid = e.name;
    const tPath = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(tPath)) continue;

    try {
      const stat = fs.statSync(path.join(brainDir, cid));
      const content = fs.readFileSync(tPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      const prompts = [];
      let firstPromptTime = null;

      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.source === 'USER_EXPLICIT' && o.type === 'USER_INPUT') {
            let text = o.content || '';
            const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (m) text = m[1].trim();
            if (text) {
              if (!firstPromptTime) firstPromptTime = o.created_at;
              prompts.push(text);
            }
          }
        } catch (err) {}
      }

      if (prompts.length > 0) {
        const rootKey = (firstPromptTime || 'unknown') + '::' + prompts[0].slice(0, 40);
        if (!convMap[rootKey]) convMap[rootKey] = [];
        convMap[rootKey].push({
          convId: cid,
          birthtime: stat.birthtime.getTime(),
          prompts
        });
      }
    } catch (err) {}
  }

  const forks = {};
  const parents = {};

  for (const [key, group] of Object.entries(convMap)) {
    if (group.length > 1) {
      group.sort((a, b) => a.birthtime - b.birthtime);
      const root = group[0];
      for (let i = 1; i < group.length; i++) {
        const fork = group[i];
        let shared = 0;
        const max = Math.min(root.prompts.length, fork.prompts.length);
        while (shared < max && root.prompts[shared] === fork.prompts[shared]) {
          shared++;
        }
        forks[fork.convId] = {
          parentConvId: root.convId,
          forkRound: shared,
          forkPrompt: fork.prompts[shared - 1] ? fork.prompts[shared - 1].slice(0, 40) : null,
          rootTitle: root.prompts[0].slice(0, 30)
        };

        if (!parents[root.convId]) {
          parents[root.convId] = { forkCount: 0, forks: [] };
        }
        parents[root.convId].forkCount++;
        parents[root.convId].forks.push({
          forkConvId: fork.convId,
          forkRound: shared
        });
      }
    }
  }

  cachedForks = Object.assign({}, cachedForks, forks);
  cachedParents = Object.assign({}, cachedParents, parents);
  savePersistedForks();
  lastForksScan = Date.now();
  log(`Scanned ${entries.length} convs: identified ${Object.keys(cachedForks).length} forks, ${Object.keys(cachedParents).length} parents`);
}

// 启动时先行扫描一次分支关系
try { scanForks(); } catch(e) {}

// HTTP 单实例锁与健康状态服务 (独占 48899 端口)
const lockServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      lastConvId,
      wsConnected: !!(ws && ws.readyState === 1),
      lastPromptsHash,
      forksCount: Object.keys(cachedForks).length,
      parentsCount: Object.keys(cachedParents).length
    }));
    return;
  }
  if (req.url === '/forks') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      forks: cachedForks,
      parents: cachedParents
    }));
    return;
  }
  if (req.url === '/eval' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const result = await sendCDP('Runtime.evaluate', {
          expression: body,
          returnByValue: true,
          awaitPromise: true
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(200);
  res.end('Antigravity Minimap & Fork Daemon Active');
});

lockServer.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
  }
});
lockServer.listen(48899, '127.0.0.1');

const CSS_STYLES = `
#ag-minimap-root {
  position: fixed;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 999999;
  user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* 平时右侧小横线刻度条 */
#ag-minimap-bar {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  padding: 8px 5px;
  background: rgba(20, 22, 26, 0.4);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  transition: all 0.2s ease;
}
#ag-minimap-root:hover #ag-minimap-bar {
  background: rgba(20, 22, 26, 0.85);
  border-color: rgba(255, 255, 255, 0.16);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.ag-minimap-tick {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.35);
  transition: all 0.15s ease;
}
.ag-minimap-tick.active, .ag-minimap-tick:hover {
  width: 22px;
  height: 3.5px;
  background: #4ade80 !important;
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.7);
}
.ag-minimap-tick.is-branch {
  background: rgba(168, 85, 247, 0.55) !important;
}
.ag-minimap-tick.is-branch.active, .ag-minimap-tick.is-branch:hover {
  width: 22px;
  height: 3.5px;
  background: #c084fc !important;
  box-shadow: 0 0 8px rgba(192, 132, 252, 0.8) !important;
}

/* 鼠标没放上去时：绝对隐藏大卡片，禁止显示任何文字 */
#ag-minimap-card {
  display: none !important;
  position: absolute;
  right: 32px;
  top: 50%;
  transform: translateY(-50%);
  width: 350px;
  max-height: 500px;
  background: rgba(24, 26, 32, 0.98);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65);
  padding: 12px 10px;
  box-sizing: border-box;
}

/* 鼠标放上去时：整洁的大卡片展开 */
#ag-minimap-root:hover #ag-minimap-card {
  display: flex !important;
  flex-direction: column;
  gap: 4px;
}

.ag-minimap-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 8px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin-bottom: 4px;
  font-size: 11px;
  color: #94a3b8;
  font-weight: 500;
}
.ag-minimap-card-badge {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
}

.ag-minimap-card-list {
  overflow-y: auto;
  max-height: 420px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-right: 2px;
}
.ag-minimap-card-list::-webkit-scrollbar {
  width: 5px;
}
.ag-minimap-card-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

/* 分支专属分界线 */
.ag-minimap-branch-divider {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px 4px;
  margin: 3px 0 2px;
  user-select: none;
}
.ag-minimap-branch-divider-line {
  flex: 1;
  height: 1px;
  background: rgba(168, 85, 247, 0.35);
}
.ag-minimap-branch-divider-tag {
  font-size: 10px;
  font-weight: 600;
  color: #c084fc;
  background: rgba(168, 85, 247, 0.16);
  border: 1px solid rgba(168, 85, 247, 0.4);
  padding: 1px 7px;
  border-radius: 6px;
  white-space: nowrap;
}

/* 普通行：文字浅、半透明 */
.ag-minimap-row {
  padding: 7px 10px;
  font-size: 12.5px;
  line-height: 1.4;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  width: 100%;
  transition: all 0.12s ease;
  color: #94a3b8;
  opacity: 0.7;
  background: transparent;
  border-left: 3px solid transparent;
}

/* 选中行/当前悬停行：颜色深、加重底色、纯白明亮高亮 */
.ag-minimap-row:hover, .ag-minimap-row.active {
  color: #ffffff !important;
  opacity: 1 !important;
  background: rgba(74, 222, 128, 0.16) !important;
  border-left: 3px solid #4ade80 !important;
  padding-left: 12px;
}

/* 分支提问行样式 */
.ag-minimap-row.is-branch {
  border-left: 3px solid rgba(168, 85, 247, 0.35);
}
.ag-minimap-row.is-branch .ag-minimap-row-idx {
  color: #c084fc;
}
.ag-minimap-row.is-branch:hover, .ag-minimap-row.is-branch.active {
  background: rgba(168, 85, 247, 0.18) !important;
  border-left: 3px solid #c084fc !important;
  color: #ffffff !important;
}

/* 点击定位加载中状态 */
.ag-minimap-row.loading {
  color: #60a5fa !important;
  opacity: 1 !important;
  background: rgba(37, 99, 235, 0.22) !important;
  border-left: 3px solid #3b82f6 !important;
  padding-left: 12px;
}

.ag-minimap-row-idx {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #64748b;
  min-width: 18px;
  flex-shrink: 0;
}
.ag-minimap-row:hover .ag-minimap-row-idx, .ag-minimap-row.active .ag-minimap-row-idx {
  color: #4ade80;
  font-weight: 600;
}

.ag-minimap-row-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-grow: 1;
}

/* 灵动分叉小胶囊按钮（对标 Gemini 网页版一键分叉） */
.ag-minimap-row-fork {
  display: none;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 500;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.ag-minimap-row:hover .ag-minimap-row-fork {
  display: inline-flex !important;
}
.ag-minimap-row-fork:hover {
  color: #ffffff !important;
  background: #2563eb !important;
  border-color: #60a5fa !important;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.55);
  transform: scale(1.04);
}

/* 侧边栏分支徽标与主干徽标样式 */
.ag-sidebar-badge-container {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  width: 100% !important;
  min-width: 0 !important;
}
.ag-sidebar-badge-container > span.truncate {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
}
.ag-fork-badge {
  background: rgba(168, 85, 247, 0.22) !important;
  color: #c084fc !important;
  border: 1px solid rgba(168, 85, 247, 0.45) !important;
  border-radius: 4px !important;
  padding: 0 5px !important;
  font-size: 10px !important;
  font-weight: 600 !important;
  margin-left: 6px !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 3px !important;
  vertical-align: middle !important;
  line-height: 16px !important;
  flex-shrink: 0 !important;
  user-select: none !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}
.ag-fork-badge:hover {
  background: rgba(168, 85, 247, 0.35) !important;
  border-color: rgba(168, 85, 247, 0.7) !important;
  box-shadow: 0 0 8px rgba(168, 85, 247, 0.4) !important;
}
.ag-root-badge {
  background: rgba(59, 130, 246, 0.18) !important;
  color: #60a5fa !important;
  border: 1px solid rgba(59, 130, 246, 0.4) !important;
  border-radius: 4px !important;
  padding: 0 5px !important;
  font-size: 10px !important;
  font-weight: 600 !important;
  margin-left: 6px !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 3px !important;
  vertical-align: middle !important;
  line-height: 16px !important;
  flex-shrink: 0 !important;
  user-select: none !important;
  pointer-events: auto !important;
  cursor: pointer !important;
  transition: all 0.15s ease !important;
}
.ag-root-badge:hover {
  background: rgba(59, 130, 246, 0.3) !important;
  border-color: rgba(59, 130, 246, 0.65) !important;
  box-shadow: 0 0 8px rgba(59, 130, 246, 0.35) !important;
}
`;

const FORK_SVG = `<svg viewBox="0 -960 960 960" width="12" height="12" fill="currentColor"><path d="M530-140V-290.77q-18.77-68.62-66-101.81T360.85-425.77q-16.39,0-33.15,1.88t-32.77,4.65l73.39,74l-42.15,42.15L180-449.23L326.15-595.38l42.15,42.15l-73.39,74q14.77-2.77 30.54-4.15t32.92-1.38q49.39,0 93.96,18.69T530-407.54V-704.69l-74,74l-42.15-42.77L560-819.61L706.15-673.46L664-631.31l-74-73.39V-140H530Z"/></svg> <span>分叉</span>`;

function getPort() {
  const activePortFile = path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort');
  if (!fs.existsSync(activePortFile)) return null;
  return fs.readFileSync(activePortFile, 'utf-8').trim().split('\n')[0];
}

async function connect() {
  const port = getPort();
  if (!port) {
    scheduleReconnect();
    return;
  }

  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
    const page = targets.find(t => t.type === 'page');
    if (!page) {
      scheduleReconnect();
      return;
    }

    ws = new WebSocket(page.webSocketDebuggerUrl);

    ws.onopen = async () => {
      log('Antigravity Enhanced Daemon connected');
      lastConvId = null;
      lastPromptsHash = '';
      lastFlagsChecked = 0;
      loopSync();
    };

    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws = null;
      scheduleReconnect();
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function sendCDP(method, params) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve(null);
    const id = Math.floor(Math.random() * 1000000);
    let resolved = false;

    const onMsg = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          resolved = true;
          ws.removeEventListener('message', onMsg);
          resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.addEventListener('message', onMsg);
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      resolved = true;
      ws.removeEventListener('message', onMsg);
      return resolve(null);
    }
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.removeEventListener('message', onMsg); } catch(e) {}
        resolve(null);
      }
    }, 4000);
  });
}

// 自动保证原生分叉与分支实验特性的常驻开启
async function ensureForkFlags() {
  const now = Date.now();
  if (now - lastFlagsChecked < 30000) return;
  lastFlagsChecked = now;

  await sendCDP('Runtime.evaluate', {
    expression: `(() => {
      try {
        const cur = window.localStorage.getItem('jetski.developer.customFlagOverrides');
        let flags = {};
        try { flags = JSON.parse(cur) || {}; } catch(e) {}
        let changed = false;
        const required = {
          'enable-conversation-forking': true,
          'enable-fork-at-historical-step': true,
          'enable-fork-in-new-worktree': true,
          'enable-conversation-only-revert': true,
          'enable-split-view': true
        };
        for (const [k, v] of Object.entries(required)) {
          if (flags[k] !== v) {
            flags[k] = v;
            changed = true;
          }
        }
        if (changed) {
          window.localStorage.setItem('jetski.developer.customFlagOverrides', JSON.stringify(flags));
        }
      } catch(e) {}
    })()`
  });
}

// 确保浏览器全局环境与侧边栏徽标常驻运行
async function ensureClientEnvironment() {
  const code = `
    (() => {
      let style = document.getElementById('ag-minimap-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'ag-minimap-style';
        document.head.appendChild(style);
      }
      style.textContent = ${JSON.stringify(CSS_STYLES)};

      window.__agForksMap = ${JSON.stringify(cachedForks)};
      window.__agParentMap = ${JSON.stringify(Object.fromEntries(Object.entries(cachedParents).map(([k, v]) => [k, v.forkCount])))};

      if (!window.__agSyncSidebarBadges) {
        window.__agSyncSidebarBadges = function() {
          const rows = Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'));
          if (!rows.length) return;
          const fMap = window.__agForksMap || {};
          const pMap = window.__agParentMap || {};

          rows.forEach(r => {
            const id = r.getAttribute('data-cascade-id');
            if (!id) return;
            const titleSpan = r.querySelector('span.truncate') || r.querySelector('span');
            if (!titleSpan) return;

            const container = titleSpan.parentElement;
            if (!container.classList.contains('ag-sidebar-badge-container')) {
              container.classList.add('ag-sidebar-badge-container');
            }

            const isFork = !!fMap[id];
            const isParent = !!(pMap[id] && pMap[id] > 0);

            let badge = container.querySelector('.ag-fork-badge, .ag-root-badge');

            if (isFork) {
              const info = fMap[id];
              if (!badge || !badge.classList.contains('ag-fork-badge') || badge.dataset.forkRound != String(info.forkRound)) {
                if (badge) badge.remove();
                badge = document.createElement('span');
                badge.className = 'ag-fork-badge';
                badge.dataset.forkRound = String(info.forkRound);
                badge.title = '分支对话 (自第 ' + info.forkRound + ' 轮分叉创建)';
                badge.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="9" r="3"/><path d="M6 9v6"/><path d="M18 9c0 3-3 6-12 6"/></svg> 分支 #' + info.forkRound;
                badge.onclick = (e) => {
                  e.stopPropagation();
                  const a = r.querySelector('a');
                  if (a) a.click();
                };
                container.appendChild(badge);
              }
            } else if (isParent) {
              const count = pMap[id];
              if (!badge || !badge.classList.contains('ag-root-badge') || badge.dataset.count != String(count)) {
                if (badge) badge.remove();
                badge = document.createElement('span');
                badge.className = 'ag-root-badge';
                badge.dataset.count = String(count);
                badge.title = '主干会话 (已有 ' + count + ' 个衍生分支)';
                badge.innerHTML = '📌 主干';
                badge.onclick = (e) => {
                  e.stopPropagation();
                  const a = r.querySelector('a');
                  if (a) a.click();
                };
                container.appendChild(badge);
              }
            } else {
              if (badge) badge.remove();
            }
          });
        };
      }

      window.__agSyncSidebarBadges();
      if (!window.__agSidebarBadgeTimer) {
        window.__agSidebarBadgeTimer = setInterval(window.__agSyncSidebarBadges, 800);
      }
    })()
  `;
  await sendCDP('Runtime.evaluate', { expression: code });
}

async function loopSync() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    await ensureForkFlags();

    // 定期或按需扫描全量会话分支关系（每 15 秒扫描一次）
    if (Date.now() - lastForksScan > 15000) {
      try { scanForks(); } catch(e) {}
    }

    // 确保侧边栏标记与全局样式常驻
    await ensureClientEnvironment();

    const res = await sendCDP('Runtime.evaluate', {
      expression: '(() => ({ pathname: window.location.pathname, hasRoot: !!document.getElementById("ag-minimap-root"), datasetConv: document.getElementById("ag-minimap-root")?.dataset?.convId, pendingFork: window.localStorage.getItem("ag_pending_fork") }))()',
      returnByValue: true
    });
    const info = res?.result?.value || {};
    const pathname = info.pathname || '';
    const hasRoot = !!info.hasRoot;
    const datasetConv = info.datasetConv || null;
    const convId = (pathname.split('/c/')[1] || '').split('?')[0] || null;

    // 检查是否有刚点击分叉按钮产生的待定分支
    if (info.pendingFork && convId) {
      try {
        const pf = JSON.parse(info.pendingFork);
        if (pf && pf.fromConvId && pf.fromConvId !== convId && Date.now() - pf.time < 120000) {
          if (!cachedForks[convId]) {
            cachedForks[convId] = {
              parentConvId: pf.fromConvId,
              forkRound: pf.fromRound,
              forkPrompt: pf.fromPrompt || null,
              rootTitle: ''
            };
            if (!cachedParents[pf.fromConvId]) {
              cachedParents[pf.fromConvId] = { forkCount: 0, forks: [] };
            }
            cachedParents[pf.fromConvId].forkCount++;
            cachedParents[pf.fromConvId].forks.push({
              forkConvId: convId,
              forkRound: pf.fromRound
            });
            savePersistedForks();
            log(`Immediately registered fork ${convId} from ${pf.fromConvId} at round ${pf.fromRound}`);
          }
          await sendCDP('Runtime.evaluate', { expression: 'window.localStorage.removeItem("ag_pending_fork")' });
        }
      } catch(e) {}
    }

    if (convId) {
      const transcriptPath = path.join(
        process.env.USERPROFILE,
        '.gemini',
        'antigravity',
        'brain',
        convId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      );

      const allPrompts = [];
      if (fs.existsSync(transcriptPath)) {
        const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.source === 'USER_EXPLICIT' && obj.type === 'USER_INPUT') {
              let content = obj.content || '';
              const matchReq = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
              if (matchReq) content = matchReq[1].trim();
              if (content) {
                allPrompts.push({
                  text: content
                });
              }
            }
          } catch (e) {}
        }
      }

      const forkInfo = cachedForks[convId] || null;
      const parentInfo = cachedParents[convId] || null;
      const hash = convId + '_' + JSON.stringify(allPrompts.map(p => p.text)) + '_' + (forkInfo ? forkInfo.forkRound : '0');

      if (convId !== lastConvId || hash !== lastPromptsHash || !hasRoot || datasetConv !== convId) {
        lastConvId = convId;
        lastPromptsHash = hash;
        log(`Rendered ${allPrompts.length} prompts & fork tools for conv: ${convId}`);
        await renderCleanMinimap(convId, allPrompts, forkInfo, parentInfo);
      }
    } else {
      if (lastConvId !== null) {
        lastConvId = null;
        lastPromptsHash = '';
        await sendCDP('Runtime.evaluate', {
          expression: `(() => { const r = document.getElementById('ag-minimap-root'); if (r) r.style.display = 'none'; })()`
        });
      }
    }
  } catch (e) {
    log('loopSync error:', e.message);
  }

  setTimeout(loopSync, 600);
}

async function renderCleanMinimap(convId, prompts, forkInfo, parentInfo) {
  if (!prompts || prompts.length === 0) {
    await sendCDP('Runtime.evaluate', {
      expression: `(() => { const r = document.getElementById('ag-minimap-root'); if (r) r.remove(); })()`
    });
    return;
  }

  const code = `
    (() => {
      const currentConvId = ${JSON.stringify(convId)};
      const promptsData = ${JSON.stringify(prompts)};
      const currentForkInfo = ${JSON.stringify(forkInfo)};
      const currentParentInfo = ${JSON.stringify(parentInfo)};

      // 1. 样式表注入与更新
      let style = document.getElementById('ag-minimap-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'ag-minimap-style';
        document.head.appendChild(style);
      }
      style.textContent = ${JSON.stringify(CSS_STYLES)};

      // 2. 根结构挂载与标识绑定
      let root = document.getElementById('ag-minimap-root');
      if (root) root.remove();

      root = document.createElement('div');
      root.id = 'ag-minimap-root';
      root.dataset.convId = currentConvId;

      const card = document.createElement('div');
      card.id = 'ag-minimap-card';

      let headerTitleHtml = '<span>提问导航与分支管理</span>';
      let headerBadgeHtml = '<span class="ag-minimap-card-badge">' + promptsData.length + ' 轮提问</span>';

      if (currentForkInfo) {
        headerTitleHtml = '<span style="color:#c084fc;font-weight:600;display:flex;align-items:center;gap:4px">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="9" r="3"/><path d="M6 9v6"/><path d="M18 9c0 3-3 6-12 6"/></svg>' +
          '分支对话 (分叉自 #' + currentForkInfo.forkRound + ')</span>';
        headerBadgeHtml = '<span class="ag-minimap-card-badge" style="background:rgba(168,85,247,0.18);color:#c084fc;border:1px solid rgba(168,85,247,0.4)">' +
          promptsData.length + ' 轮提问</span>';
      } else if (currentParentInfo && currentParentInfo.forkCount > 0) {
        headerTitleHtml = '<span style="color:#60a5fa;font-weight:600;display:flex;align-items:center;gap:4px">' +
          '📌 主干对话 (' + currentParentInfo.forkCount + ' 个分支)</span>';
        headerBadgeHtml = '<span class="ag-minimap-card-badge" style="background:rgba(59,130,246,0.18);color:#60a5fa;border:1px solid rgba(59,130,246,0.4)">' +
          promptsData.length + ' 轮提问</span>';
      }

      card.innerHTML = '<div class="ag-minimap-card-header">' + headerTitleHtml + headerBadgeHtml + '</div><div id="ag-minimap-items" class="ag-minimap-card-list"></div>';

      const bar = document.createElement('div');
      bar.id = 'ag-minimap-bar';

      root.appendChild(card);
      root.appendChild(bar);
      document.body.appendChild(root);

      const listEl = card.querySelector('#ag-minimap-items');

      // 3. 浏览器端毫秒级路由监听：一旦切换到其他会话，立刻隐匿旧会话内容，杜绝跨会话残留
      if (!window.__agRouteWatcher) {
        window.__agRouteWatcher = setInterval(() => {
          const curPath = window.location.pathname;
          const curConv = (curPath.split('/c/')[1] || '').split('?')[0] || null;
          const r = document.getElementById('ag-minimap-root');
          if (r) {
            if (!curConv || r.dataset.convId !== curConv) {
              r.style.display = 'none';
            } else {
              r.style.display = '';
            }
          }
        }, 150);
      }

      function getChatScroller() {
        const anchor = document.querySelector('[data-turn-content]') ||
                       document.querySelector('.md-sticky-message-bleed') ||
                       document.querySelector('[data-testid="turn-cards-container"]');
        if (anchor) {
          let curr = anchor;
          while (curr && curr !== document.body) {
            if (curr.scrollHeight > curr.clientHeight && curr.clientHeight > 350) {
              return curr;
            }
            curr = curr.parentElement;
          }
        }
        const candidates = Array.from(document.querySelectorAll('div'));
        return candidates.find(el => {
          if (el.scrollHeight <= el.clientHeight || el.clientHeight < 350) return false;
          if (el.getAttribute('contenteditable') === 'true' || el.classList.contains('cursor-text')) return false;
          return el.getBoundingClientRect().left > 150;
        });
      }

      function pulseHighlight(node) {
        if (!node) return;
        const origBg = node.style.backgroundColor;
        const origTrans = node.style.transition;
        const origRadius = node.style.borderRadius;
        const origOutline = node.style.outline;
        const origBoxShadow = node.style.boxShadow;

        node.style.transition = 'all 0.3s ease';
        node.style.backgroundColor = 'rgba(74, 222, 128, 0.22)';
        node.style.outline = '2px solid rgba(74, 222, 128, 0.7)';
        node.style.boxShadow = '0 0 20px rgba(74, 222, 128, 0.35)';
        node.style.borderRadius = '12px';

        setTimeout(() => {
          node.style.transition = 'all 0.8s ease';
          node.style.backgroundColor = origBg;
          node.style.outline = origOutline;
          node.style.boxShadow = origBoxShadow;
          node.style.borderRadius = origRadius;
          setTimeout(() => {
            node.style.transition = origTrans;
          }, 800);
        }, 2800);
      }

      function lockAndCenter(node) {
        if (!node) return;
        window.__minimapIsJumping = true;

        if (window.__minimapAnchorTimer) {
          clearTimeout(window.__minimapAnchorTimer);
        }

        const rect = node.getBoundingClientRect();
        const distance = Math.abs(rect.top - window.innerHeight / 2);

        const behavior = distance > 750 ? 'auto' : 'smooth';
        node.scrollIntoView({ behavior, block: 'center' });
        pulseHighlight(node);

        window.__minimapAnchorTimer = setTimeout(() => {
          if (node.isConnected) {
            const r = node.getBoundingClientRect();
            if (Math.abs(r.top - window.innerHeight / 2) > 120) {
              node.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
          }
          window.__minimapIsJumping = false;
        }, 250);
      }

      function cleanPromptText(raw) {
        if (!raw) return '';
        return raw
          .replace(/@\\[.*?\\]/g, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\\[([^\\]]+)\\]\\([^)]+\\)/g, '$1')
          .replace(/https?:\\/\\/\\S+/g, ' ')
          .replace(/[#*\\x60~_>\\-+=\\[\\]()|]/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      }

      function extractKeywords(cleanText) {
        const matches = cleanText.match(/[\\u4e00-\\u9fa5]{2,8}|[a-zA-Z0-9_\\-]{3,15}/g) || [];
        const stopWords = new Set(['https', 'http', 'com', 'org', 'html', 'pdf', '这个', '那个', '什么', '怎么', '为什么', '可以', '一下']);
        return matches.filter(w => !stopWords.has(w.toLowerCase()));
      }

      function stepMatches(stepNode, itemText) {
        if (!stepNode || !itemText) return false;
        const s = (stepNode.innerText || '').replace(/\\s+/g, ' ').toLowerCase();
        const raw = itemText.replace(/\\s+/g, ' ').toLowerCase();

        const cleanRaw = raw.replace(/@\\[.*?\\]/g, '').trim();
        if (cleanRaw.length >= 4 && s.includes(cleanRaw.slice(0, 25))) {
          return true;
        }

        const clean = cleanPromptText(itemText).toLowerCase();
        if (clean.length >= 4 && s.includes(clean.slice(0, 20))) {
          return true;
        }

        const keywords = extractKeywords(clean);
        if (keywords.length === 0) return false;

        const testWords = keywords.slice(0, 6);
        let hits = 0;
        for (const w of testWords) {
          if (s.includes(w.toLowerCase())) hits++;
        }
        const minRequired = Math.min(2, testWords.length);
        return hits >= minRequired && hits > 0;
      }

      function getLoadOlderButton() {
        const btn = document.querySelector('button[aria-label*="older messages"], button[aria-label*="Load older"]');
        if (!btn) return null;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return null;
        const label = btn.getAttribute('aria-label') || '';
        if (label.startsWith('No more') || label.includes('No more')) return null;
        const text = (btn.innerText || '').trim();
        if (text.startsWith('No more') || text.includes('No more')) return null;
        return btn;
      }

      promptsData.forEach((item, idx) => {
        const isBranchTurn = currentForkInfo && idx >= currentForkInfo.forkRound;

        // 若当前为分支会话且达到分叉起点，插入分支隔离分界线
        if (currentForkInfo && idx === currentForkInfo.forkRound) {
          const divider = document.createElement('div');
          divider.className = 'ag-minimap-branch-divider';
          divider.innerHTML = '<span class="ag-minimap-branch-divider-line"></span><span class="ag-minimap-branch-divider-tag">🌿 以下为分支独立探索 (#' + (currentForkInfo.forkRound + 1) + ' 起)</span><span class="ag-minimap-branch-divider-line"></span>';
          listEl.appendChild(divider);
        }

        const tick = document.createElement('div');
        tick.className = 'ag-minimap-tick' + (isBranchTurn ? ' is-branch' : '');
        tick.setAttribute('data-idx', idx);

        const row = document.createElement('div');
        row.className = 'ag-minimap-row' + (isBranchTurn ? ' is-branch' : '');
        row.setAttribute('data-idx', idx);
        row.title = item.text;

        const idxSpan = document.createElement('span');
        idxSpan.className = 'ag-minimap-row-idx';
        idxSpan.textContent = '#' + (idx + 1);

        const textSpan = document.createElement('span');
        textSpan.className = 'ag-minimap-row-text';
        textSpan.textContent = item.text;

        row.appendChild(idxSpan);
        row.appendChild(textSpan);

        // 创建专属的【Gemini 网页版同款分叉按钮】
        const forkBtn = document.createElement('button');
        forkBtn.className = 'ag-minimap-row-fork';
        forkBtn.title = '创建新的分支对话 (从第 ' + (idx + 1) + ' 轮分叉)';
        forkBtn.innerHTML = ${JSON.stringify(FORK_SVG)};
        forkBtn.onclick = async (e) => {
          e.stopPropagation();

          // 记录待定分支信息，供新会话瞬间打上分支标记
          try {
            window.localStorage.setItem('ag_pending_fork', JSON.stringify({
              fromConvId: currentConvId,
              fromRound: idx + 1,
              fromPrompt: item.text.slice(0, 40),
              time: Date.now()
            }));
          } catch(err) {}

          await jump(e);
          setTimeout(() => {
            const toolbars = Array.from(document.querySelectorAll('[data-testid="cascade-system-message-toolbar"]'));
            const tb = toolbars[idx] || toolbars[toolbars.length - 1];
            if (tb) {
              const b = tb.querySelector('[aria-label="Fork Conversation"]');
              if (b) {
                b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              }
            }
          }, 250);
        };
        row.appendChild(forkBtn);

        function highlight() {
          document.querySelectorAll('.ag-minimap-row').forEach(r => r.classList.remove('active'));
          document.querySelectorAll('.ag-minimap-tick').forEach(t => t.classList.remove('active'));
          row.classList.add('active');
          tick.classList.add('active');
        }
        row.addEventListener('mouseenter', highlight);
        tick.addEventListener('mouseenter', highlight);

        function findTarget() {
          const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
          if (!steps.length) return null;

          for (let i = steps.length - 1; i >= 0; i--) {
            if (stepMatches(steps[i], item.text)) {
              return steps[i];
            }
          }

          // 仅当所有历史消息已彻底加载完毕时，第1轮提问才对应最顶部的步骤
          if (idx === 0 && !getLoadOlderButton() && steps.length > 0) {
            return steps[0];
          }

          if (idx === promptsData.length - 1 && steps.length > 0) {
            return steps[steps.length - 1];
          }

          return null;
        }

        async function jump(e) {
          e.stopPropagation();
          window.__minimapIsJumping = true;

          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          try { window.getSelection()?.removeAllRanges(); } catch (err) {}

          const scroller = getChatScroller();
          if (!scroller) {
            window.__minimapIsJumping = false;
            return;
          }

          const total = promptsData.length;
          const currentJumpId = Date.now();
          window.__minimapJumpId = currentJumpId;

          // 视觉状态：立即显示正在定位
          document.querySelectorAll('.ag-minimap-row').forEach(r => r.classList.remove('loading'));
          row.classList.add('loading');

          if (idx === total - 1) {
            scroller.scrollTop = scroller.scrollHeight;
            setTimeout(() => {
              const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
              row.classList.remove('loading');
              if (steps.length > 0) {
                lockAndCenter(steps[steps.length - 1]);
              } else {
                window.__minimapIsJumping = false;
              }
            }, 60);
            return;
          }

          let targetNode = findTarget();
          if (targetNode) {
            row.classList.remove('loading');
            lockAndCenter(targetNode);
            return;
          }

          // 目标未在当前视口内：启动受控快速回溯加载
          const maxRounds = idx === 0 ? 95 : 80;
          for (let round = 0; round < maxRounds; round++) {
            if (window.__minimapJumpId !== currentJumpId) return;

            const btn = getLoadOlderButton();
            if (!btn) break;

            const oldLabel = btn.getAttribute('aria-label');
            btn.click();

            // 极速轮询监听 DOM 加载更新（平均仅 15-25ms）
            let changed = false;
            for (let w = 0; w < 20; w++) {
              await new Promise(res => setTimeout(res, 12));
              if (window.__minimapJumpId !== currentJumpId) return;
              const curBtn = getLoadOlderButton();
              if (!curBtn || curBtn.getAttribute('aria-label') !== oldLabel) {
                changed = true;
                break;
              }
            }
            if (!changed) break;

            targetNode = findTarget();
            if (targetNode) {
              row.classList.remove('loading');
              lockAndCenter(targetNode);
              return;
            }
          }

          await new Promise(res => setTimeout(res, 30));
          if (window.__minimapJumpId !== currentJumpId) return;

          targetNode = findTarget();
          row.classList.remove('loading');

          if (targetNode) {
            lockAndCenter(targetNode);
          } else {
            // 严禁误匹配错误节点或跳至顶部：未找到时优雅停止
            window.__minimapIsJumping = false;
          }
        }

        tick.onclick = jump;
        row.onclick = jump;

        bar.appendChild(tick);
        listEl.appendChild(row);
      });

      if (bar.lastElementChild) bar.lastElementChild.classList.add('active');
      if (listEl.lastElementChild) listEl.lastElementChild.classList.add('active');

      // 用户滚动监听联动高亮
      const scroller = getChatScroller();
      if (scroller && !scroller.__minimapScrollBound) {
        scroller.__minimapScrollBound = true;
        let lastScrollCheck = 0;
        let ticking = false;

        scroller.addEventListener('scroll', () => {
          if (window.__minimapIsJumping) return;

          const now = Date.now();
          if (now - lastScrollCheck < 100) return;
          lastScrollCheck = now;

          if (ticking) return;
          ticking = true;
          requestAnimationFrame(() => {
            ticking = false;
            const rootEl = document.getElementById('ag-minimap-root');
            if (rootEl && rootEl.matches(':hover')) return;

            const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
            if (!steps.length) return;
            const scrollerRect = scroller.getBoundingClientRect();
            let activeStep = null;
            for (let i = 0; i < steps.length; i++) {
              const rect = steps[i].getBoundingClientRect();
              if (rect.top <= scrollerRect.top + 220) {
                activeStep = steps[i];
              }
            }
            if (!activeStep) activeStep = steps[0];

            let matchedPromptIdx = -1;
            for (let p = promptsData.length - 1; p >= 0; p--) {
              if (stepMatches(activeStep, promptsData[p].text)) {
                matchedPromptIdx = p;
                break;
              }
            }

            if (matchedPromptIdx !== -1) {
              document.querySelectorAll('.ag-minimap-row').forEach((r, i) => {
                r.classList.toggle('active', i === matchedPromptIdx);
              });
              document.querySelectorAll('.ag-minimap-tick').forEach((t, i) => {
                t.classList.toggle('active', i === matchedPromptIdx);
              });
            }
          });
        }, { passive: true });
      }

      // 对标 Gemini 网页版：增强并本地化所有原生消息工具栏的分叉按钮文案与菜单
      const enhanceNativeForkButtons = () => {
        const forkBtns = Array.from(document.querySelectorAll('[aria-label="Fork Conversation"]'));
        forkBtns.forEach(btn => {
          btn.setAttribute('title', '创建新的分支对话 (从此处分叉)');
          const tipId = btn.getAttribute('data-tooltip-id');
          if (tipId) {
            const tipEl = document.getElementById(tipId);
            if (tipEl && (tipEl.innerText.includes('Fork Conversation') || tipEl.innerText.includes('Creating Fork'))) {
              tipEl.innerText = '创建新的分支对话 (从此处分叉)';
            }
          }
        });
      };
      enhanceNativeForkButtons();

      if (!window.__forkObserverActive) {
        window.__forkObserverActive = true;
        const observer = new MutationObserver(() => {
          enhanceNativeForkButtons();
          document.querySelectorAll('[data-testid="fork-target-option"]').forEach(el => {
            if (el.innerText.includes('current workspace') && !el.dataset.localized) {
              el.dataset.localized = 'true';
              el.innerHTML = '<span style="font-weight:600;display:block">在当前工作区创建分支</span><span style="font-size:11px;opacity:0.75;display:block;margin-top:2px">继承当前点全部历史并在本项目继续</span>';
            } else if (el.innerText.includes('shared workspace') && !el.dataset.localized) {
              el.dataset.localized = 'true';
              el.innerHTML = '<span style="font-weight:600;display:block">在独立工作区创建分支</span><span style="font-size:11px;opacity:0.75;display:block;margin-top:2px">在共享/隔离工作区中独立探索</span>';
            }
          });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }

    })()
  `;

  const evalRes = await sendCDP('Runtime.evaluate', { expression: code, returnByValue: true });
  if (evalRes && evalRes.exceptionDetails) {
    log(`Render error for conv ${convId}:`, JSON.stringify(evalRes.exceptionDetails));
  }
}

connect();
