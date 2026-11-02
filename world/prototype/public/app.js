const W = 40;
const H = 40;
const TS = 16;

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const clockEl = document.getElementById('clock');
const popEl = document.getElementById('pop');
const logEl = document.getElementById('log');
const agentInfoEl = document.getElementById('agentInfo');
const pauseBtn = document.getElementById('pauseBtn');
const hintEl = document.getElementById('hint');
const whisperForm = document.getElementById('whisperForm');
const whisperInput = document.getElementById('whisperInput');
const whisperBtn = whisperForm.querySelector('button');
const configForm = document.getElementById('configForm');
const brainStatus = document.getElementById('brainStatus');

const TILE_COLORS = ['#16232b', '#2b3630', '#1f2f25', '#3c3c39', '#4b3d34', '#33452b'];

let state = null;
let selectedId = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  if (!state) return;

  // 地形
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = state.map.charCodeAt(y * W + x) - 48;
      ctx.fillStyle = TILE_COLORS[t] || '#000';
      ctx.fillRect(x * TS, y * TS, TS, TS);
    }
  }

  // 夜
  if (state.isNight) {
    ctx.fillStyle = 'rgba(3,7,18,0.46)';
    ctx.fillRect(0, 0, W * TS, H * TS);
  }

  // 建筑
  for (const s of state.structures) drawStructure(s);

  // 野兽
  for (const w of state.wolves) drawWolf(w);

  // 人
  for (const a of state.agents) {
    if (a.alive) drawAgent(a);
  }
}

function drawStructure(s) {
  const cx = s.x * TS + TS / 2;
  const cy = s.y * TS + TS / 2;

  if (s.type === 'fire') {
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
    g.addColorStop(0, 'rgba(224,145,63,0.55)');
    g.addColorStop(1, 'rgba(224,145,63,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e0913f';
    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (s.type === 'shelter') {
    ctx.fillStyle = '#5a4632';
    ctx.fillRect(s.x * TS + 3, s.y * TS + 4, TS - 6, TS - 8);
    ctx.fillStyle = '#2a2118';
    ctx.fillRect(s.x * TS + 7, s.y * TS + 9, 3, TS - 13);
    return;
  }

  if (s.type === 'wall') {
    ctx.fillStyle = '#4a4a45';
    ctx.fillRect(s.x * TS + 1, s.y * TS + 1, TS - 2, TS - 2);
    return;
  }

  if (s.type === 'grave') {
    ctx.strokeStyle = '#6a5f52';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, s.y * TS + 4);
    ctx.lineTo(cx, s.y * TS + 13);
    ctx.moveTo(cx - 4, s.y * TS + 7);
    ctx.lineTo(cx + 4, s.y * TS + 7);
    ctx.stroke();
    return;
  }

  if (s.type === 'camp') {
    ctx.strokeStyle = 'rgba(150,130,96,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawWolf(w) {
  const cx = w.x * TS + TS / 2;
  const cy = w.y * TS + TS / 2;
  ctx.fillStyle = '#b04a42';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 6);
  ctx.lineTo(cx + 6, cy + 5);
  ctx.lineTo(cx - 6, cy + 5);
  ctx.closePath();
  ctx.fill();
}

function drawAgent(a) {
  const cx = a.x * TS + TS / 2;
  const cy = a.y * TS + TS / 2;

  if (a.id === selectedId) {
    ctx.strokeStyle = '#f0e6c8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = a.color;
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const f = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[a.facing] || [0, 1];
  ctx.strokeStyle = 'rgba(216,211,196,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + f[0] * 9, cy + f[1] * 9);
  ctx.stroke();

  const label = a.name;
  ctx.font = '10px "Noto Sans SC", "PingFang SC", sans-serif';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(8,11,9,0.72)';
  ctx.fillRect(cx - tw / 2 - 3, cy - 19, tw + 6, 12);
  ctx.fillStyle = a.alive ? '#d8d3c4' : '#7d877f';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy - 13);
}

function bar(label, value, cls) {
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${Math.max(0, Math.min(100, value))}%"></div></div></div>`;
}

function updateUI() {
  if (!state) return;

  clockEl.textContent = `第 ${state.day} 天 · ${state.clock}${state.isNight ? ' · 夜' : ''}`;
  popEl.textContent = `活着 ${state.population} / ${state.agents.length}`;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';

  if (brainStatus) {
    brainStatus.textContent = state.apiConfigured
      ? `当前：${state.llmAgents}/${state.agents.length} 人由你的模型驱动 · 已调用 ${state.llmCalls} 次${state.llmErrors ? ` · 失败 ${state.llmErrors}` : ''}`
      : '当前：规则驱动（未配置 API）。';
  }

  document.querySelectorAll('.speed').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === state.speed);
  });

  logEl.innerHTML = state.log
    .slice(-30)
    .reverse()
    .map((e) => `<li class="${e.type}"><span class="t">${e.day}日 ${e.clock}</span>${escapeHtml(e.text)}</li>`)
    .join('');

  const a = state.agents.find((x) => x.id === selectedId);
  const alive = a && a.alive;

  whisperInput.disabled = !alive;
  whisperBtn.disabled = !alive;

  if (!a) {
    agentInfoEl.className = 'muted';
    agentInfoEl.textContent = '还没有选中任何人。点地图上的一个人。';
    return;
  }

  agentInfoEl.className = '';
  agentInfoEl.innerHTML = `
    <div class="agent-head">
      <span class="dot" style="background:${a.color}"></span>
      <b>${escapeHtml(a.name)}</b>
      ${a.useLLM ? '<span class="badge">LLM</span>' : ''}
      ${!a.alive ? '<span class="badge" style="color:#d98b82;border-color:#5a3a36">已死</span>' : ''}
    </div>
    <div class="tags">
      <b>出身</b> ${escapeHtml(a.tags.origin)}<br>
      <b>执念</b> ${escapeHtml(a.tags.obsession)}<br>
      <b>禀赋</b> ${escapeHtml(a.tags.aptitude)}<br>
      <b>旧伤</b> ${escapeHtml(a.tags.wound)}
    </div>
    ${bar('生命', a.hp, 'hp')}
    ${bar('饱食', a.hunger, 'hunger')}
    ${bar('体力', a.energy, 'energy')}
    <div class="inv">食物 ${a.inventory.food} · 木头 ${a.inventory.wood} · 石头 ${a.inventory.stone}${a.inventory.weapon ? ' · 有武器' : ''}</div>
    ${a.lastSay ? `<div class="say">「${escapeHtml(a.lastSay)}」</div>` : ''}
    ${a.letter ? `<div class="say" style="border-color:#6a4a7a">祖先的声音：${escapeHtml(a.letter)}</div>` : ''}
    <div class="mem"><div class="mem-title">个人史 · 最近 ${a.memory.length} 条</div>${a.memory
      .map((m) => `<div>· ${escapeHtml(m)}</div>`)
      .join('')}</div>
    ${a.trace && a.trace.length
      ? `<div class="trace"><div class="mem-title">最后 ${a.trace.length} 步</div>${a.trace
          .slice()
          .reverse()
          .map((t) => `<div>· 第${t.t}刻 (${t.x},${t.y}) ${escapeHtml(t.note)}</div>`)
          .join('')}</div>`
      : ''}
  `;
}

