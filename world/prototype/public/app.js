const W = 40;
const H = 40;
const TS = 16;

const $ = (id) => document.getElementById(id);

const canvas = $('map');
const ctx = canvas.getContext('2d');
const clockEl = $('clock');
const popEl = $('pop');
const syncStatusEl = $('syncStatus');
const logEl = $('log');
const agentInfoEl = $('agentInfo');
const pauseBtn = $('pauseBtn');
const hintEl = $('hint');
const whisperForm = $('whisperForm');
const whisperInput = $('whisperInput');
const whisperBtn = whisperForm.querySelector('button');
const whisperNote = $('whisperNote');
const configForm = $('configForm');
const brainStatus = $('brainStatus');
const modesEl = $('modes');
const followBadge = $('followBadge');
const tlDays = $('tlDays');
const tlNow = $('tlNow');
const returnPanel = $('returnPanel');
const returnBody = $('returnBody');
const dismissReturnBtn = $('dismissReturn');
const islandPanel = $('islandPanel');
const selectedPanel = $('selectedPanel');
const islandBody = $('islandBody');
const langBtn = $('langBtn');
const chronicleRange = $('chronicleRange');
const chronicleBody = $('chronicleBody');
const narrateBtn = $('narrateBtn');
const todayBtn = $('todayBtn');
const exportBtn = $('exportBtn');
const arrivalBtn = $('arrivalBtn');
const arrivalDialog = $('arrivalDialog');
const arrivalForm = $('arrivalForm');
const arrivalNote = $('arrivalNote');
const arrivalNotice = $('arrivalNotice');
const arrivalClose = $('arrivalClose');
const arrivalSubmit = $('arrivalSubmit');

const TILE_COLORS = ['#16232b', '#2b3630', '#1f2f25', '#3c3c39', '#4b3d34', '#33452b'];

const SOURCE_LABEL = {
  self: '亲身',
  sight: '亲眼',
  hearsay: '转述',
  inherited: '继承',
  doctrine: '教义',
  relationship: '关系',
  death: '死亡',
  letter: '祖先的声音',
};

const FACT_LABEL = {
  death: '死亡',
  turning: '脱变',
  teach: '教学',
  talk: '交谈',
  adopt: '收养',
  institution: '制度',
  punish: '违规',
  fight: '冲突',
  build: '建造',
  craft: '制造',
  gather: '采集',
  fish: '捕鱼',
  plant: '耕种',
  rest: '休息',
  settle: '搬入',
  inherit: '继承',
  bury: '埋葬',
  grave: '坟',
  camp: '营地',
  fade: '淡出',
};

const RESOURCE_LABEL = { food: '食物', wood: '木头', stone: '石头', weapon: '武器' };

const PARAMS = new URLSearchParams(location.search);
// 看台：只读、不写、不显示任何控制。`/?public=1` 或 `/public`。
const PUBLIC_MODE = PARAMS.has('public') || location.pathname === '/public';

