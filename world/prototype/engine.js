// engine.js — 确定性世界。所有胜负、生死、消耗都在这里算。
// 语言模型只提交"意图"，永远不决定结果。

export const W = 40;
export const H = 40;
export const TICKS_PER_DAY = 1440; // 1 tick = 1 世界分钟
export const MS_PER_TICK = (60 * 60 * 1000) / TICKS_PER_DAY; // 24 倍：1 现实小时 = 1 世界日


export const TILE = Object.freeze({
  WATER: 0,
  GRASS: 1,
  TREE: 2,
  ROCK: 3,
  RUIN: 4,
  BUSH: 5,
});

export const TILE_NAME = ['水', '草地', '树', '岩石', '废墟', '灌木'];

export const DIRS = {
  N: [0, -1],
  S: [0, 1],
  W: [-1, 0],
  E: [1, 0],
};

function mulberry32(a) {
  const rng = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.getState = () => a | 0;
  rng.setState = (state) => {
    a = state | 0;
  };
  return rng;
}

const CAST = [
  { name: '周远', origin: '小城教师', obsession: '把没说完的话说完', aptitude: '耐心', wound: '先挂了女儿的电话', color: '#e0b56b' },
  { name: '林氏', origin: '农妇', obsession: '让所有人有饭吃', aptitude: '手艺', wound: '饥荒里饿死了弟弟', color: '#7fbf7f' },
  { name: '阿哲', origin: '青年', obsession: '证明这里不是梦', aptitude: '机敏', wound: '父亲死时他不在', color: '#6fa8dc' },
  { name: '陈默', origin: '铁匠', obsession: '造出一样留给后人的东西', aptitude: '体魄', wound: '一场火烧了工坊', color: '#d98880' },
  { name: '苏禾', origin: '医生', obsession: '救回一个不该死的人', aptitude: '耐心', wound: '病人的手在她手里凉了', color: '#c27ba0' },
  { name: '老唐', origin: '渔夫', obsession: '回到海的那一边', aptitude: '体魄', wound: '船沉了，儿子没上来', color: '#76a5af' },
  { name: '小满', origin: '少女', obsession: '找到那个说会回来的人', aptitude: '口才', wound: '等了一夜', color: '#f1c232' },
  { name: '何叔', origin: '木匠', obsession: '盖一间有墙的屋子', aptitude: '手艺', wound: '盖好的房子被拆了', color: '#b45f06' },
  { name: '阿青', origin: '猎人', obsession: '杀死咬死妻子的东西', aptitude: '机敏', wound: '妻子死在夜里', color: '#93c47d' },
  { name: '白姨', origin: '教师', obsession: '把故事讲给愿意听的人', aptitude: '口才', wound: '没有人来听最后一课', color: '#9fc5e8' },
  { name: '石生', origin: '石匠', obsession: '刻下所有人的名字', aptitude: '体魄', wound: '父亲的坟没有碑', color: '#a2c4c9' },
  { name: '阿禾', origin: '流浪者', obsession: '找到一个能留下的地方', aptitude: '机敏', wound: '每个地方都赶他走', color: '#e6b8af' },
];

// 生存常识天生：走、吃、躲、采集、生火。
// 专长技能来自出身；成长速度由禀赋决定。
// 搭窝棚、砌墙、捕鱼、耕种、削武器：出身带着的人会，其余的人必须被教。
const BASE_SKILLS = Object.freeze({
  fight: 1,
  gather: 1,
  build: 1,
  talk: 1,
  fish: 0,
  farm: 0,
  craft: 0,
  teach: 0,
});

export const KNOWLEDGE_KEYS = Object.freeze(['fire', 'shelter', 'wall', 'fish', 'farm', 'craft']);

export const SKILL_KEYS = Object.freeze(Object.keys(BASE_SKILLS));

export const SKILL_LABEL = {
  fight: '战斗',
  gather: '采集',
  build: '建造',
  talk: '说话',
  fish: '捕鱼',
  farm: '耕种',
  craft: '制造',
  teach: '教导',
};

export const KNOWLEDGE_LABEL = {
  fire: '生火',
  shelter: '搭窝棚',
  wall: '砌墙',
  fish: '捕鱼',
  farm: '耕种',
  craft: '削武器',
};

const SURVIVAL_KNOWLEDGE = Object.freeze(['fire']);

// 学一项知识时，看的是它最接近的技能天赋。
const KNOWLEDGE_SKILL = {
  fire: 'build',
  shelter: 'build',
  wall: 'build',
  fish: 'fish',
  farm: 'farm',
  craft: 'craft',
};

const TEACHER_PROFILE = { skills: { talk: 4, teach: 4, gather: 1 }, knows: [] };

const ORIGIN_PROFILES = {
  小城教师: TEACHER_PROFILE,
  教师: TEACHER_PROFILE,
  农妇: { skills: { farm: 4, gather: 3, talk: 2 }, knows: ['farm'] },
  青年: { skills: { gather: 3, fight: 2, talk: 2 }, knows: [] },
  铁匠: { skills: { craft: 5, build: 3, fight: 2 }, knows: ['craft', 'wall'] },
  医生: { skills: { talk: 3, teach: 3, gather: 2 }, knows: [] },
  渔夫: { skills: { fish: 5, gather: 2, talk: 2 }, knows: ['fish'] },
  少女: { skills: { talk: 3, gather: 3, farm: 1 }, knows: [] },
  木匠: { skills: { build: 5, craft: 4 }, knows: ['shelter', 'wall', 'craft'] },
  猎人: { skills: { fight: 4, gather: 4, craft: 2 }, knows: ['craft'] },
  石匠: { skills: { build: 5, craft: 3 }, knows: ['shelter', 'wall', 'craft'] },
  流浪者: { skills: { gather: 3, talk: 2, fight: 2 }, knows: [] },
};

