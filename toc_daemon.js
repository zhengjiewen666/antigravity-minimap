const fs = require('fs');
const path = require('path');
const net = require('net');

// 单实例锁，防止多开
const lockServer = net.createServer();
lockServer.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
  }
});
lockServer.listen(48899, '127.0.0.1');

let lastConvId = null;
let lastPromptsHash = '';
let ws = null;
let reconnectTimer = null;

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
      console.log('Rock-solid Minimap Daemon connected');
      lastConvId = null;
      lastPromptsHash = '';
      loopSync();
    };

    ws.onclose = () => {
      scheduleReconnect();
    };

    ws.onerror = () => {
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
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('WS not open'));
    const id = Math.floor(Math.random() * 1000000);
    const onMsg = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          resolve(msg.result);
        }
      } catch (e) {}
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('Timeout'));
    }, 4000);
  });
}

async function loopSync() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const res = await sendCDP('Runtime.evaluate', {
      expression: 'window.location.pathname',
      returnByValue: true
    });
    const pathname = res?.result?.value || '';
    const m = pathname.match(/\/c\/([a-f0-9\-]+)/);
    const convId = m ? m[1] : null;

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
              allPrompts.push({
                text: content
              });
            }
          } catch (e) {}
        }
      }

      const hash = convId + '_' + JSON.stringify(allPrompts.map(p => p.text));
      if (hash !== lastPromptsHash) {
        lastConvId = convId;
        lastPromptsHash = hash;
        console.log(`[${new Date().toLocaleTimeString()}] Rendered ${allPrompts.length} prompts for conv: ${convId}`);

        await renderCleanMinimap(allPrompts);
      }
    } else {
      // 不在会话页面时隐藏刻度条
      await sendCDP('Runtime.evaluate', {
        expression: `(() => { const r = document.getElementById('ag-minimap-root'); if (r) r.style.display = 'none'; })()`
      });
    }
  } catch (e) {
    // ignore
  }

  setTimeout(loopSync, 1500);
}