// 英文界面外壳。世界文本（居民对话、编年史、制度描述）仍是中文——
// 这一层只翻译界面标签和状态，给公开看台一个可读的英文入口。
const LANG = PARAMS.get('lang') || localStorage.getItem('island-lang') || 'zh';
const EN = {
  '最后的岛': 'The Last Island',
  '垂直切片 · 十二个人在废墟上醒来': 'A vertical slice · twelve people wake on the ruins',
  跟随: 'Follow',
  全岛: 'Island',
  暂停: 'Pause',
  上传一个人: 'Bring someone',
  时间轴: 'Timeline',
  今天: 'Today',
  生成: 'Generate',
  导出这一版: 'Export this version',
  大脑: 'Mind',
  发生了什么: 'What happened',
  全岛总览: 'Island overview',
  '编年史 · 我的版本': 'Chronicle · my version',
  '还没有选中任何人。点地图上的一个人。': 'No one selected. Click someone on the map.',
  '以祖先的声音写一封信…': "Write a letter in an ancestor's voice…",
  寄出: 'Send',
  保存: 'Save',
  '不配置时，十二个人全由规则驱动，世界照常运行。配置后，前 N 个人改用你的模型思考；编年史也会由你的模型来写。':
    'Without a model all twelve are rule-driven and the world keeps running. With one, the first N think with your model, and the chronicle is written by it too.',
  出身: 'Origin',
  家乡: 'Hometown',
  执念: 'Obsession',
  禀赋: 'Aptitude',
  旧伤: 'Old wound',
  生命: 'Health',
  饱食: 'Hunger',
  体力: 'Energy',
  食物: 'Food',
  木头: 'Wood',
  石头: 'Stone',
  有武器: 'Armed',
  被记住: 'Remembered',
  '已经被世界抹去。': 'Erased by the world.',
  事实: 'Facts',
  他的看法: 'Their view',
  个人史: 'History',
  '醒着 · 有人守着': 'Awake · watched',
  '睡着 · 本能': 'Asleep · instinct',
  主人在线: 'Owner online',
  浅睡: 'Shallow sleep',
  已死: 'Dead',
  继承自: 'Inherited from',
  '从雾里走上岛 · 上传自': 'Came from the fog · uploaded by',
  活着: 'Alive',
  死去: 'Dead',
  制度: 'Institutions',
  正在淡出: 'Fading',
  语言: 'Languages',
  被记住的人: 'Remembered',
  改变过的人: 'Changed',
  从雾里来的人: 'Came from the fog',
  编年史: 'Chronicle',
  已经不在了: 'Gone',
  '还没有人死去。': 'No one has died yet.',
  '还没有制度。': 'No institutions yet.',
  '还没有值得记下的事。': 'Nothing worth recording yet.',
  '还没有人脱变。': 'No one has turned yet.',
  '还没有人上传。': 'No one has arrived yet.',
  '正在看第': 'Viewing Day ',
  '选一天，看那天发生了什么。': 'Pick a day to see what happened.',
  从雾里走上岛: 'Walk onto the island',
  关闭: 'Close',
  名字: 'Name',
  一句口吻: 'A line of voice',
  上传: 'Upload',
  '日志只追加、不可删除。请不要写任何可以辨认真实他人的信息。':
    'The journal is append-only and cannot be deleted. Do not include information that identifies a real person.',
  '主人在线 · 等提案': 'Owner online · waiting',
  主人的模型: "Owner's model",
  '浅睡 · 不会淡出': "Shallow sleep · won't fade",
  有人守着: 'Watched',
  不在了: 'Gone',
  '有人守着，不会淡出': "Watched, won't fade",
  '没人看着，按本能活着': 'Unwatched, living by instinct',
  '浅睡中，不会淡出': "Shallow sleep, won't fade",
  '主人的模型在驱动': "Driven by the owner's model",
  '主人在线，在等下一步': 'Owner online, waiting for the next move',
  渔夫: 'Fisher',
  农妇: 'Farmer',
  铁匠: 'Blacksmith',
  医生: 'Doctor',
  木匠: 'Carpenter',
  猎人: 'Hunter',
  石匠: 'Stonemason',
  教师: 'Teacher',
  小城教师: 'Town teacher',
  青年: 'Youth',
  少女: 'Girl',
  流浪者: 'Wanderer',
  体魄: 'Body',
  机敏: 'Quick',
  手艺: 'Craft',
  口才: 'Speech',
  耐心: 'Patience',
  北岸话: 'Northshore',
  南渡话: 'Southcross',
  外来话: 'Outlander',
};
const EN_RULES = [
  [/^第 (\d+) 天 · (\d{2}:\d{2})$/, 'Day $1 · $2'],
  [/^第 (\d+) 天$/, 'Day $1'],
  [/^正在看第 (\d+) 天 · 点「今天」回到现在$/, 'Viewing Day $1 · click Today to return'],
  [/^正在看第 (\d+) 天$/, 'Viewing Day $1'],
  [/^活着 (\d+) \/ (\d+)$/, 'Alive $1 / $2'],
  [/^被记住 (\d+) \/ 100$/, 'Remembered $1 / 100'],
  [/^正在淡出（(\d)\/3）$/, 'Fading ($1/3)'],
];
const EN_PARTS = [
  ['跟随：', 'Following: '],
  ['正在淡出：', 'Fading: '],
  ['被记住 ', 'Remembered '],
  [' · 正在淡出（', ' · fading ('],
  [' · 有人守着，不会淡出', " · watched, won't fade"],
  [' · 没人看着，按本能活着', ' · unwatched, living by instinct'],
  [' · 浅睡中，不会淡出', " · shallow sleep, won't fade"],
  [' · 主人的模型在驱动', " · driven by the owner's model"],
  [' · 主人在线，在等下一步', ' · owner online, waiting'],
  ['活着 ', 'Alive '],
  ['死去 ', 'Dead '],
  ['制度 ', 'Institutions '],
  ['正在淡出 ', 'Fading '],
];

function translateText(raw) {
  const text = String(raw || '').trim();
  if (!text) return raw;
  if (EN[text]) return raw.replace(text, EN[text]);
  for (const [re, replacement] of EN_RULES) {
    if (re.test(text)) return raw.replace(text, text.replace(re, replacement));
  }
  let out = text;
  for (const [from, to] of EN_PARTS) out = out.split(from).join(to);
  return out === text ? raw : raw.replace(text, out);
}

let translateQueued = false;
function translateDom() {
  if (LANG !== 'en') return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || ['SCRIPT', 'STYLE', 'CANVAS', 'OPTION'].includes(parent.tagName)) continue;
    const next = translateText(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  for (const option of document.querySelectorAll('option')) {
    if (EN[option.textContent]) option.textContent = EN[option.textContent];
  }
  for (const input of document.querySelectorAll('input[placeholder]')) {
    if (EN[input.placeholder]) input.placeholder = EN[input.placeholder];
  }
}
function scheduleTranslate() {
  if (LANG !== 'en' || translateQueued) return;
  translateQueued = true;
  requestAnimationFrame(() => {
    translateQueued = false;
    translateDom();
  });
}

let state = null;
let liveState = null;
let historyMode = false;
let readOnlyMode = PUBLIC_MODE;
let selectedId = PARAMS.get('select') || null;
let mode = PARAMS.get('mode') === 'island' ? 'island' : 'follow';
let agentTab = 'facts';
let selectedDay = null;
let timelineData = { currentDay: 1, days: [] };
let lastTimelineDay = 0;
let chronicleToken = 0;
let chronicleCacheKey = '';
let lastChronicleDay = 0;
let chronicleBusy = false;
let returnDismissed = sessionStorage.getItem('island-return-dismissed') === '1';