const APTITUDE_GROWTH = {
  体魄: { fight: 1.6, gather: 1.2, build: 1.1 },
  机敏: { gather: 1.5, fight: 1.1, craft: 1.1 },
  手艺: { craft: 1.6, build: 1.5, farm: 1.1 },
  口才: { talk: 1.6, teach: 1.5 },
  耐心: { teach: 1.4, farm: 1.3, build: 1.1, talk: 1.1 },
};

export function growthMultiplier(agent, skill) {
  return APTITUDE_GROWTH[agent.tags.aptitude]?.[skill] ?? 1;
}

export function growSkill(agent, skill, amount) {
  if (!(skill in BASE_SKILLS)) return agent.skills[skill] || 0;
  agent.skills[skill] = Math.min(10, (agent.skills[skill] || 0) + amount * growthMultiplier(agent, skill));
  return agent.skills[skill];
}

export function emptyKnows() {
  return Object.fromEntries(KNOWLEDGE_KEYS.map((key) => [key, false]));
}

export function initialKnows(origin) {
  const knows = emptyKnows();
  const granted = [...SURVIVAL_KNOWLEDGE, ...(ORIGIN_PROFILES[origin]?.knows || [])];
  for (const key of granted) knows[key] = true;
  return knows;
}

export function knowledgeProgressGain(agent, key) {
  const skill = KNOWLEDGE_SKILL[key] || 'build';
  return 0.34 * growthMultiplier(agent, skill);
}

function findGrass(map, cx, cy) {
  const start = cy * W + cx;
  if (map[start] === TILE.GRASS) return [cx, cy];
  for (let r = 1; r < 20; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (map[y * W + x] === TILE.GRASS) return [x, y];
      }
    }
  }
  return [cx, cy];
}

export function createWorld(seed = 20261102) {
  const rng = mulberry32(seed);
  const buildRng = mulberry32(0x5eed);
  const map = new Uint8Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - (W - 1) / 2) / ((W - 1) / 2);
      const ny = (y - (H - 1) / 2) / ((H - 1) / 2);
      let d = Math.hypot(nx, ny);
      d += 0.07 * Math.sin(x * 0.9 + 1.3) + 0.07 * Math.cos(y * 0.7 - 0.4);
      let t = TILE.GRASS;
      if (d > 0.93) t = TILE.WATER;
      else if (d > 0.86) t = TILE.GRASS;
      else {
        const r = rng();
        if (r < 0.16) t = TILE.TREE;
        else if (r < 0.205) t = TILE.ROCK;
        else if (r < 0.237) t = TILE.BUSH;
        else if (r < 0.26) t = TILE.RUIN;
      }
      map[y * W + x] = t;
    }
  }

  // 中心留出一片空地，第一批人在这里醒来
  for (let y = H / 2 - 6; y <= H / 2 + 5; y++) {
    for (let x = W / 2 - 6; x <= W / 2 + 5; x++) {
      map[y * W + x] = TILE.GRASS;
    }
  }

  const world = {
    seed,
    tick: 480, // 第 1 天 08:00，从白天开始
    map,
    agents: [],
    structures: [],
    wolves: [],
    log: [],
    eventLog: [],
    facts: [],
    nextSeq: 1,
    nextFactId: 1,
    nextBeliefId: 1,
    decisionLog: [],
    replay: null,
    sounds: [],
    regrow: [],
    pendingDecisions: [],
    rng: mulberry32(seed ^ 0x9e3779b9),
    config: { paused: false, speed: 1, llmAgents: 0 },
    api: { provider: 'openai', base: '', key: '', model: '' },
    inflight: 0,
    nextWolfId: 1,
    nightActive: false,
  };

  const ring = [];
  for (let i = 0; i < CAST.length; i++) {
    const ang = (i / CAST.length) * Math.PI * 2;
    const r = 4 + buildRng() * 3;
    ring.push([Math.round(W / 2 + Math.cos(ang) * r), Math.round(H / 2 + Math.sin(ang) * r)]);
  }

  world.agents = CAST.map((c, i) => {
    const [x, y] = findGrass(map, ring[i][0], ring[i][1]);
    const skills = { ...BASE_SKILLS, ...(ORIGIN_PROFILES[c.origin]?.skills || {}) };
    const knows = initialKnows(c.origin);
    return {
      id: 'a' + (i + 1),
      name: c.name,
      color: c.color,
      x,
      y,
      hp: 100,
      hunger: 70 + Math.floor(buildRng() * 20),
      energy: 80 + Math.floor(buildRng() * 20),
      inventory: { food: 1, wood: 0, stone: 0, weapon: 0 },
      tags: { origin: c.origin, obsession: c.obsession, aptitude: c.aptitude, wound: c.wound },
      skills,
      knows,
      learning: {},
      reputation: 0,
      relationships: {},
      memory: [],
      beliefs: [],
      action: null,
      queuedAction: null,
      deciding: false,
      cooldownUntil: 0,
      alive: true,
      facing: 'S',
      useLLM: false,
      lastAction: '',
      trace: [],
      collapsed: false,
      lastSay: '',
      letter: '',
    };
  });

  logEvent(world, 'birth', '十二个人在岛的中央醒了过来。没有人解释这里是哪里。');
  return world;
}

