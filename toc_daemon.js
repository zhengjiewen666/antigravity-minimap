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

// HTTP 单实例锁与健康状态服务 (独占 48899 端口)
const lockServer = http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      lastConvId,
      wsConnected: !!(ws && ws.readyState === 1),
      lastPromptsHash
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

async function loopSync() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    await ensureForkFlags();

    const res = await sendCDP('Runtime.evaluate', {
      expression: '(() => ({ pathname: window.location.pathname, hasRoot: !!document.getElementById("ag-minimap-root"), datasetConv: document.getElementById("ag-minimap-root")?.dataset?.convId }))()',
      returnByValue: true
    });
    const info = res?.result?.value || {};
    const pathname = info.pathname || '';
    const hasRoot = !!info.hasRoot;
    const datasetConv = info.datasetConv || null;
    const convId = (pathname.split('/c/')[1] || '').split('?')[0] || null;

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

      const hash = convId + '_' + JSON.stringify(allPrompts.map(p => p.text));
      if (convId !== lastConvId || hash !== lastPromptsHash || !hasRoot || datasetConv !== convId) {
        lastConvId = convId;
        lastPromptsHash = hash;
        log(`Rendered ${allPrompts.length} prompts & fork tools for conv: ${convId}`);
        await renderCleanMinimap(convId, allPrompts);
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

async function renderCleanMinimap(convId, prompts) {
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

      // 1. 样式表
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
      card.innerHTML = '<div class="ag-minimap-card-header"><span>提问导航与分支管理 (Gemini分叉)</span><span class="ag-minimap-card-badge">' + promptsData.length + ' 轮提问</span></div><div id="ag-minimap-items" class="ag-minimap-card-list"></div>';

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

      promptsData.forEach((item, idx) => {
        const tick = document.createElement('div');
        tick.className = 'ag-minimap-tick';
        tick.setAttribute('data-idx', idx);

        const row = document.createElement('div');
        row.className = 'ag-minimap-row';
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

        async function jump(e) {
          e.stopPropagation();
          window.__minimapIsJumping = true;

          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          try { window.getSelection()?.removeAllRanges(); } catch (err) {}

          const scroller = getChatScroller();
          if (!scroller) return;

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

          function findTarget() {
            const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
            if (!steps.length) return null;

            // 净化原始提问文本：剥离引文标记 @[Quote]、标签 @[File] 以及 markdown 链接
            const clean = (item.text || '')
              .replace(/@\[.*?\]/g, '')
              .replace(/<[^>]+>/g, '')
              .replace(/\[.*?\]\(.*?\)/g, '$1')
              .replace(/\s+/g, ' ')
              .trim();

            // 提取核心特征词（中文2字以上短语或英文标识符）
            const words = clean.match(/[\u4e00-\u9fa5]{2,10}|[a-zA-Z0-9_\-]{3,15}/g) || [clean.slice(0, 10)];
            const leadWords = words.filter(Boolean).slice(0, 3);

            let match = steps.find(s => {
              const st = (s.innerText || '').replace(/\s+/g, ' ');
              if (clean.length > 5 && st.includes(clean.slice(0, 15))) return true;
              for (const w of leadWords) {
                if (w.length >= 2 && st.includes(w)) return true;
              }
              return false;
            });

            if (!match && steps.length >= total && steps[idx]) {
              match = steps[idx];
            }

            const btn = document.querySelector('button[aria-label*="Load older"], button[aria-label*="older messages"]');
            if (!match && idx === 0 && !btn && steps[0]) {
              match = steps[0];
            }

            return match;
          }

          let targetNode = findTarget();
          if (targetNode) {
            row.classList.remove('loading');
            lockAndCenter(targetNode);
            return;
          }

          // 目标未在视口内（被虚拟列表截断）：启动极速事件响应式向上回溯加载
          const maxRounds = 40;
          for (let round = 0; round < maxRounds; round++) {
            if (window.__minimapJumpId !== currentJumpId) return;

            const btn = document.querySelector('button[aria-label*="Load older"], button[aria-label*="older messages"]');
            if (!btn) break;

            const oldLabel = btn.getAttribute('aria-label');
            btn.click();

            // 毫秒级轮询等待标签变动（响应式感知 React DOM 完成装载，平均仅 20-35ms）
            for (let w = 0; w < 30; w++) {
              await new Promise(res => setTimeout(res, 20));
              if (window.__minimapJumpId !== currentJumpId) return;
              const curBtn = document.querySelector('button[aria-label*="Load older"], button[aria-label*="older messages"]');
              if (!curBtn || curBtn.getAttribute('aria-label') !== oldLabel) break;
            }

            targetNode = findTarget();
            if (targetNode) {
              row.classList.remove('loading');
              lockAndCenter(targetNode);
              return;
            }
          }

          // 遍历结束或到达顶部：容错兜底中心化
          await new Promise(res => setTimeout(res, 60));
          if (window.__minimapJumpId !== currentJumpId) return;
          targetNode = findTarget();
          if (!targetNode) {
            const allSteps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
            if (allSteps.length > 0) {
              targetNode = allSteps[idx] || (idx < total / 2 ? allSteps[0] : allSteps[allSteps.length - 1]);
            }
          }

          row.classList.remove('loading');
          if (targetNode) {
            lockAndCenter(targetNode);
          } else {
            if (idx === 0) {
              scroller.scrollTop = 0;
            }
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
            let activeIdx = 0;
            for (let i = 0; i < steps.length; i++) {
              const rect = steps[i].getBoundingClientRect();
              if (rect.top <= scrollerRect.top + 220) {
                activeIdx = i;
              }
            }
            document.querySelectorAll('.ag-minimap-row').forEach((r, i) => {
              r.classList.toggle('active', i === activeIdx);
            });
            document.querySelectorAll('.ag-minimap-tick').forEach((t, i) => {
              t.classList.toggle('active', i === activeIdx);
            });
          });
        }, { passive: true });
      }

      // 3. 对标 Gemini 网页版：增强并本地化所有原生消息工具栏的分叉按钮文案与菜单
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