const VIEWER_ID = (() => {
  let id = localStorage.getItem('island-viewer-id');
  if (!id) {
    id =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `v-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('island-viewer-id', id);
  }
  return id;
})();

// ---------- 守望（在线轴） ----------
// 你跟随时，本机节点会把这个人的“清醒租约”写进日志；切走或关页面就放开。
// 只有当前日志权威能让它生效，跟随节点会返回 409，但心跳本身无害。
let lastPresenceTarget = undefined;

function currentTendTarget() {
  return mode === 'follow' && selectedId ? selectedId : null;
}

async function sendPresence(agentId, { beacon = false } = {}) {
  const payload = { viewerId: VIEWER_ID, agentId: agentId || null };
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(
        '/api/presence',
        new Blob([JSON.stringify(payload)], { type: 'application/json' })
      );
      return;
    }
    await fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // 节点短暂离线时不打扰观看。
  }
}

function syncPresence(force = false) {
  const target = currentTendTarget();
  if (!force && target === lastPresenceTarget) return;
  lastPresenceTarget = target;
  sendPresence(target);
}

setInterval(() => {
  const target = currentTendTarget();
  if (document.visibilityState === 'visible' && target) sendPresence(target);
}, 5000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    lastPresenceTarget = null;
    sendPresence(null, { beacon: true });
  } else {
    syncPresence(true);
  }
});

window.addEventListener('pagehide', () => sendPresence(null, { beacon: true }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function agentById(id) {
  return state ? state.agents.find((a) => a.id === id) : null;
}

function nameOf(id) {
  const a = agentById(id);
  return a ? a.name : '某个人';
}

function formatTicks(ticks) {
  const t = Math.max(0, Math.round(ticks));
  if (t >= 60) return `${Math.floor(t / 60)} 小时 ${t % 60} 分`;
  return `${t} 分钟`;
}

function presenceLabel(a) {
  if (!a || !a.alive) return '不在了';
  if (a.presence !== 'online') return '睡着 · 本能';
  if (a.presenceReason === 'owner-online') {
    return a.action === 'idle' ? '主人在线 · 等提案' : '主人的模型';
  }
  if (a.presenceReason === 'shallow') return '浅睡 · 不会淡出';
  return '有人守着';
}

async function refreshSyncStatus() {
  try {
    const res = await fetch('/api/identity');
    const info = await res.json();
    let text;
    let status = 'idle';
    if (info.mode === 'peer') {
      if (info.syncFault) {
        text = `同步故障：${info.syncFault}`;
        status = 'error';
      } else if (info.role === 'authority') {
        text = info.handoffReady
          ? `主节点 · 第 ${info.term} 任 · 正在写`
          : `主节点 · 第 ${info.term} 任 · 交接中`;
        status = 'ok';
      } else {
        text = `跟随中 · 第 ${info.term} 任由 ${info.authorityId} 写入`;
        status = info.lastSyncError ? 'error' : info.lastSyncAt ? 'ok' : 'idle';
      }
    } else if (info.mirror) {
      text = info.lastSyncError
        ? `镜像 · 同步中断：${info.lastSyncError}`
        : info.lastSyncAt
          ? `镜像 · 已追到第 ${info.lastSyncedTick} 刻`
          : '镜像 · 等待主节点';
      status = info.lastSyncError ? 'error' : info.lastSyncAt ? 'ok' : 'idle';
    } else if (info.peer) {
      text = info.lastSyncError
        ? `同步中断：${info.lastSyncError}`
        : info.lastSyncAt
          ? `已同步到第 ${info.lastSyncedTick} 刻`
          : '正在连接镜像';
      status = info.lastSyncError ? 'error' : info.lastSyncAt ? 'ok' : 'idle';
    } else {
      text = '单机 · 未配置同步';
    }
    readOnlyMode = PUBLIC_MODE || historyMode || info.canWrite === false;
    if (historyMode) {
      text = `历史态 · 第 ${state?.day || '?'} 天 · 只读`;
      status = 'idle';
    } else if (info.lastAdoption?.dropped > 0) {
      text += ` · 上次丢弃 ${info.lastAdoption.dropped} 条`;
      if (status === 'ok') status = 'idle';
    }
    syncStatusEl.textContent = text;
    syncStatusEl.title = `${info.nodeId} · seed ${info.seed} · ${text}${
      info.lastAdoption
        ? ` · 上次采纳：第 ${info.lastAdoption.term} 任 · 丢弃 ${info.lastAdoption.dropped} 条 · ${info.lastAdoption.via}`
        : ''
    }`;
    syncStatusEl.dataset.state = status;
    if (state) updateUI();
  } catch {
    syncStatusEl.textContent = '同步状态未知';
    syncStatusEl.dataset.state = 'error';
  }
}

// ---------- 地图 ----------

function render() {
  if (!state) return;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = state.map.charCodeAt(y * W + x) - 48;
      ctx.fillStyle = TILE_COLORS[t] || '#000';
      ctx.fillRect(x * TS, y * TS, TS, TS);
    }
  }

  if (state.isNight) {
    ctx.fillStyle = 'rgba(3,7,18,0.46)';
    ctx.fillRect(0, 0, W * TS, H * TS);
  }

  for (const s of state.structures) drawStructure(s);
  for (const w of state.wolves) drawWolf(w);
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

// ---------- 跟随 ----------

function lineageChain(a) {
  const byId = new Map(state.agents.map((x) => [x.id, x]));
  const up = [];
  const seen = new Set([a.id]);
  let cur = a;
  while (cur.mentorId && !seen.has(cur.mentorId)) {
    seen.add(cur.mentorId);
    cur = byId.get(cur.mentorId);
    if (!cur) break;
    up.unshift(cur);
  }

  const down = [];
  const seenDown = new Set([a.id]);
  cur = a;
  while (cur.heirId && !seenDown.has(cur.heirId)) {
    seenDown.add(cur.heirId);
    cur = byId.get(cur.heirId);
    if (!cur) break;
    down.push(cur);
  }
  return [...up, a, ...down];
}

function renderLineage(a) {
  const chain = lineageChain(a);
  if (chain.length === 1) {
    return `<div class="lineage"><span class="empty">还没有师承或继承人。</span></div>`;
  }
  const parts = chain.map((x) => {
    const cls = x.id === a.id ? 'me' : x.alive ? '' : 'dead';
    return `<span class="${cls}">${escapeHtml(x.name)}</span>`;
  });
  return `<div class="lineage">${parts.join('<span class="arrow">→</span>')}</div>`;
}

function bar(label, value, cls) {
  return `<div class="bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${Math.max(0, Math.min(100, value))}%"></div></div></div>`;
}

function agentFacts(a) {
  return (state.facts || [])
    .filter((f) => f.subjectId === a.id || f.targetId === a.id || f.killerId === a.id)
    .slice(-10)
    .reverse();
}

function tabBody(a) {
  if (agentTab === 'beliefs') {
    if (!a.beliefs.length) return `<div class="tab-body"><span class="empty">还没有形成任何看法。</span></div>`;
    return `<div class="tab-body">${a.beliefs
      .slice()
      .reverse()
      .map(
        (b) =>
          `<div class="row">${escapeHtml(b.proposition)}<span class="conf">${Math.round(
            (b.confidence ?? 0) * 100
          )}%</span><span class="src">${escapeHtml(SOURCE_LABEL[b.source] || b.source || '')}</span></div>`
      )
      .join('')}</div>`;
  }

  if (agentTab === 'memory') {
    if (!a.memory.length) return `<div class="tab-body"><span class="empty">还没有记住什么。</span></div>`;
    return `<div class="tab-body">${a.memory
      .slice()
      .reverse()
      .map((m) => `<div class="row">· ${escapeHtml(m)}</div>`)
      .join('')}</div>`;
  }

  const facts = agentFacts(a);
  if (!facts.length) return `<div class="tab-body"><span class="empty">最近没有关于他的事实。</span></div>`;
  return `<div class="tab-body">${facts
    .map((f) => {
      const label = FACT_LABEL[f.type] || f.type;
      let detail = typeof f.object === 'string' ? f.object : '';
      if (f.type === 'teach') {
        detail =
          state.labels?.knowledge?.[f.object] ||
          state.labels?.skills?.[f.object] ||
          state.labels?.languages?.[f.object] ||
          f.object;
      } else if (f.type === 'gather' || f.type === 'fish') {
        detail = RESOURCE_LABEL[detail] || detail;
      } else if (f.type === 'build' || f.type === 'craft') {
        detail = state.labels?.skills?.[detail] || detail;
      } else if (f.type === 'adopt' || /^[a-z]\d+$/.test(detail)) {
        detail = '';
      }
      return `<div class="row">第 ${f.day} 天 · ${escapeHtml(label)}${
        detail ? ` · ${escapeHtml(detail)}` : ''
      }</div>`;
    })
    .join('')}</div>`;
}

function renderAgentPanel() {
  const a = agentById(selectedId);
  const alive = a && a.alive;

  whisperInput.disabled = readOnlyMode || !alive || (a && a.letterCooldownLeft > 0);
  whisperBtn.disabled = whisperInput.disabled;

  if (!a) {
    agentInfoEl.className = 'muted';
    agentInfoEl.textContent = '还没有选中任何人。点地图上的一个人。';
    whisperNote.textContent = '';
    return;
  }

  agentInfoEl.className = '';
  agentInfoEl.innerHTML = `
    <div class="agent-head">
      <span class="dot" style="background:${a.color}"></span>
      <b>${escapeHtml(a.name)}</b>
      ${a.useLLM ? '<span class="badge">LLM</span>' : ''}
      ${
        a.alive
          ? a.presence === 'online'
            ? a.presenceReason === 'owner-online'
              ? '<span class="badge" style="color:#9fd39a;border-color:#3f5a3a">主人在线</span>'
              : a.presenceReason === 'shallow'
                ? '<span class="badge" style="color:#c9b26a;border-color:#5a503a">浅睡</span>'
                : '<span class="badge" style="color:#9fd39a;border-color:#3f5a3a">醒着 · 有人守着</span>'
            : '<span class="badge" style="color:#b9b2a0;border-color:#4a4a44">睡着 · 本能</span>'
          : ''
      }
      ${!a.alive ? '<span class="badge" style="color:#d98b82;border-color:#5a3a36">已死</span>' : ''}
      ${a.identity ? `<span class="badge">${escapeHtml(a.identity)}</span>` : ''}
    </div>
    ${renderLineage(a)}
    ${a.inheritedFrom ? `<div class="lineage">继承自 <span class="me">${escapeHtml(a.inheritedFrom)}</span></div>` : ''}
    ${a.arrivedBy ? `<div class="lineage">从雾里走上岛 · 上传自 <span class="me">${escapeHtml(a.arrivedBy)}</span></div>` : ''}
    <div class="tags">
      <b>出身</b> ${escapeHtml(a.tags.origin)} · <b>家乡</b> ${escapeHtml(a.tags.hometown || '')}<br>
      <b>执念</b> ${escapeHtml(a.tags.obsession)}<br>
      <b>禀赋</b> ${escapeHtml(a.tags.aptitude)}<br>
      <b>旧伤</b> ${escapeHtml(a.tags.wound)}
    </div>
    ${bar('生命', a.hp, 'hp')}
    ${bar('饱食', a.hunger, 'hunger')}
    ${bar('体力', a.energy, 'energy')}
    <div class="inv">食物 ${a.inventory.food} · 木头 ${a.inventory.wood} · 石头 ${a.inventory.stone}${
      a.inventory.weapon ? ' · 有武器' : ''
    }</div>
    <div class="remembrance">${
      a.faded
        ? '<span class="gone">已经被世界抹去。</span>'
        : `被记住 <b>${a.remembrance}</b> / 100${
            a.fadeStage ? ` <span class="low">· 正在淡出（${a.fadeStage}/3）</span>` : ''
          }${
            a.presence === 'online'
              ? a.presenceReason === 'owner-online'
                ? a.action === 'idle'
                  ? ' · 主人在线，在等下一步'
                  : ' · 主人的模型在驱动'
                : a.presenceReason === 'shallow'
                  ? ' · 浅睡中，不会淡出'
                  : ' · 有人守着，不会淡出'
              : ' · 没人看着，按本能活着'
          }`
    }</div>
    ${
      !PUBLIC_MODE && !historyMode && a.arrivedBy && a.alive
        ? `<button type="button" class="shallow-btn" data-shallow="${escapeHtml(a.id)}">浅睡一天（自费）</button>`
        : ''
    }
    ${
      !PUBLIC_MODE && !historyMode && a.alive
        ? `<button type="button" class="shallow-btn report" data-report="${escapeHtml(a.id)}">举报</button>`
        : ''
    }
    ${a.turningPoints.length
      ? `<div class="turning-list">${a.turningPoints
          .slice(-3)
          .reverse()
          .map(
            (t) =>
              `<div>第 ${t.day} 天 · ${escapeHtml(t.label)} <span class="r">${escapeHtml(
                t.reason || ''
              )}</span></div>`
          )
          .join('')}</div>`
      : ''}
    ${a.lastSay ? `<div class="say">「${escapeHtml(a.lastSay)}」</div>` : ''}
    ${a.letter ? `<div class="say" style="border-color:#6a4a7a">祖先的声音：${escapeHtml(a.letter)}</div>` : ''}
    <div class="agent-tabs">
      <button data-tab="facts" class="${agentTab === 'facts' ? 'active' : ''}">事实</button>
      <button data-tab="beliefs" class="${agentTab === 'beliefs' ? 'active' : ''}">他的看法</button>
      <button data-tab="memory" class="${agentTab === 'memory' ? 'active' : ''}">个人史</button>
    </div>
    ${tabBody(a)}
  `;

  if (!alive) {
    whisperNote.textContent = '他已经不在了。';
  } else if (a.letterCooldownLeft > 0) {
    whisperNote.textContent = `祖先的声音要等一等：约 ${formatTicks(a.letterCooldownLeft)}后。`;
  } else if (whisperNote.textContent.startsWith('祖先的声音要等一等')) {
    whisperNote.textContent = '';
  }
}

// ---------- 全岛 ----------

function renderIslandPanel() {
  if (!state) return;
  const alive = state.agents.filter((a) => a.alive);
  const dead = state.agents.filter((a) => !a.alive);
  const remembered = alive
    .slice()
    .sort((a, b) => b.remembrance - a.remembrance)
    .slice(0, 5);
  const fading = alive.filter((a) => a.fadeStage > 0);

  const langCount = {};
  for (const a of alive) {
    for (const key of Object.keys(a.languages || {})) {
      if (a.languages[key]) langCount[key] = (langCount[key] || 0) + 1;
    }
  }
  const langs = Object.entries(langCount)
    .map(([k, n]) => `${escapeHtml(state.labels?.languages?.[k] || k)} ${n}`)
    .join(' · ');

  const institutions = state.institutions.length
    ? state.institutions
        .slice()
        .reverse()
        .map(
          (i) =>
            `<div class="row">${escapeHtml(i.description)}${i.members?.length ? ` · ${i.members.length} 人` : ''}</div>`
        )
        .join('')
    : '<div class="row">还没有制度。</div>';

  const turned = alive
    .filter((a) => a.turningPoints?.length)
    .sort(
      (a, b) =>
        (b.turningPoints[b.turningPoints.length - 1]?.day || 0) -
        (a.turningPoints[a.turningPoints.length - 1]?.day || 0)
    )
    .slice(0, 6);
  const arrived = alive.filter((a) => a.arrivedBy);

  const chronicle = state.chronicle.length
    ? state.chronicle
        .slice(-6)
        .reverse()
        .map(
          (c) =>
            `<div class="row"><span class="t">第 ${c.day} 天</span> ${escapeHtml(
              c.agentId ? nameOf(c.agentId) : ''
            )} ${escapeHtml(c.label || c.kind)}</div>`
        )
        .join('')
    : '<div class="row">还没有值得记下的事。</div>';

  islandBody.innerHTML = `
    <div class="island-grid">
      <div>活着 <b>${alive.length}</b></div>
      <div>死去 <b>${dead.length}</b></div>
      <div>制度 <b>${state.institutions.filter((i) => i.active).length}</b></div>
      <div>正在淡出 <b>${fading.length}</b></div>
    </div>
    <div class="island-section">
      <div class="sub">语言</div>
      <div class="row">${langs || '—'}</div>
    </div>
    <div class="island-section">
      <div class="sub">被记住的人</div>
      ${remembered
        .map(
          (a) =>
            `<div class="row"><span class="who">${escapeHtml(a.name)}</span> · ${a.remembrance}${
              a.fadeStage ? ` · 淡出 ${a.fadeStage}/3` : ''
            } · ${escapeHtml(presenceLabel(a))}</div>`
        )
        .join('')}
      ${fading.length ? `<div class="row">正在淡出：${fading.map((a) => escapeHtml(a.name)).join('、')}</div>` : ''}
    </div>
    <div class="island-section">
      <div class="sub">改变过的人</div>
      ${
        turned.length
          ? turned
              .map((a) => {
                const t = a.turningPoints[a.turningPoints.length - 1];
                return `<div class="row"><span class="who">${escapeHtml(a.name)}</span> · 第 ${t.day} 天 · ${escapeHtml(
                  t.label || ''
                )}</div>`;
              })
              .join('')
          : '<div class="row">还没有人脱变。</div>'
      }
    </div>
    <div class="island-section">
      <div class="sub">从雾里来的人</div>
      ${
        arrived.length
          ? arrived
              .map(
                (a) =>
                  `<div class="row"><span class="who">${escapeHtml(a.name)}</span> · 上传自 ${escapeHtml(
                    a.arrivedBy
                  )} · ${escapeHtml(presenceLabel(a))}</div>`
              )
              .join('')
          : '<div class="row">还没有人上传。</div>'
      }
    </div>
    <div class="island-section">
      <div class="sub">制度</div>
      ${institutions}
    </div>
    <div class="island-section">
      <div class="sub">编年史</div>
      ${chronicle}
    </div>
    <div class="island-section">
      <div class="sub">已经不在了</div>
      <div class="row">${dead.length ? dead.map((a) => escapeHtml(a.name)).join('、') : '还没有人死去。'}</div>
    </div>
  `;
}

// ---------- 时间轴与编年史 ----------

function renderTimeline() {
  if (!state) return;
  const current = currentDay();
  const byDay = new Map((timelineData.days || []).map((d) => [d.day, d]));

  tlNow.textContent = selectedDay
    ? `正在看第 ${selectedDay} 天 · 点「今天」回到现在`
    : `正在看第 ${current} 天`;
  const chips = [];
  for (let d = 1; d <= current; d++) {
    const info = byDay.get(d);
    const dashes = info
      ? [
          info.deaths ? '<span class="dash death"></span>' : '',
          info.turnings ? '<span class="dash turning"></span>' : '',
          info.institutions ? '<span class="dash institution"></span>' : '',
          info.conflicts ? '<span class="dash conflict"></span>' : '',
        ].join('')
      : '';
    const classes = ['tl-day'];
    if (selectedDay === d) classes.push('active');
    if (d === current) classes.push('today');
    chips.push(
      `<button class="${classes.join(' ')}" data-day="${d}"><div class="n">第 ${d} 天</div><div class="dashes">${dashes}</div></button>`
    );
  }
  tlDays.innerHTML = chips.join('');
  tlDays.querySelectorAll('.tl-day').forEach((btn) => {
    btn.addEventListener('click', () => selectDay(Number(btn.dataset.day)));
  });

  const focus = tlDays.querySelector('.tl-day.active') || tlDays.querySelector('.tl-day.today');
  if (focus) {
    requestAnimationFrame(() => {
      focus.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
  }
}

async function fetchTimeline() {
  try {
    const res = await fetch('/api/timeline');
    const data = await res.json();
    timelineData = { currentDay: data.currentDay || 1, days: data.days || [] };
    renderTimeline();
  } catch {
    /* keep the old timeline */
  }
}

async function enterHistory(day) {
  if (!liveState) return;
  try {
    const res = await fetch(`/api/history?day=${day}`);
    const snap = await res.json();
    if (!res.ok || snap.ok === false) throw new Error(snap.error || `HTTP ${res.status}`);
    historyMode = true;
    readOnlyMode = true;
    state = snap;
    document.body.classList.add('history-mode');
    render();
    updateUI();
  } catch (err) {
    chronicleBody.textContent = `看不了那一天：${String(err?.message || err)}`;
  }
}

function exitHistory() {
  if (!historyMode) return;
  historyMode = false;
  readOnlyMode = PUBLIC_MODE;
  if (liveState) state = liveState;
  document.body.classList.remove('history-mode');
  render();
  updateUI();
}

function selectDay(day) {
  selectedDay = day;
  renderTimeline();
  loadChronicle(day, day);
  if (day >= currentDay()) exitHistory();
  else enterHistory(day);
}

// 始终返回“现在”的世界日，历史视图下也不变。
function currentDay() {
  return (liveState && liveState.day) || (state && state.day) || 1;
}

function renderChronicle(data) {
  const facts = data.facts || [];
  const source = data.model
    ? data.fallback
      ? '模型没有回应，用的是本地叙事'
      : '你的模型写的版本'
    : '本地叙事（没有配置模型）';
  const factLines = facts.length
    ? facts
        .map(
          (f) =>
            `<div class="fact"><span class="t">${f.day}日 ${escapeHtml(f.clock || '')}</span>${escapeHtml(
              f.text
            )}</div>`
        )
        .join('')
    : '<div class="fact">这一段时间没有关键事件。</div>';

  chronicleBody.className = '';
  chronicleBody.innerHTML = `
    <div class="source">${escapeHtml(source)}${data.cached ? ' · 已缓存' : ''}</div>
    <div class="narrative">${escapeHtml(data.narrative || '')}</div>
    <div class="source">那天的事实 · ${facts.length} 条</div>
    ${factLines}
  `;
}

async function loadChronicle(fromDay, toDay, { force = false } = {}) {
  const key = `${fromDay}-${toDay}`;
  if (!force && key === chronicleCacheKey && chronicleBody.querySelector('.narrative')) return;

  const token = ++chronicleToken;
  chronicleBusy = true;
  chronicleRange.textContent = fromDay === toDay ? `第 ${fromDay} 天` : `第 ${fromDay}–${toDay} 天`;
  chronicleBody.className = 'muted';
  chronicleBody.textContent = '正在写…';

  try {
    const res = await fetch('/api/chronicle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: VIEWER_ID, fromDay, toDay }),
    });
    const data = await res.json();
    if (token !== chronicleToken) return;
    if (!data.ok) throw new Error(data.error || '生成失败');
    chronicleCacheKey = key;
    if (!selectedDay) lastChronicleDay = currentDay();
    renderChronicle(data);
  } catch (err) {
    if (token !== chronicleToken) return;
    chronicleBody.className = 'muted';
    chronicleBody.textContent = `编年史没有写成：${err.message}`;
  } finally {
    if (token === chronicleToken) chronicleBusy = false;
  }
}

// ---------- 你不在的时候 ----------

function renderReturnSummary() {
  const s = state && state.returnSummary;
  const hasNews = s && (s.ticks > 0 || (s.keyEvents && s.keyEvents.length) || (s.gone && s.gone.length));
  if (!hasNews || returnDismissed) {
    returnPanel.hidden = true;
    return;
  }
  returnPanel.hidden = false;

  const gone = (s.gone || []).map(nameOf);
  const items = (s.keyEvents || [])
    .slice(-12)
    .reverse()
    .map(
      (e) =>
        `<div class="item"><span class="t">${e.day}日 ${escapeHtml(e.clock || '')}</span>${escapeHtml(
          e.text || ''
        )}</div>`
    )
    .join('');

  returnBody.innerHTML = `
    <div>世界往前走了 ${s.ticks} 个世界分钟${s.skippedTicks ? `；太久了，另有 ${s.skippedTicks} 分钟没有模拟` : ''}。</div>
    ${gone.length ? `<div>不在了：${gone.map(escapeHtml).join('、')}。</div>` : ''}
    ${s.moved?.length ? `<div>${s.moved.length} 个人换了地方。</div>` : ''}
    ${items || '<div>没有发生值得记下的事。</div>'}
  `;
}

dismissReturnBtn.addEventListener('click', () => {
  returnDismissed = true;
  sessionStorage.setItem('island-return-dismissed', '1');
  returnPanel.hidden = true;
});

// ---------- 总的 UI ----------

function updateUI() {
  if (!state) return;

  clockEl.textContent = `第 ${state.day} 天 · ${state.clock}${state.isNight ? ' · 夜' : ''}`;
  popEl.textContent = `活着 ${state.population} / ${state.agents.length}`;
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
  pauseBtn.disabled = readOnlyMode;
  document.querySelectorAll('.speed').forEach((b) => {
    b.disabled = readOnlyMode;
  });

  if (brainStatus) {
    brainStatus.textContent = state.apiConfigured
      ? `当前：${state.llmAgents}/${state.agents.length} 人由你的模型驱动 · 已调用 ${state.llmCalls} 次${
          state.llmErrors ? ` · 失败 ${state.llmErrors}` : ''
        }`
      : '当前：规则驱动（未配置 API）。';
  }

  modesEl.querySelectorAll('.mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  document.querySelectorAll('.speed').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === state.speed);
  });

  selectedPanel.hidden = mode !== 'follow';
  islandPanel.hidden = mode !== 'island';

  if (mode === 'follow' && selectedId) {
    const a = agentById(selectedId);
    followBadge.hidden = false;
    followBadge.textContent = a
      ? `跟随：${a.name}${a.identity ? ` · ${a.identity}` : ''}${a.alive ? '' : ' · 已死'}`
      : '';
  } else {
    followBadge.hidden = true;
  }

  renderAgentPanel();
  if (mode === 'island') renderIslandPanel();

  logEl.innerHTML = state.log
    .slice(-30)
    .reverse()
    .map((e) => {
      let tag = '';
      if (e.type === 'talk' && e.payload) {
        const label = e.payload.understood
          ? state.labels?.languages?.[e.payload.language] || ''
          : '另一边只听见声音';
        tag = `<span class="lang">${escapeHtml(label)}</span>`;
      }
      return `<li class="${e.type}"><span class="t">${e.day}日 ${e.clock}</span>${escapeHtml(e.text)}${tag}</li>`;
    })
    .join('');

  renderReturnSummary();

  if (!historyMode && state.day !== lastTimelineDay) {
    lastTimelineDay = state.day;
    fetchTimeline();
  }

  // 停在“今天”时，每过一天自动换一份新的编年史；看旧日时不打扰。
  if (bootstrapped && !selectedDay && !chronicleBusy && state.day !== lastChronicleDay) {
    lastChronicleDay = state.day;
    loadChronicle(currentDay(), currentDay());
  }

  // 选择变了就告诉节点；同一个目标不重复发，心跳由上面的定时器负责。
  syncPresence();
  scheduleTranslate();
}

// ---------- 交互 ----------

modesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode');
  if (!btn) return;
  mode = btn.dataset.mode;
  updateUI();
});

agentInfoEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (!btn) return;
  agentTab = btn.dataset.tab;
  renderAgentPanel();
});

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
    agentTab = 'facts';
    if (mode !== 'follow') mode = 'follow';
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
  whisperNote.textContent = '正在送出去…';
  try {
    const res = await fetch('/api/whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: selectedId, text }),
    });
    const data = await res.json();
    if (data.ok) {
      whisperInput.value = '';
      whisperNote.textContent = data.heard
        ? `他听见了。还要等约 ${formatTicks(data.cooldownLeft || 0)}才能再写。`
        : '他听见了一个声音，但没有听懂。';
    } else if (data.error === 'cooldown') {
      whisperNote.textContent = `还没到时候：约 ${formatTicks(data.cooldownLeft || 0)}后。`;
    } else {
      whisperNote.textContent = '这句话没有送到。';
    }
  } catch {
    whisperNote.textContent = '这句话没有送到。';
  }
});

// 浅睡 / 举报按钮在每次重绘的 agentInfo 里，用事件委托。
agentInfoEl.addEventListener('click', async (event) => {
  const reportBtn = event.target.closest('[data-report]');
  if (reportBtn) {
    const reason = window.prompt('举报这个居民？可以写一句原因（只保存在本机）。', '');
    if (reason === null) return;
    reportBtn.disabled = true;
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: reportBtn.dataset.report,
          reason,
          viewerId: VIEWER_ID,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      whisperNote.textContent = `已经记在本机（${data.count} 次）。${data.note || ''}`;
    } catch (err) {
      whisperNote.textContent = `举报失败：${String(err?.message || err)}`;
    } finally {
      reportBtn.disabled = false;
    }
    return;
  }

  const btn = event.target.closest('[data-shallow]');
  if (!btn) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在安排…';
  try {
    const res = await fetch('/api/shallow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: btn.dataset.shallow }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    whisperNote.textContent = data.note || '浅睡已经安排好。';
  } catch (err) {
    whisperNote.textContent = `浅睡失败：${String(err?.message || err)}`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
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

narrateBtn.addEventListener('click', () => {
  const d = selectedDay || currentDay();
  loadChronicle(d, d, { force: true });
});

todayBtn.addEventListener('click', () => {
  selectedDay = null;
  exitHistory();
  renderTimeline();
  loadChronicle(currentDay(), currentDay(), { force: true });
});

exportBtn.addEventListener('click', async () => {
  const day = selectedDay || currentDay();
  exportBtn.disabled = true;
  exportBtn.textContent = '导出中…';
  try {
    const response = await fetch('/api/chronicle/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: VIEWER_ID, fromDay: day, toDay: day }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const blob = new Blob([data.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = data.filename || `island-chronicle-d${day}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    chronicleBody.textContent = `导出失败：${String(err?.message || err)}`;
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = '导出这一版';
  }
});