function appendEvent(world, entry, { ui = true } = {}) {
  world.eventLog.push(entry);
  if (!ui) return entry;
  world.log.push(entry);
  if (world.log.length > 400) world.log.shift();
  return entry;
}

export function logEvent(world, type, text, agentId = null, payload = null) {
  return appendEvent(world, {
    seq: world.nextSeq++,
    t: world.tick,
    day: world.day || 1,
    clock: world.clock || '08:00',
    type,
    text,
    agentId,
    payload,
  });
}

export function logDecision(world, { agentId, source, action, rngAfter }) {
  const event = appendEvent(
    world,
    {
      seq: world.nextSeq++,
      t: world.tick,
      day: world.day || 1,
      clock: world.clock || '08:00',
      type: 'decision',
      text: '',
      agentId,
      payload: { source, action: { ...action }, rngAfter },
    },
    { ui: false }
  );
  const entry = {
    seq: event.seq,
    tick: world.tick,
    agentId,
    source,
    action: { ...action },
    rngAfter,
  };
  world.decisionLog.push(entry);
  return entry;
}

export function remember(agent, text) {
  agent.memory.push(text);
  if (agent.memory.length > 20) agent.memory.shift();
}

export function recordFact(world, fact) {
  const entry = {
    id: 'f' + world.nextFactId++,
    t: world.tick,
    day: world.day || 1,
    ...fact,
  };
  world.facts.push(entry);
  return entry;
}

export function recordBelief(world, agent, proposition, source, confidence = 0.8) {
  const entry = {
    id: 'b' + world.nextBeliefId++,
    t: world.tick,
    proposition,
    source,
    confidence,
  };
  agent.beliefs.push(entry);
  if (agent.beliefs.length > 200) agent.beliefs.shift();
  return entry;
}

function recordTeaching(world, teacher, student, { key, kind, label }) {
  const completed = kind === 'knowledge';
  const text = completed
    ? `${teacher.name}教会了${student.name}${label}。`
    : `${teacher.name}教了${student.name}一点${label}。`;
  const event = logEvent(world, 'teach', text, teacher.id);
  recordFact(world, {
    type: 'teach',
    subjectId: teacher.id,
    predicate: 'taught',
    object: key,
    targetId: student.id,
    eventSeq: event.seq,
  });
  recordBelief(
    world,
    student,
    completed ? `${teacher.name}教会你${label}。` : `${teacher.name}教了你一点${label}。`,
    'taught',
    completed ? 0.95 : 0.8
  );
  remember(teacher, text);
  remember(student, completed ? `${teacher.name}教会你${label}。` : `${teacher.name}教了你一点${label}。`);
}

export function isWalkable(world, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const t = world.map[y * W + x];
  if (t === TILE.WATER || t === TILE.TREE || t === TILE.ROCK) return false;
  if (world.structures.some((s) => s.type === 'wall' && s.x === x && s.y === y)) return false;
  return true;
}

export function adjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 1;
}

function faceToward(a, x, y) {
  const dx = x - a.x;
  const dy = y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) a.facing = dx > 0 ? 'E' : 'W';
  else if (dy !== 0) a.facing = dy > 0 ? 'S' : 'N';
}

export function emitSound(world, x, y, radius, kind, text, sourceId = null) {
  world.sounds.push({ x, y, radius, kind, text, sourceId, tick: world.tick });
  if (world.sounds.length > 100) world.sounds.shift();
}

function scheduleRegrow(world, x, y, tile, delay) {
  if (world.regrow.some((r) => r.x === x && r.y === y)) return;
  world.regrow.push({ x, y, tile, at: world.tick + delay });
}

const DIR_CN = { N: '北', S: '南', E: '东', W: '西' };

function describeAction(act) {
  if (!act) return '';
  switch (act.type) {
    case 'move': return `往${DIR_CN[act.dir] || act.dir}走`;
    case 'gather': return '采集';
    case 'fish': return '在水边捕鱼';
    case 'plant': return '种下一丛灌木';
    case 'eat': return '吃东西';
    case 'craft': return '削了一把武器';
    case 'build': return { fire: '生火', shelter: '搭窝棚', wall: '砌墙' }[act.build] || '建造';
    case 'talk': return '和人说话';
    case 'teach': return '教人东西';
    case 'attack': return '攻击';
    case 'flee': return '逃跑';
    case 'rest': return '休息';
    case 'idle': return '发呆';
    default: return act.type;
  }
}

function recordTrace(world, a, note) {
  a.trace.push({ t: world.tick, x: a.x, y: a.y, note });
  if (a.trace.length > 20) a.trace.shift();
}

function structureAt(world, x, y) {
  return world.structures.find((s) => s.x === x && s.y === y);
}

export function resourceNear(world, a, types) {
  const spots = [
    [a.x, a.y],
    [a.x, a.y - 1],
    [a.x, a.y + 1],
    [a.x - 1, a.y],
    [a.x + 1, a.y],
  ];
  for (const [x, y] of spots) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const t = world.map[y * W + x];
    if (types.includes(t)) return { x, y, t };
  }
  return null;
}