canvas.addEventListener('click', (e) => {
  if (!state) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) * (canvas.width / rect.width)) / TS;
  const y = ((e.clientY - rect.top) * (canvas.height / rect.height)) / TS;

  let best = null;
  let bd = 1e9;
  for (const a of state.agents) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x + 0.5 - x, a.y + 0.5 - y);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  if (best && bd < 1.5) {
    selectedId = best.id;
    hintEl.style.display = 'none';
    updateUI();
  }
});

pauseBtn.addEventListener('click', async () => {
  if (!state) return;
  await fetch('/api/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !state.paused }),
  });
});

document.querySelectorAll('.speed').forEach((btn) => {
  btn.addEventListener('click', () => {
    fetch('/api/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: Number(btn.dataset.speed) }),
    });
  });
});

whisperForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedId) return;
  const text = whisperInput.value.trim();
  if (!text) return;
  await fetch('/api/whisper', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: selectedId, text }),
  });
  whisperInput.value = '';
});

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(configForm);
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: fd.get('provider'),
      base: fd.get('base'),
      key: fd.get('key'),
      model: fd.get('model'),
      llmAgents: Number(fd.get('llmAgents')) || 0,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    const btn = configForm.querySelector('button');
    btn.textContent = data.configured ? `已保存 · ${data.llmAgents} 人` : '已保存（规则模式）';
    setTimeout(() => (btn.textContent = '保存'), 1800);
  }
});

const es = new EventSource('/stream');
es.onmessage = (e) => {
  try {
    state = JSON.parse(e.data);
    render();
    updateUI();
  } catch {
    /* ignore malformed frame */
  }
};

es.onerror = () => {
  hintEl.textContent = '连接断开了，正在重连…';
  hintEl.style.display = 'block';
};