let bootstrapped = false;
function acceptState(next) {
  liveState = next;
  if (historyMode) return;
  state = next;
  render();
  updateUI();
  if (!bootstrapped) {
    bootstrapped = true;
    fetchTimeline();
    loadChronicle(currentDay(), currentDay());
  }
}

// ---------- 上传（arrival） ----------
// 一次性成本在浏览器里算，字段和 nonce 的规范化必须和服务器的 stableStringify 一致。
const ARRIVAL_VERSION_CLIENT = 'island-arrival/1';
let arrivalConfig = null;

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mineArrivalPoW(core, difficulty) {
  const prefix = '0'.repeat(Math.max(0, Math.min(8, Number(difficulty) || 0)));
  for (let nonce = 0; nonce < 5_000_000; nonce++) {
    const hash = await sha256Hex(stableStringify({ version: ARRIVAL_VERSION_CLIENT, core, nonce }));
    if (hash.startsWith(prefix)) return { nonce, difficulty: prefix.length };
    if (nonce > 0 && nonce % 2500 === 0) {
      arrivalNote.textContent = `正在计算一次性成本…（${nonce}）`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error('一次性成本计算超时');
}

function fillArrivalSelect(select, keys, labels) {
  select.innerHTML = '';
  for (const key of keys || []) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = labels?.[key] || key;
    select.appendChild(option);
  }
}

async function openArrival() {
  arrivalNote.textContent = '';
  try {
    const response = await fetch('/api/arrival');
    arrivalConfig = await response.json();
  } catch {
    arrivalNote.textContent = '没有连上世界。';
    arrivalDialog.showModal();
    return;
  }
  if (!arrivalConfig?.ok) {
    arrivalNote.textContent = '这个节点暂时不能接收上传。';
    arrivalDialog.showModal();
    return;
  }
  fillArrivalSelect(arrivalForm.origin, arrivalConfig.origins);
  fillArrivalSelect(arrivalForm.aptitude, arrivalConfig.aptitudes);
  fillArrivalSelect(arrivalForm.language, arrivalConfig.languages, state?.labels?.languages);
  arrivalNotice.textContent = arrivalConfig.notice;
  arrivalSubmit.disabled = !!arrivalConfig.hasUploaded;
  if (arrivalConfig.hasUploaded) {
    arrivalNote.textContent = '这个节点已经上传过一个人了。每个人只能上传一次。';
  }
  arrivalDialog.showModal();
}

arrivalBtn.addEventListener('click', openArrival);
arrivalClose.addEventListener('click', () => arrivalDialog.close());

arrivalForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!arrivalConfig?.ok) return;
  const core = {
    name: arrivalForm.name.value.trim(),
    origin: arrivalForm.origin.value,
    aptitude: arrivalForm.aptitude.value,
    language: arrivalForm.language.value,
    obsession: arrivalForm.obsession.value.trim(),
    wound: arrivalForm.wound.value.trim(),
    voice: arrivalForm.voice.value.trim(),
  };

  arrivalSubmit.disabled = true;
  arrivalNote.textContent = `正在计算一次性成本（前 ${arrivalConfig.difficulty} 个零）…`;
  try {
    const pow = await mineArrivalPoW(core, arrivalConfig.difficulty);
    arrivalNote.textContent = '正在交给当前写入节点…';
    const response = await fetch('/api/arrival', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core, pow, playerId: VIEWER_ID }),
    });
    const data = await response.json();
    if (!data.ok) {
      arrivalNote.textContent = data.error || `上传失败（HTTP ${response.status}）`;
      return;
    }
    arrivalNote.textContent = `${data.name} 从雾里走上了岛。`;
    arrivalConfig.hasUploaded = true;
    if (data.agentId) {
      selectedId = data.agentId;
      mode = 'follow';
      updateUI();
    }
    setTimeout(() => arrivalDialog.close(), 1400);
  } catch (err) {
    arrivalNote.textContent = String(err?.message || err);
  } finally {
    arrivalSubmit.disabled = !!arrivalConfig?.hasUploaded;
  }
});