function nearFire(world, x, y, r = 2) {
  return world.structures.some((s) => s.type === 'fire' && Math.abs(s.x - x) + Math.abs(s.y - y) <= r);
}

export function kill(world, a, cause) {
  if (!a.alive) return;
  a.alive = false;
  a.hp = 0;
  a.action = null;
  a.queuedAction = null;
  world.structures.push({ type: 'grave', x: a.x, y: a.y, name: a.name });
  const death = logEvent(world, 'death', `${a.name}死了。${cause}`, a.id);
  recordFact(world, { type: 'death', subjectId: a.id, predicate: 'died', object: cause, eventSeq: death.seq });
  emitSound(world, a.x, a.y, 16, 'death', '一声惨叫之后，安静了下来', a.id);

  // 坟边的土会变肥：两三天后长出灌木
  const fertile = [
    [a.x, a.y - 1],
    [a.x, a.y + 1],
    [a.x - 1, a.y],
    [a.x + 1, a.y],
  ].filter(
    ([x, y]) =>
      x >= 0 && y >= 0 && x < W && y < H &&
      world.map[y * W + x] === TILE.GRASS &&
      !world.structures.some((s) => s.x === x && s.y === y)
  );
  for (const [x, y] of fertile.slice(0, 2)) {
    scheduleRegrow(world, x, y, TILE.BUSH, 2 * TICKS_PER_DAY);
  }
  for (const other of world.agents) {
    if (other.alive && other.id !== a.id && Math.abs(other.x - a.x) + Math.abs(other.y - a.y) <= 5) {
      remember(other, `${a.name}死了。${cause}`);
      recordBelief(world, other, `${a.name}死了。${cause}`, 'witness', 0.9);
    }
  }
}

function damage(world, target, amount, by) {
  target.hp -= amount;
  if (target.hp <= 0 && target.alive) {
    kill(world, target, by ? `死在${by.name}手里。` : '伤重而死。');
  }
}

function stepAgent(world, a) {
  if (!a.alive) return;

  a.hunger = Math.max(0, a.hunger - 0.05);
  a.energy = Math.max(0, a.energy - (world.isNight ? 0.06 : 0.04));
  if (a.hunger <= 0) a.hp -= 0.12;
  if (a.energy <= 0) a.hp -= 0.05;
  if (a.hp <= 0) {
    kill(world, a, a.hunger <= 0 ? '饿死了。' : '耗尽而死。');
    return;
  }

  if (a.energy > 5) a.collapsed = false;
  if (a.energy <= 0 && !a.collapsed) {
    a.collapsed = true;
    a.action = { type: 'rest', remaining: 30, reason: '体力耗尽，倒下了' };
    a.queuedAction = null;
    a.deciding = false;
    remember(a, '你撑不住了，倒在地上。');
    logEvent(world, 'collapse', `${a.name}撑不住了，倒在地上。`, a.id);
    recordTrace(world, a, '体力耗尽，倒下');
  }

  if (a.queuedAction && !a.action) {
    a.action = a.queuedAction;
    a.queuedAction = null;
  }

  if (a.action) {
    runAction(world, a);
  } else if (world.tick >= a.cooldownUntil && !a.deciding) {
    a.deciding = true;
    a.cooldownUntil = world.tick + (a.useLLM && world.api.key ? 10 + Math.floor(world.rng() * 8) : 4);
    world.pendingDecisions.push(a);
  }
}

function endAction(world, a, cooldown = 2) {
  a.action = null;
  a.cooldownUntil = Math.max(a.cooldownUntil || 0, world.tick + cooldown);
}