async function renderCleanMinimap(prompts) {
  const code = `
    (() => {
      const promptsData = ${JSON.stringify(prompts)};

      // 1. 样式表
      let style = document.getElementById('ag-minimap-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'ag-minimap-style';
        document.head.appendChild(style);
      }
      style.textContent = \`
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

        /* 鼠标没放上去时：绝对隐藏，禁止显示任何文字 */
        #ag-minimap-card {
          display: none !important;
          position: absolute;
          right: 32px;
          top: 50%;
          transform: translateY(-50%);
          width: 330px;
          max-height: 480px;
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
          max-height: 400px;
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
          padding: 8px 12px;
          font-size: 12.5px;
          line-height: 1.4;
          border-radius: 8px;
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          display: flex;
          align-items: center;
          gap: 8px;
          box-sizing: border-box;
          width: 100%;
          transition: all 0.12s ease;
          color: #94a3b8;
          opacity: 0.65;
          background: transparent;
          border-left: 3px solid transparent;
        }

        /* 选中行/当前悬停行：颜色深、加重底色、纯白明亮高亮 */
        .ag-minimap-row:hover, .ag-minimap-row.active {
          color: #ffffff !important;
          opacity: 1 !important;
          background: rgba(74, 222, 128, 0.18) !important;
          border-left: 3px solid #4ade80 !important;
          padding-left: 14px;
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
      \`;

      // 2. 根结构
      let root = document.getElementById('ag-minimap-root');
      if (root) root.remove();

      root = document.createElement('div');
      root.id = 'ag-minimap-root';

      const card = document.createElement('div');
      card.id = 'ag-minimap-card';
      card.innerHTML = \`
        <div class="ag-minimap-card-header">
          <span>本会话提问目录 (点击精准跳转)</span>
          <span class="ag-minimap-card-badge">\${promptsData.length} 轮提问</span>
        </div>
        <div id="ag-minimap-items" class="ag-minimap-card-list"></div>
      \`;

      const bar = document.createElement('div');
      bar.id = 'ag-minimap-bar';

      root.appendChild(card);
      root.appendChild(bar);
      document.body.appendChild(root);

      const listEl = card.querySelector('#ag-minimap-items');

      // 精准寻找聊天主滚动容器（坚决排除输入框和左侧栏）
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

        // 远距离 (大跨度 > 750px) 采用极速直接跳转 ('auto')，杜绝大长屏慢速滚动的掉帧与卡顿；
        // 近距离 (<= 750px) 采用丝滑平滑滚动 ('smooth')。
        const behavior = distance > 750 ? 'auto' : 'smooth';
        node.scrollIntoView({ behavior, block: 'center' });
        pulseHighlight(node);

        // 250ms 后单次微调复核（防止异步图片或代码块渲染产生的布局漂移），不再循环打断
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
        row.innerHTML = \`
          <span class="ag-minimap-row-idx">#\${idx + 1}</span>
          <span class="ag-minimap-row-text">\${item.text}</span>
        \`;

        function highlight() {
          document.querySelectorAll('.ag-minimap-row').forEach(r => r.classList.remove('active'));
          document.querySelectorAll('.ag-minimap-tick').forEach(t => t.classList.remove('active'));
          row.classList.add('active');
          tick.classList.add('active');
        }
        row.addEventListener('mouseenter', highlight);
        tick.addEventListener('mouseenter', highlight);

        // 核心跳转函数：解决未加载历史、Lexical回弹与精准居中锚定
        async function jump(e) {
          e.stopPropagation();
          window.__minimapIsJumping = true;

          // 1. 彻底移走输入框焦点，阻断底层 Lexical 编辑器将视口弹回底部
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          try { window.getSelection()?.removeAllRanges(); } catch (err) {}

          const scroller = getChatScroller();
          if (!scroller) return;

          const total = promptsData.length;

          // 最底部的最新语句：直接滚到底部
          if (idx === total - 1) {
            scroller.scrollTop = scroller.scrollHeight;
            setTimeout(() => {
              const steps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
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
            const query = (item.text || '').trim().slice(0, 15);
            let match = steps.find(s => {
              const txt = s.innerText || '';
              return (query && txt.includes(query)) || (item.text.length > 4 && txt.includes(item.text.slice(0, 8)));
            });
            if (!match && steps.length === total && steps[idx]) {
              match = steps[idx];
            }
            return match;
          }

          let targetNode = findTarget();
          if (targetNode) {
            lockAndCenter(targetNode);
            return;
          }

          // 如果还没渲染到 DOM 中（由于尚未加载更早的历史记录），自动循环触发加载更早消息，直到目标出现
          for (let round = 0; round < 10; round++) {
            scroller.scrollTop = 0;
            const loadBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Load older messages'));
            if (loadBtn) {
              loadBtn.click();
              loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            scroller.dispatchEvent(new Event('scroll'));

            // 等待数据加载并轮询检测（最多等待 2.4 秒，每 150ms 检查一次）
            for (let wait = 0; wait < 16; wait++) {
              await new Promise(r => setTimeout(r, 150));
              targetNode = findTarget();
              if (targetNode) {
                lockAndCenter(targetNode);
                return;
              }
            }

            // 检查是否还有加载按钮
            const stillHasBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Load older messages'));
            if (!stillHasBtn) {
              const allSteps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
              const fallback = allSteps[idx] || (idx === 0 ? allSteps[0] : allSteps[allSteps.length - 1]);
              if (fallback) {
                lockAndCenter(fallback);
              } else {
                window.__minimapIsJumping = false;
              }
              return;
            }
          }
          window.__minimapIsJumping = false;
        }

        tick.onclick = jump;
        row.onclick = jump;

        bar.appendChild(tick);
        listEl.appendChild(row);
      });

      if (bar.lastElementChild) bar.lastElementChild.classList.add('active');
      if (listEl.lastElementChild) listEl.lastElementChild.classList.add('active');

      // 监听用户在聊天窗口中自行滚动，自动高亮右侧对应刻度
      const scroller = getChatScroller();
      if (scroller && !scroller.__minimapScrollBound) {
        scroller.__minimapScrollBound = true;
        let lastScrollCheck = 0;
        let ticking = false;

        scroller.addEventListener('scroll', () => {
          // 跳转执行期间完全跳过监听，避免强制布局重排产生卡顿
          if (window.__minimapIsJumping) return;

          const now = Date.now();
          if (now - lastScrollCheck < 120) return; // 120ms 节流，消除滚动时的强制重排卡顿
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

      // 4. 静默后台自动预加载（彻底消除跳转等待，实现瞬发直达）
      function startSilentPreload() {
        if (window.__preloadActive) return;
        window.__preloadActive = true;

        async function loop() {
          while (true) {
            if (window.__minimapIsJumping) {
              await new Promise(r => setTimeout(r, 400));
              continue;
            }
            const loadBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Load older messages'));
            if (!loadBtn) {
              window.__preloadActive = false;
              break;
            }
            // 静默触发拉取历史消息，完全不触碰滚动条位置，用户零感知
            loadBtn.click();
            loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 550));
          }
        }
        loop().catch(() => { window.__preloadActive = false; });
      }

      // 页面加载或切换会话时，立即在后台静默预热拉取
      startSilentPreload();

      // 鼠标悬停小地图区域时，若尚未加载完则高优先级积极预加载
      root.addEventListener('mouseenter', startSilentPreload, { passive: true });
    })()
  `;

  await sendCDP('Runtime.evaluate', { expression: code });
}

connect();