if (langBtn) {
  langBtn.textContent = LANG === 'en' ? '中' : 'EN';
  langBtn.addEventListener('click', () => {
    const next = LANG === 'en' ? 'zh' : 'en';
    localStorage.setItem('island-lang', next);
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    location.href = url.toString();
  });
}

if (PUBLIC_MODE) {
  const controls = document.querySelector('.controls');
  if (controls) controls.hidden = true;
  const brainPanel = document.getElementById('brainPanel');
  if (brainPanel) brainPanel.hidden = true;
  whisperForm.hidden = true;
  const subtitle = document.querySelector('.brand p');
  if (subtitle) subtitle.textContent = '看台 · 只读 · 每个人的版本都不一样';
}

refreshSyncStatus();
setInterval(refreshSyncStatus, 3000);

// ?static=1：不接 SSE，只拉一次状态。给截图和离线调试用。
if (PARAMS.has('static')) {
  fetch('/api/state')
    .then((r) => r.json())
    .then(acceptState)
    .catch(() => {
      hintEl.textContent = '没有连上世界。';
      hintEl.style.display = 'block';
    });
} else {
  const es = new EventSource('/stream');
  es.onmessage = (e) => {
    try {
      acceptState(JSON.parse(e.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  es.onerror = () => {
    hintEl.textContent = '连接断开了，正在重连…';
    hintEl.style.display = 'block';
  };
}