function runAction(world, a) {
  const act = a.action;
  if (!act) return;
  const why = act.reason ? `（${String(act.reason).slice(0, 60)}）` : '（没有说为什么）';
  act.remaining = (act.remaining ?? 1) - 1;

  switch (act.type) {
    case 'move': {
      const [dx, dy] = DIRS[act.dir] || [0, 0];
      const nx = a.x + dx;
      const ny = a.y + dy;
      const occupied = world.agents.some((o) => o.alive && o.id !== a.id && o.x === nx && o.y === ny);
      if (isWalkable(world, nx, ny) && !occupied) {
        a.x = nx;
        a.y = ny;
        a.facing = act.dir;
        recordTrace(world, a, `往${DIR_CN[act.dir] || act.dir}走`);
      } else {
        a.lastAction = `想往${DIR_CN[act.dir] || act.dir}走，但被挡住了`;
        recordTrace(world, a, a.lastAction);
        endAction(world, a, 2);
        return;
      }
      break;
    }

    case 'gather': {
      if (act.remaining > 0) break;
      const spot = resourceNear(world, a, [TILE.TREE, TILE.BUSH, TILE.ROCK]);
      if (!spot) break;
      if (spot.t === TILE.TREE) {
        a.inventory.wood += 2;
        if (world.rng() < 0.3) a.inventory.food += 1;
        world.map[spot.y * W + spot.x] = TILE.GRASS;
        scheduleRegrow(world, spot.x, spot.y, TILE.TREE, 4 * TICKS_PER_DAY);
        remember(a, '你砍倒了一棵树。');
      } else if (spot.t === TILE.BUSH) {
        a.inventory.food += 2;
        world.map[spot.y * W + spot.x] = TILE.GRASS;
        scheduleRegrow(world, spot.x, spot.y, TILE.BUSH, Math.round(1.5 * TICKS_PER_DAY));
        remember(a, '你摘到了一些果子。');
      } else if (spot.t === TILE.ROCK) {
        a.inventory.stone += 2;
        world.map[spot.y * W + spot.x] = TILE.GRASS;
        remember(a, '你敲下了一些石头。');
      }
      growSkill(a, 'gather', 0.04);
      break;
    }

    case 'fish': {
      if (act.remaining > 0) break;
      if (!a.knows.fish) {
        remember(a, '你不知道怎么从水里弄到吃的。');
        break;
      }
      const nearWater = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => {
        const x = a.x + dx;
        const y = a.y + dy;
        return x >= 0 && y >= 0 && x < W && y < H && world.map[y * W + x] === TILE.WATER;
      });
      if (nearWater) {
        if (world.rng() < 0.35) {
          a.inventory.food += 1;
          remember(a, '你从水边捕到了一条鱼。');
          growSkill(a, 'fish', 0.06);
        } else {
          remember(a, '你在水边等了很久，什么也没捕到。');
          growSkill(a, 'fish', 0.02);
        }
      }
      break;
    }

    case 'plant': {
      if (act.remaining > 0) break;
      if (!a.knows.farm) {
        remember(a, '你不知道怎么把东西种活。');
        break;
      }
      const idx = a.y * W + a.x;
      if (
        world.map[idx] === TILE.GRASS &&
        !structureAt(world, a.x, a.y) &&
        !world.regrow.some((r) => r.x === a.x && r.y === a.y) &&
        a.inventory.food >= 1
      ) {
        a.inventory.food -= 1;
        scheduleRegrow(world, a.x, a.y, TILE.BUSH, 2 * TICKS_PER_DAY);
        growSkill(a, 'farm', 0.05);
        logEvent(world, 'build', `${a.name}${why}把一份食物埋进土里。`, a.id);
        remember(a, `你${act.reason ? `因为${act.reason}，` : ''}把一份食物埋进土里，等它长出来。`);
      }
      break;
    }

    case 'eat': {
      if (a.inventory.food > 0) {
        a.inventory.food -= 1;
        a.hunger = Math.min(100, a.hunger + 45);
        remember(a, '你吃了一点东西。');
      }
      break;
    }

    case 'craft': {
      if (act.remaining > 0) break;
      if (!a.knows.craft) {
        remember(a, '你不知道怎么把木头削成武器。');
        break;
      }
      if (a.inventory.wood >= 2 && !a.inventory.weapon) {
        a.inventory.wood -= 2;
        a.inventory.weapon = 1;
        growSkill(a, 'craft', 0.15);
        remember(a, `你${act.reason ? `因为${act.reason}，` : ''}把木头削成了一件武器。`);
        const crafted = logEvent(world, 'craft', `${a.name}${why}造出了一件粗糙的武器。`, a.id);
        recordFact(world, {
          type: 'craft',
          subjectId: a.id,
          predicate: 'crafted',
          object: 'weapon',
          eventSeq: crafted.seq,
        });
      }
      break;
    }

    case 'build': {
      if (act.remaining > 0) break;
      if (!a.knows[act.build]) {
        remember(a, `你不知道怎么${KNOWLEDGE_LABEL[act.build] || '建这个'}。`);
        break;
      }
      const cost = { fire: 5, shelter: 10, wall: 5 };
      const need = cost[act.build] || 5;
      const resource = act.build === 'wall' ? 'stone' : 'wood';
      if (a.inventory[resource] >= need && !structureAt(world, a.x, a.y)) {
        a.inventory[resource] -= need;
        growSkill(a, 'build', 0.1);
        const s = { type: act.build, x: a.x, y: a.y };
        if (act.build === 'fire') s.fuel = 600;
        world.structures.push(s);
        const madeCamp =
          act.build === 'fire' &&
          !world.structures.some((o) => o.type === 'camp' && Math.abs(o.x - a.x) + Math.abs(o.y - a.y) <= 3);
        if (madeCamp) world.structures.push({ type: 'camp', x: a.x, y: a.y });
        const names = { fire: '火堆', shelter: '窝棚', wall: '墙' };
        const built = logEvent(world, 'build', `${a.name}${why}建起了一个${names[act.build] || act.build}。`, a.id);
        recordFact(world, {
          type: 'build',
          subjectId: a.id,
          predicate: 'built',
          object: act.build,
          x: a.x,
          y: a.y,
          eventSeq: built.seq,
        });
        if (madeCamp) logEvent(world, 'build', '这里成了一个营地。', a.id);
        remember(a, `你${act.reason ? `因为${act.reason}，` : ''}建起了一个${names[act.build] || act.build}。`);
        emitSound(world, a.x, a.y, 6, 'work', '有人在敲打东西', a.id);
      }
      break;
    }

    case 'talk': {
      if (act.remaining > 0) break;
      const target = world.agents.find((o) => o.id === act.target && o.alive);
      if (target && adjacent(a, target)) {
        faceToward(a, target.x, target.y);
        const say = (act.say || '').slice(0, 80);
        a.lastSay = say;
        const delta = 2 + Math.floor(world.rng() * 4);
        a.relationships[target.id] = (a.relationships[target.id] || 0) + delta;
        target.relationships[a.id] = (target.relationships[a.id] || 0) + delta;
        growSkill(a, 'talk', 0.04);
        if (say) {
          const spoken = logEvent(world, 'talk', `${a.name}对${target.name}说：「${say}」`, a.id);
          recordFact(world, {
            type: 'talk',
            subjectId: a.id,
            predicate: 'said',
            object: say,
            targetId: target.id,
            eventSeq: spoken.seq,
          });
          recordBelief(world, target, `${a.name}说：「${say}」`, 'told', 0.6);
          remember(a, `你对${target.name}说：「${say}」`);
          remember(target, `${a.name}对你说：「${say}」`);
          emitSound(world, a.x, a.y, 5, 'talk', '有人在说话', a.id);
        }
      }
      break;
    }

    case 'teach': {
      if (act.remaining > 0) break;
      const target = world.agents.find((o) => o.id === act.target && o.alive);
      if (!target || !adjacent(a, target)) break;
      const key = String(act.skill || '');
      let taught = false;

      if (KNOWLEDGE_KEYS.includes(key) && a.knows[key] && !target.knows[key]) {
        const progress = Math.min(1, (target.learning[key] || 0) + knowledgeProgressGain(target, key));
        a.energy = Math.max(0, a.energy - 2);
        growSkill(a, 'teach', 0.2);
        taught = true;
        if (progress >= 1) {
          target.knows[key] = true;
          delete target.learning[key];
          recordTeaching(world, a, target, { key, kind: 'knowledge', label: KNOWLEDGE_LABEL[key] });
        } else {
          target.learning[key] = progress;
          logEvent(world, 'teach', `${a.name}在教${target.name}${KNOWLEDGE_LABEL[key]}。`, a.id);
          remember(a, `你在教${target.name}${KNOWLEDGE_LABEL[key]}。`);
          remember(target, `${a.name}在教你${KNOWLEDGE_LABEL[key]}。`);
        }
      }

      // 已经会了的人之间，仍然可以教更高的手艺。
      if (!taught && SKILL_KEYS.includes(key) && key !== 'teach' && (a.skills[key] || 0) > (target.skills[key] || 0)) {
        a.energy = Math.max(0, a.energy - 2);
        growSkill(target, key, 0.1 * (1 + a.skills.teach * 0.2));
        growSkill(a, 'teach', 0.1);
        recordTeaching(world, a, target, { key, kind: 'skill', label: SKILL_LABEL[key] || key });
      }
      break;
    }

    case 'attack': {
      if (act.remaining > 0) break;

      if (act.target === 'wolf') {
        const wolf = world.wolves.find((w) => Math.abs(w.x - a.x) + Math.abs(w.y - a.y) <= 1);
        if (wolf) {
          faceToward(a, wolf.x, wolf.y);
          wolf.hp -= 10 + a.skills.fight * 2 + a.inventory.weapon * 5;
          growSkill(a, 'fight', 0.05);
          const struck = logEvent(world, 'fight', `${a.name}${why}打伤了那头野兽。`, a.id);
          recordFact(world, {
            type: 'fight',
            subjectId: a.id,
            predicate: 'struck',
            object: 'wolf',
            targetId: wolf.id,
            eventSeq: struck.seq,
          });
          emitSound(world, a.x, a.y, 12, 'fight', '有人在和野兽搏斗', a.id);
          if (wolf.hp <= 0) {
            world.wolves = world.wolves.filter((w) => w !== wolf);
            a.reputation += 5;
            const slain = logEvent(world, 'fight', `${a.name}${why}杀死了一头野兽。`, a.id);
            recordFact(world, {
              type: 'fight',
              subjectId: a.id,
              predicate: 'killed',
              object: 'wolf',
              targetId: wolf.id,
              eventSeq: slain.seq,
            });
            remember(a, '你杀死了一头野兽。');
          }
        }
        break;
      }

      const target = world.agents.find((o) => o.id === act.target && o.alive);
      if (target && adjacent(a, target)) {
        faceToward(a, target.x, target.y);
        const atk = 8 + a.skills.fight * 2 + a.inventory.weapon * 5 + Math.floor(world.rng() * 5);
        const def = target.skills.fight + target.inventory.weapon * 3 + (structureAt(world, target.x, target.y)?.type === 'shelter' ? 3 : 0);
        const dmg = Math.max(2, atk - def);
        damage(world, target, dmg, a);
        growSkill(a, 'fight', 0.05);
        a.reputation -= 2;
        target.relationships[a.id] = (target.relationships[a.id] || 0) - 25;
        const attacked = logEvent(world, 'fight', `${a.name}${why}攻击了${target.name}。`, a.id);
        recordFact(world, {
          type: 'fight',
          subjectId: a.id,
          predicate: 'attacked',
          object: target.id,
          damage: dmg,
          eventSeq: attacked.seq,
        });
        emitSound(world, a.x, a.y, 14, 'fight', '有人在打斗', a.id);
        remember(a, `你攻击了${target.name}。${act.reason ? `因为：${act.reason}` : ''}`);
        remember(target, `${a.name}攻击了你。${act.reason ? `他说：${act.reason}` : ''}`);
      }
      break;
    }

    case 'flee': {
      const threat = world.wolves.find((w) => Math.abs(w.x - a.x) + Math.abs(w.y - a.y) <= 3)
        || world.agents.find((o) => o.alive && o.id !== a.id && (a.relationships[o.id] || 0) < -20 && Math.abs(o.x - a.x) + Math.abs(o.y - a.y) <= 3);
      if (threat) {
        const dx = Math.sign(a.x - threat.x);
        const dy = Math.sign(a.y - threat.y);
        const candidates = [];
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) candidates.push([dx, 0]);
        if (dy !== 0) candidates.push([0, dy]);
        if (dx !== 0) candidates.push([dx, 0]);
        for (const [mx, my] of candidates) {
          if (isWalkable(world, a.x + mx, a.y + my)) {
            a.x += mx;
            a.y += my;
            break;
          }
        }
        if (act.reason) logEvent(world, 'flee', `${a.name}（${act.reason}）逃开了。`, a.id);
      }
      break;
    }

    case 'rest': {
      a.energy = Math.min(100, a.energy + 0.4);
      if (structureAt(world, a.x, a.y)?.type === 'shelter') a.energy = Math.min(100, a.energy + 0.2);
      break;
    }

    case 'idle':
    default:
      break;
  }

  if (act.remaining <= 0) {
    a.lastAction = describeAction(act);
    if (act.type !== 'move') recordTrace(world, a, a.lastAction);
    endAction(world, a);
  }
}

function spawnWolves(world) {
  const count = 1 + Math.floor(world.rng() * 3);
  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 200; tries++) {
      const edge = Math.floor(world.rng() * 4);
      const t = Math.floor(world.rng() * W);
      let x = t;
      let y = t;
      if (edge === 0) y = 2;
      if (edge === 1) y = H - 3;
      if (edge === 2) x = 2;
      if (edge === 3) x = W - 3;
      if (isWalkable(world, x, y)) {
        world.wolves.push({ id: 'w' + world.nextWolfId++, x, y, hp: 30, cooldown: 0 });
        emitSound(world, x, y, 22, 'howl', '远处传来野兽的嚎叫');
        break;
      }
    }
  }
  logEvent(world, 'wolf', `天黑以后，岛上有 ${world.wolves.length} 头野兽醒了过来。`);
}

function updateWolves(world) {
  for (const w of world.wolves) {
    let best = null;
    let bd = 1e9;
    for (const a of world.agents) {
      if (!a.alive) continue;
      const d = Math.abs(a.x - w.x) + Math.abs(a.y - w.y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (!best) continue;

    if (bd <= 1) {
      if (world.tick >= w.cooldown) {
        w.cooldown = world.tick + 2;
        best.hp -= 4;
        emitSound(world, best.x, best.y, 16, 'scream', '有人被咬时的惨叫', best.id);
        logEvent(world, 'wolf', `野兽咬伤了${best.name}。`, best.id);
        remember(best, '野兽咬伤了你。');
        if (best.hp <= 0) kill(world, best, '被野兽咬死了。');
      }
    } else if (bd <= 14) {
      const dx = Math.sign(best.x - w.x);
      const dy = Math.sign(best.y - w.y);
      let nx = w.x;
      let ny = w.y;
      if (Math.abs(best.x - w.x) > Math.abs(best.y - w.y)) nx += dx;
      else ny += dy;
      if (isWalkable(world, nx, ny) && !nearFire(world, nx, ny, 2)) {
        w.x = nx;
        w.y = ny;
      }
    }
  }
}

function updateStructures(world) {
  for (const s of world.structures) {
    if (s.type === 'fire' && typeof s.fuel === 'number') {
      s.fuel -= 1;
      if (s.fuel <= 0) {
        world.structures = world.structures.filter((o) => o !== s);
        logEvent(world, 'fire', '一堆火灭了。');
      }
    }
  }
}

export function tick(world) {
  if (world.config.paused) return;
  world.tick++;
  const minute = world.tick % TICKS_PER_DAY;
  world.day = Math.floor(world.tick / TICKS_PER_DAY) + 1;
  world.clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  world.isNight = minute < 360 || minute >= 1080;

  if (world.isNight && !world.nightActive) {
    world.nightActive = true;
    spawnWolves(world);
  } else if (!world.isNight && world.nightActive) {
    world.nightActive = false;
    if (world.wolves.length) logEvent(world, 'day', '天亮了，野兽退回了黑暗里。');
    world.wolves = [];
  }

  for (const a of world.agents) stepAgent(world, a);
  updateWolves(world);
  updateStructures(world);

  if (world.regrow.length) {
    const due = world.regrow.filter((r) => r.at <= world.tick);
    if (due.length) {
      world.regrow = world.regrow.filter((r) => r.at > world.tick);
      for (const r of due) {
        const idx = r.y * W + r.x;
        if (world.map[idx] !== TILE.GRASS) continue;
        const blocked = world.structures.some(
          (s) => s.x === r.x && s.y === r.y && ['fire', 'shelter', 'wall', 'camp'].includes(s.type)
        );
        if (blocked) continue;
        if (world.agents.some((a) => a.alive && a.x === r.x && a.y === r.y)) {
          world.regrow.push({ ...r, at: world.tick + 120 });
          continue;
        }
        world.map[idx] = r.tile;
      }
    }
  }

  if (world.sounds.length) {
    world.sounds = world.sounds.filter((s) => world.tick - s.tick <= 12);
  }
}

// ---------- 存档与加载 ----------
// 存档只包含世界与事件；密钥、模型配置、进行中的模型调用都不入档。

function copyEvent(e) {
  return {
    ...e,
    payload: e.payload
      ? { ...e.payload, action: e.payload.action ? { ...e.payload.action } : e.payload.action }
      : null,
  };
}

function copyAgentForStorage(a, deciding) {
  return {
    ...a,
    inventory: { ...a.inventory },
    tags: { ...a.tags },
    skills: { ...BASE_SKILLS, ...a.skills },
    knows: { ...emptyKnows(), ...a.knows },
    learning: { ...a.learning },
    relationships: { ...a.relationships },
    memory: [...a.memory],
    beliefs: (a.beliefs || []).map((b) => ({ ...b })),
    trace: a.trace.map((t) => ({ ...t })),
    action: a.action ? { ...a.action } : null,
    queuedAction: a.queuedAction ? { ...a.queuedAction } : null,
    // 进行中的模型调用不会跨进程存活；存档时统一归一化。
    deciding,
    useLLM: false,
  };
}

export function serializeWorld(world) {
  return {
    version: 1,
    seed: world.seed,
    tick: world.tick,
    day: world.day,
    clock: world.clock,
    isNight: world.isNight,
    nightActive: world.nightActive,
    map: Array.from(world.map),
    agents: world.agents.map((a) => copyAgentForStorage(a, false)),
    structures: world.structures.map((s) => ({ ...s })),
    wolves: world.wolves.map((w) => ({ ...w })),
    log: world.log.map(copyEvent),
    eventLog: world.eventLog.map(copyEvent),
    facts: world.facts.map((f) => ({ ...f })),
    nextSeq: world.nextSeq,
    nextFactId: world.nextFactId,
    nextBeliefId: world.nextBeliefId,
    decisionLog: world.decisionLog.map((d) => ({ ...d, action: { ...d.action } })),
    sounds: world.sounds.map((s) => ({ ...s })),
    regrow: world.regrow.map((r) => ({ ...r })),
    nextWolfId: world.nextWolfId,
    config: { paused: world.config.paused, speed: world.config.speed },
    api: {},
    rngState: world.rng.getState(),
  };
}

export function loadWorld(data) {
  const rng = mulberry32(0);
  rng.setState(data.rngState);

  return {
    seed: data.seed,
    tick: data.tick,
    day: data.day,
    clock: data.clock,
    isNight: data.isNight,
    nightActive: data.nightActive,
    map: Uint8Array.from(data.map),
    agents: data.agents.map((a) => copyAgentForStorage(a, false)),
    structures: data.structures.map((s) => ({ ...s })),
    wolves: data.wolves.map((w) => ({ ...w })),
    log: data.log.map(copyEvent),
    eventLog: data.eventLog.map(copyEvent),
    facts: (data.facts || []).map((f) => ({ ...f })),
    nextSeq: data.nextSeq,
    nextFactId: data.nextFactId || 1,
    nextBeliefId: data.nextBeliefId || 1,
    decisionLog: (data.decisionLog || []).map((d) => ({ ...d, action: { ...d.action } })),
    replay: null,
    sounds: data.sounds.map((s) => ({ ...s })),
    regrow: data.regrow.map((r) => ({ ...r })),
    nextWolfId: data.nextWolfId,
    config: { paused: false, speed: 1, llmAgents: 0, ...data.config },
    api: { provider: 'openai', base: '', key: '', model: '' },
    rng,
    pendingDecisions: [],
    inflight: 0,
    llmCalls: 0,
    llmErrors: 0,
    llmLastError: '',
  };
}

export function replayDecisions(world, decisions) {
  world.replay = {
    queue: decisions.map((d) => ({ ...d, action: { ...d.action } })),
    index: 0,
  };
  world.pendingDecisions = [];
  return world;
}

export function snapshot(world) {
  return {
    tick: world.tick,
    day: world.day || 1,
    clock: world.clock || '08:00',
    isNight: !!world.isNight,
    paused: world.config.paused,
    speed: world.config.speed,
    map: world.map.join(''),
    population: world.agents.filter((a) => a.alive).length,
    agents: world.agents.map((a) => ({
      id: a.id,
      name: a.name,
      x: a.x,
      y: a.y,
      alive: a.alive,
      color: a.color,
      hp: Math.round(a.hp),
      hunger: Math.round(a.hunger),
      energy: Math.round(a.energy),
      action: a.action ? a.action.type : 'idle',
      facing: a.facing || 'S',
      lastAction: a.lastAction || '',
      trace: a.trace.slice(-20),
      reputation: Math.round(a.reputation),
      tags: a.tags,
      skills: { ...a.skills },
      knows: { ...a.knows },
      learning: { ...a.learning },
      memory: a.memory.slice(-20),
      letter: a.letter,
      useLLM: a.useLLM,
      lastSay: a.lastSay,
      inventory: { ...a.inventory },
    })),
    structures: world.structures.map((s) => ({ type: s.type, x: s.x, y: s.y, name: s.name })),
    wolves: world.wolves.map((w) => ({ id: w.id, x: w.x, y: w.y, hp: w.hp })),
    log: world.log.slice(-40),
    returnSummary: world.returnSummary || null,
    apiConfigured: !!world.api.key,
    llmAgents: world.config.llmAgents,
    llmCalls: world.llmCalls || 0,
    llmErrors: world.llmErrors || 0,
    llmLastError: world.llmLastError || '',
  };
}
