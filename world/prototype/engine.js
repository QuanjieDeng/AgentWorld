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

const LANGUAGES = {
  north: { label: '北岸话' },
  south: { label: '南渡话' },
  outland: { label: '外来话' },
};

export const LANGUAGE_KEYS = Object.freeze(Object.keys(LANGUAGES));

export const LANGUAGE_LABEL = Object.fromEntries(
  Object.entries(LANGUAGES).map(([key, value]) => [key, value.label])
);

const HOMETOWN_LANGUAGE = { 北岸: 'north', 南渡: 'south', 外来: 'outland' };

export const ORIGIN_HOMETOWN = {
  小城教师: '北岸',
  农妇: '北岸',
  铁匠: '北岸',
  医生: '北岸',
  渔夫: '南渡',
  少女: '南渡',
  木匠: '南渡',
  猎人: '南渡',
  青年: '外来',
  教师: '外来',
  石匠: '外来',
  流浪者: '外来',
};

export function sharedLanguage(a, b) {
  return Object.keys(a.languages).find((language) => b.languages[language]) || null;
}

function learnLanguage(agent, language, rate) {
  if (agent.languages[language]) return true;
  const progress = Math.min(
    1,
    (agent.languageProgress[language] || 0) + rate * growthMultiplier(agent, 'talk')
  );
  if (progress >= 1) {
    agent.languages[language] = true;
    delete agent.languageProgress[language];
    return true;
  }
  agent.languageProgress[language] = progress;
  return false;
}

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
    remains: [],
    chronicle: [],
    nextChronicleId: 1,
    institutions: [],
    nextInstitutionId: 1,
    pendingTurnings: [],
    pendingDecisions: [],
    rng: mulberry32(seed ^ 0x9e3779b9),
    config: { paused: false, speed: 1, llmAgents: 0, distortionChance: DEFAULT_DISTORTION },
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
    const hometown = ORIGIN_HOMETOWN[c.origin] || '北岸';
    const nativeLanguage = HOMETOWN_LANGUAGE[hometown] || 'north';
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
      tags: {
        origin: c.origin,
        hometown,
        obsession: c.obsession,
        aptitude: c.aptitude,
        wound: c.wound,
      },
      skills,
      knows,
      learning: {},
      nativeLanguage,
      languages: { [nativeLanguage]: true },
      languageProgress: {},
      heirId: null,
      heirKind: null,
      mentorId: null,
      inheritedObsession: null,
      inheritedFrom: null,
      identity: null,
      turningPoints: [],
      maxTurnings: 2 + Math.floor(buildRng() * 4),
      hasProposedInstitution: false,
      exiledUntil: 0,
      lastRitualDay: 0,
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

export function deliverLetter(world, agent, text) {
  const inChain = !!(agent.mentorId || agent.heirId);
  if (!inChain) {
    logEvent(world, 'letter', `${agent.name}听见了一个声音，但没有听懂。`, agent.id, {
      text,
      heard: false,
    });
    remember(agent, '你听见了一个声音，但没有听懂。');
    return false;
  }
  agent.letter = text;
  remember(agent, `你听见一个声音说：「${text}」`);
  logEvent(world, 'letter', `一个声音在${agent.name}耳边说：「${text}」`, agent.id, {
    text,
    heard: true,
  });
  return true;
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

function copyClaim(claim) {
  return claim ? { ...claim } : null;
}

export function recordBelief(world, agent, proposition, source, confidence = 0.8, claim = null) {
  const entry = {
    id: 'b' + world.nextBeliefId++,
    t: world.tick,
    proposition,
    source,
    confidence,
    claim: copyClaim(claim),
  };
  agent.beliefs.push(entry);
  if (agent.beliefs.length > 200) agent.beliefs.shift();
  return entry;
}

const PREDICATE_LADDER = {
  said: ['said', 'threatened'],
  died: ['died', 'was killed'],
  hit: ['hit', 'wounded', 'killed'],
  built: ['built', 'burned'],
};

const DEFAULT_DISTORTION = 0.55;

const PLACES = ['水边', '营地', '树林', '废墟', '空地'];

const BUILD_NAMES = { fire: '火堆', shelter: '窝棚', wall: '墙' };

const HEIR_KINDS = { adopted: '养子', apprentice: '徒弟' };

export const INSTITUTION_SCHEMAS = {
  law: {
    action: ['attack'],
    place: ['camp', 'anywhere'],
    subject: ['anyone', 'members', 'outsiders'],
    weapon: ['any', 'armed'],
    reputation: ['any', 'low'],
    penalty: ['reputation', 'exile'],
  },
  doctrine: {
    taboo: ['attack'],
    ritual: ['campAtNight', 'buryDead'],
    when: ['always', 'night'],
  },
  faction: {
    name: 'text',
    shared: ['yes', 'no'],
    joinRequirement: ['trust', 'reputation'],
  },
};

const INSTITUTION_LABEL = { law: '律法', doctrine: '教义', faction: '结社' };

const TABOO_LABEL = { attack: '动手伤人' };
const PLACE_LABEL = { camp: '营地', anywhere: '任何地方' };
const SUBJECT_LABEL = { anyone: '所有人', members: '结社成员', outsiders: '结社外的人' };
const WEAPON_LABEL = { any: '不论是否持械', armed: '持械者' };
const REPUTATION_LABEL = { any: '不论声望', low: '声望低的人' };
const PENALTY_LABEL = { reputation: '扣减声望', exile: '驱逐' };
const RITUAL_LABEL = { campAtNight: '夜里回到营地', buryDead: '埋葬死者' };
const WHEN_LABEL = { always: '任何时候', night: '夜里' };
const JOIN_LABEL = { trust: '关系够近', reputation: '声望够高' };

export const MIN_FACTION_RELATION = 15;

function validateInstitution(kind, slots) {
  const schema = INSTITUTION_SCHEMAS[kind];
  if (!schema) return { ok: false, reasons: [`未知的制度类型：${kind}`] };
  if (!slots || typeof slots !== 'object') return { ok: false, reasons: ['槽位必须是对象'] };

  const reasons = [];
  for (const key of Object.keys(slots)) {
    if (!(key in schema)) reasons.push(`未知槽位：${key}`);
  }

  const normalized = {};
  for (const [key, rule] of Object.entries(schema)) {
    const value = slots[key];
    if (value === undefined) {
      reasons.push(`缺少槽位：${key}`);
      continue;
    }
    if (rule === 'text') {
      const text = String(value || '').trim().slice(0, 12);
      if (!text) reasons.push(`${key} 不能为空`);
      else normalized[key] = text;
    } else if (!rule.includes(value)) {
      reasons.push(`${key} 只能是：${rule.join(' / ')}`);
    } else {
      normalized[key] = value;
    }
  }

  return reasons.length ? { ok: false, reasons } : { ok: true, slots: normalized };
}

export function describeInstitution(inst) {
  if (inst.kind === 'law') {
    const s = inst.slots;
    return `禁止${TABOO_LABEL[s.action]}（${PLACE_LABEL[s.place]}；针对${SUBJECT_LABEL[s.subject]}；${WEAPON_LABEL[s.weapon]}；${REPUTATION_LABEL[s.reputation]}），违者${PENALTY_LABEL[s.penalty]}。`;
  }
  if (inst.kind === 'doctrine') {
    const s = inst.slots;
    return `禁忌：${TABOO_LABEL[s.taboo]}（${WHEN_LABEL[s.when]}）；仪式：${RITUAL_LABEL[s.ritual]}。`;
  }
  const s = inst.slots;
  return `结社「${s.name}」，加入条件：${JOIN_LABEL[s.joinRequirement]}；共同财产：${s.shared === 'yes' ? '是' : '否'}。`;
}

export const TURNING_TRIGGERS = {
  killed: { labels: ['手上带血的人', '复仇者', '幸存者'] },
  enemy_died: { labels: ['释怀的人', '空下来的人'] },
  kin_died: { labels: ['守墓人', '断后的人'] },
  betrayed: { labels: ['独行者', '不再相信人的人'] },
  leader: { labels: ['首领', '被追随的人'] },
  hunted: { labels: ['猎手', '不怕夜的人'] },
};

function nameOf(world, id) {
  return world.agents.find((a) => a.id === id)?.name || '某个人';
}

function dayOf(t) {
  return Math.floor(t / TICKS_PER_DAY) + 1;
}

function placeName(world, x, y) {
  const tile = world.map[y * W + x];
  if (tile === TILE.WATER) return '水边';
  if (world.structures.some((s) => s.type === 'camp' && Math.abs(s.x - x) + Math.abs(s.y - y) <= 3)) return '营地';
  if (tile === TILE.TREE) return '树林';
  if (tile === TILE.RUIN) return '废墟';
  return '空地';
}

function distortClaim(world, claim) {
  const chance = world.config.distortionChance ?? DEFAULT_DISTORTION;
  if (world.rng() >= chance) return { ...claim };

  const distorted = { ...claim };
  const options = [];
  if (typeof distorted.quantity === 'number') options.push('quantity');
  if (typeof distorted.time === 'number') options.push('time');
  if (distorted.place) options.push('place');
  if (distorted.targetId) options.push('dropTarget');
  if (PREDICATE_LADDER[distorted.predicate]) options.push('predicate');
  if (!options.length) return distorted;

  const op = options[Math.floor(world.rng() * options.length)];
  if (op === 'quantity') distorted.quantity += 1 + Math.floor(world.rng() * 3);
  if (op === 'time') distorted.time = Math.max(0, distorted.time - (1 + Math.floor(world.rng() * 3)) * TICKS_PER_DAY);
  if (op === 'place') {
    const elsewhere = PLACES.filter((p) => p !== distorted.place);
    distorted.place = elsewhere[Math.floor(world.rng() * elsewhere.length)];
  }
  if (op === 'dropTarget') delete distorted.targetId;
  if (op === 'predicate') {
    const ladder = PREDICATE_LADDER[distorted.predicate];
    const index = ladder.indexOf(distorted.predicate);
    distorted.predicate = ladder[Math.min(ladder.length - 1, index + 1)];
  }
  return distorted;
}

function renderClaim(world, claim) {
  const subject = nameOf(world, claim.subjectId);
  const where = claim.place ? `在${claim.place}` : '';
  const when = typeof claim.time === 'number' ? `第${dayOf(claim.time)}天` : '';
  if (claim.kind === 'death') {
    return claim.predicate === 'was killed' ? `${subject}被人杀了。` : `${subject}死了。${claim.object || ''}`;
  }
  if (claim.kind === 'build') {
    const what = BUILD_NAMES[claim.object] || claim.object;
    return claim.predicate === 'burned'
      ? `${subject}${when}${where}烧了${what}。`
      : `${subject}${when}${where}建了${what}。`;
  }
  if (claim.kind === 'talk') {
    return claim.predicate === 'threatened'
      ? `${subject}${when}${where}威胁说：「${claim.object}」`
      : `${subject}${when}${where}说：「${claim.object}」`;
  }
  if (claim.kind === 'gather') {
    const what = claim.object === 'stone' ? '石头' : '食物';
    return `${subject}${when}${where}采到了${claim.quantity ?? 1}份${what}。`;
  }
  if (claim.kind === 'fight') {
    const target = nameOf(world, claim.targetId);
    if (claim.predicate === 'killed') return `${subject}打死了${target}。`;
    if (claim.predicate === 'wounded') return `${subject}打伤了${target}。`;
    return `${subject}打了${target}。`;
  }
  if (claim.kind === 'teach') {
    const lesson =
      KNOWLEDGE_LABEL[claim.object] || LANGUAGE_LABEL[claim.object] || claim.object;
    return `${subject}教了${nameOf(world, claim.targetId)}${lesson}。`;
  }
  return `你听说了一件关于${subject}的事。`;
}

function retellBelief(world, speaker, listener) {
  const eligible = (b) =>
    b.claim &&
    b.confidence > 0.05 &&
    b.claim.subjectId !== listener.id &&
    !listener.beliefs.some(
      (heard) =>
        heard.claim && heard.claim.kind === b.claim.kind && heard.claim.subjectId === b.claim.subjectId
    );
  // 先说别人的事；没有别人的事，才说自己的。死亡比闲话更值得传。
  const rank = { death: 0, fight: 1, build: 2, gather: 3, teach: 4, talk: 5 };
  const source = speaker.beliefs
    .map((belief, index) => ({ belief, index }))
    .filter(({ belief }) => eligible(belief))
    .sort((a, b) => {
      const aboutSpeaker = (x) => (x.belief.claim.subjectId === speaker.id ? 1 : 0);
      return (
        aboutSpeaker(a) - aboutSpeaker(b) ||
        (rank[a.belief.claim.kind] ?? 9) - (rank[b.belief.claim.kind] ?? 9) ||
        a.index - b.index
      );
    })[0]?.belief;
  if (!source) return null;

  const claim = distortClaim(world, source.claim);
  const confidence = Math.max(0.05, source.confidence * 0.8);
  logEvent(world, 'retell', `${speaker.name}对${listener.name}说起${nameOf(world, claim.subjectId)}。`, speaker.id, {
    claim: { ...claim },
  });
  const belief = recordBelief(world, listener, renderClaim(world, claim), 'hearsay', confidence, claim);
  belief.sourceAgentId = speaker.id;
  return belief;
}

function recordTeaching(world, teacher, student, { key, kind, label }) {
  const completed = kind === 'knowledge' || kind === 'language';
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
    completed ? 0.95 : 0.8,
    { kind: 'teach', subjectId: teacher.id, predicate: 'taught', object: key, targetId: student.id }
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
    case 'adopt': return '收养或收徒';
    case 'moveIn': return '搬进去或收下遗产';
    case 'bury': return '埋葬死者';
    case 'propose': return '立下制度';
    case 'join': return '加入结社';
    case 'interpret': return '争夺制度的解释';
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

export function kill(world, a, cause, killerId = null) {
  if (!a.alive) return;
  a.alive = false;
  a.hp = 0;
  a.action = null;
  a.queuedAction = null;
  world.structures.push({
    type: 'grave',
    x: a.x,
    y: a.y,
    name: a.name,
    agentId: a.id,
    buried: false,
  });
  const claim = {
    kind: 'death',
    subjectId: a.id,
    predicate: 'died',
    object: cause,
    killerId: killerId || null,
  };
  const death = logEvent(world, 'death', `${a.name}死了。${cause}`, a.id);
  recordFact(world, {
    type: 'death',
    subjectId: a.id,
    predicate: 'died',
    object: cause,
    killerId: killerId || null,
    eventSeq: death.seq,
  });
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
      recordBelief(world, other, renderClaim(world, claim), 'witness', 0.9, claim);

      if ((other.relationships[a.id] || 0) < -15 || (a.relationships[other.id] || 0) < -15) {
        maybeTurn(world, other, 'enemy_died', `你恨的${a.name}死了。`);
      }
    }
  }

  if (killerId) {
    const killer = world.agents.find((agent) => agent.id === killerId && agent.alive);
    if (killer) maybeTurn(world, killer, 'killed', `你杀死了${a.name}，并且活了下来。`);
  }

  resolveInheritance(world, a);
  updateFactionLeadership(world, a);
}

export function turningFallbackLabel(world, trigger) {
  const labels = TURNING_TRIGGERS[trigger]?.labels || ['幸存者'];
  return labels[Math.floor(world.rng() * labels.length)];
}

function canTurn(agent, trigger) {
  return (
    !!TURNING_TRIGGERS[trigger] &&
    agent.alive &&
    agent.turningPoints.length < agent.maxTurnings &&
    !agent.turningPoints.some((t) => t.trigger === trigger)
  );
}

export function applyTurning(world, agent, trigger, label, reason) {
  const definition = TURNING_TRIGGERS[trigger];
  if (!definition || !canTurn(agent, trigger)) return null;

  const chosen = definition.labels.includes(label) ? label : definition.labels[0];
  const turning = Object.freeze({
    t: world.tick,
    day: world.day || 1,
    trigger,
    label: chosen,
    reason,
    x: agent.x,
    y: agent.y,
  });
  agent.turningPoints.push(turning);
  agent.identity = chosen;
  agent.reputation += 5;

  const event = logEvent(world, 'turning', `${agent.name}脱变成了${chosen}。${reason}`, agent.id, {
    trigger,
    label: chosen,
  });
  recordFact(world, {
    type: 'turning',
    subjectId: agent.id,
    predicate: 'became',
    object: chosen,
    trigger,
    reason,
    x: agent.x,
    y: agent.y,
    eventSeq: event.seq,
  });
  recordBelief(world, agent, `你成了${chosen}。${reason}`, 'self', 1);
  world.chronicle.push(
    Object.freeze({
      id: `c${world.nextChronicleId++}`,
      t: world.tick,
      day: world.day || 1,
      kind: 'turning',
      agentId: agent.id,
      label: chosen,
      trigger,
      reason,
      x: agent.x,
      y: agent.y,
    })
  );
  return turning;
}

export function maybeTurn(world, agent, trigger, reason) {
  if (!agent || !canTurn(agent, trigger)) return null;

  if (world.api.key && agent.useLLM && !world.ruleOnly) {
    world.pendingTurnings.push({ agentId: agent.id, trigger, reason });
    return null;
  }
  return applyTurning(world, agent, trigger, turningFallbackLabel(world, trigger), reason);
}

function factionOf(world, agentId) {
  return (
    world.institutions.find(
      (inst) => inst.kind === 'faction' && inst.active && inst.members.includes(agentId)
    ) || null
  );
}

function sameFaction(world, aId, bId) {
  if (!aId || !bId) return false;
  const faction = factionOf(world, aId);
  return !!faction && faction.slots.shared === 'yes' && faction.members.includes(bId);
}

function rejectInstitution(world, agent, kind, reasons) {
  logEvent(
    world,
    'institution',
    `${agent.name}的${INSTITUTION_LABEL[kind] || kind}提案被驳回：${reasons.join('；')}`,
    agent.id,
    { ok: false, reasons }
  );
  return { ok: false, reasons };
}

export function proposeInstitution(world, agent, kind, slots) {
  if (!agent.alive) return { ok: false, reasons: ['死人不能立制度'] };
  if ((agent.reputation || 0) < 10) {
    return rejectInstitution(world, agent, kind, ['声望不足以立制度']);
  }

  const checked = validateInstitution(kind, slots);
  if (!checked.ok) return rejectInstitution(world, agent, kind, checked.reasons);

  if (
    kind === 'faction' &&
    world.institutions.some(
      (inst) => inst.kind === 'faction' && inst.active && inst.leaderId === agent.id
    )
  ) {
    return rejectInstitution(world, agent, kind, ['你已经是一个结社的领袖']);
  }

  const institution = {
    id: `i${world.nextInstitutionId++}`,
    kind,
    proposerId: agent.id,
    createdAt: world.tick,
    slots: checked.slots,
    active: true,
    interpretations: {},
  };
  if (kind === 'faction') {
    institution.leaderId = agent.id;
    institution.members = [agent.id];
  }
  world.institutions.push(institution);
  agent.hasProposedInstitution = true;

  const description = describeInstitution(institution);
  const event = logEvent(
    world,
    'institution',
    `${agent.name}立下了${INSTITUTION_LABEL[kind]}：${description}`,
    agent.id,
    { kind, slots: { ...checked.slots } }
  );
  recordFact(world, {
    type: 'institution',
    subjectId: agent.id,
    predicate: 'enacted',
    object: kind,
    slots: { ...checked.slots },
    eventSeq: event.seq,
  });
  world.chronicle.push(
    Object.freeze({
      id: `c${world.nextChronicleId++}`,
      t: world.tick,
      day: world.day || 1,
      kind: 'institution',
      agentId: agent.id,
      label: INSTITUTION_LABEL[kind],
      reason: description,
      x: agent.x,
      y: agent.y,
    })
  );

  if (kind === 'doctrine') {
    for (const other of world.agents) {
      if (other.alive) {
        recordBelief(world, other, `你们的教义：${description}`, 'doctrine', 0.6);
      }
    }
  }

  return { ok: true, institution };
}

export function joinFaction(world, agent, factionId) {
  const faction = world.institutions.find(
    (inst) => inst.id === factionId && inst.kind === 'faction' && inst.active
  );
  if (!faction || faction.members.includes(agent.id)) return false;
  const leader = world.agents.find((a) => a.id === faction.leaderId && a.alive);
  if (!leader) return false;
  const requirementMet =
    faction.slots.joinRequirement === 'reputation'
      ? (agent.reputation || 0) >= 10
      : (agent.relationships[leader.id] || 0) >= MIN_FACTION_RELATION;
  if (!requirementMet) return false;

  faction.members.push(agent.id);
  logEvent(world, 'institution', `${agent.name}加入了结社「${faction.slots.name}」。`, agent.id, {
    factionId: faction.id,
  });
  recordFact(world, {
    type: 'institution',
    subjectId: agent.id,
    predicate: 'joined',
    object: faction.id,
  });
  recordBelief(world, agent, `你加入了${leader.name}的结社「${faction.slots.name}」。`, 'relation', 1);
  return true;
}

function inCamp(world, x, y) {
  return (
    nearFire(world, x, y, 3) ||
    world.structures.some(
      (s) => s.type === 'camp' && Math.abs(s.x - x) + Math.abs(s.y - y) <= 3
    )
  );
}

export function interpretInstitution(world, agent, institutionId, reading) {
  if (!agent.alive || (agent.reputation || 0) < 10) return false;
  if (reading !== 'strict' && reading !== 'lenient') return false;
  const institution = world.institutions.find((inst) => inst.id === institutionId && inst.active);
  if (!institution) return false;

  institution.interpretations[agent.id] = reading;
  logEvent(
    world,
    'institution',
    `${agent.name}声称${INSTITUTION_LABEL[institution.kind]}应当${reading === 'strict' ? '严格执行' : '宽缓处理'}。`,
    agent.id,
    { institutionId, reading }
  );
  recordFact(world, {
    type: 'institution',
    subjectId: agent.id,
    predicate: 'interpreted',
    object: institutionId,
    reading,
  });
  return true;
}

function interpretationWeight(world, agent) {
  const faction = factionOf(world, agent.id);
  return (
    (agent.reputation || 0) +
    (faction?.leaderId === agent.id ? 10 : 0) +
    (faction ? faction.members.length * 2 : 0)
  );
}

function currentReading(world, institution) {
  const living = Object.entries(institution.interpretations)
    .map(([id, reading]) => ({ agent: world.agents.find((a) => a.id === id && a.alive), reading }))
    .filter((entry) => entry.agent)
    .sort((a, b) => interpretationWeight(world, b.agent) - interpretationWeight(world, a.agent));
  return living[0]?.reading || 'strict';
}

function enforceAttack(world, actor, target) {
  const sharesFaction = target ? sameFaction(world, actor.id, target.id) : false;
  const laws = world.institutions.filter((inst) => {
    if (!inst.active || inst.kind !== 'law' || inst.slots.action !== 'attack') return false;
    if (inst.slots.place !== 'anywhere' && !inCamp(world, actor.x, actor.y)) return false;
    if (inst.slots.subject === 'members' && !sharesFaction) return false;
    if (inst.slots.subject === 'outsiders' && sharesFaction) return false;
    if (inst.slots.weapon === 'armed' && !(actor.inventory.weapon > 0)) return false;
    if (inst.slots.reputation === 'low' && !((actor.reputation || 0) < 0)) return false;
    return true;
  });
  const doctrines = world.institutions.filter(
    (inst) =>
      inst.active &&
      inst.kind === 'doctrine' &&
      inst.slots.taboo === 'attack' &&
      (inst.slots.when !== 'night' || world.isNight)
  );

  let punished = false;
  for (const law of laws) {
    const reading = currentReading(world, law);
    const base = law.slots.penalty === 'exile' ? 20 : 10;
    const amount = reading === 'lenient' ? Math.ceil(base / 2) : base;
    actor.reputation -= amount;
    if (law.slots.penalty === 'exile' && reading === 'strict') {
      actor.exiledUntil = world.tick + TICKS_PER_DAY;
    }
    logEvent(world, 'punish', `${actor.name}违反了律法：${describeInstitution(law)}`, actor.id, {
      institutionId: law.id,
      action: 'attack',
    });
    recordFact(world, {
      type: 'punish',
      subjectId: actor.id,
      predicate: 'broke',
      object: law.id,
      action: 'attack',
    });
    punished = true;
  }
  for (const doctrine of doctrines) {
    actor.reputation -= currentReading(world, doctrine) === 'lenient' ? 2 : 5;
    logEvent(world, 'punish', `${actor.name}违反了教义禁忌：${TABOO_LABEL.attack}。`, actor.id, {
      institutionId: doctrine.id,
      action: 'attack',
    });
    recordFact(world, {
      type: 'punish',
      subjectId: actor.id,
      predicate: 'broke',
      object: doctrine.id,
      action: 'attack',
    });
    punished = true;
  }

  if (punished) {
    for (const other of world.agents) {
      if (
        other.alive &&
        other.id !== actor.id &&
        Math.abs(other.x - actor.x) + Math.abs(other.y - actor.y) <= 5
      ) {
        recordBelief(world, other, `${actor.name}${target ? `打了${target.name}，` : ''}触犯了制度。`, 'witness', 0.85);
      }
    }
    remember(actor, '你触犯了这里的制度。');
  }
  return punished;
}

function updateFactionLeadership(world, dead) {
  for (const faction of world.institutions) {
    if (faction.kind !== 'faction' || !faction.active || faction.leaderId !== dead.id) continue;
    faction.members = faction.members.filter((id) =>
      world.agents.some((agent) => agent.id === id && agent.alive)
    );
    if (!faction.members.length) {
      faction.active = false;
      logEvent(world, 'institution', `结社「${faction.slots.name}」散了。`, dead.id);
      continue;
    }
    const next = faction.members
      .map((id) => world.agents.find((agent) => agent.id === id))
      .sort((a, b) => b.reputation - a.reputation)[0];
    faction.leaderId = next.id;
    logEvent(world, 'institution', `${next.name}接手了结社「${faction.slots.name}」。`, next.id);
  }
}

function transferItems(items, inventory) {
  inventory.food += items.food;
  inventory.wood += items.wood;
  inventory.stone += items.stone;
  inventory.weapon = Math.max(inventory.weapon, items.weapon);
}

function copyRemains(remains) {
  return { ...remains, items: { ...remains.items } };
}

function resolveInheritance(world, dead) {
  const heir = dead.heirId ? world.agents.find((a) => a.id === dead.heirId && a.alive) : null;

  if (heir) {
    transferItems(dead.inventory, heir.inventory);
    for (const skill of SKILL_KEYS) {
      const diff = (dead.skills[skill] || 0) - (heir.skills[skill] || 0);
      if (diff > 0) growSkill(heir, skill, diff * 0.5);
    }
    // 只有徒弟继承手艺里的“怎么做”；养子得到的是家当，不是知识。
    if (dead.heirKind === 'apprentice') {
      for (const key of KNOWLEDGE_KEYS) {
        if (dead.knows[key]) heir.knows[key] = true;
      }
    }
    for (const belief of dead.beliefs.slice(-20)) {
      recordBelief(
        world,
        heir,
        belief.proposition,
        'inherited',
        Math.max(0.05, belief.confidence * 0.6),
        belief.claim
      );
    }
    heir.inheritedObsession = dead.tags.obsession;
    heir.inheritedFrom = dead.name;
    recordBelief(world, heir, `${dead.name}没能做完的事：${dead.tags.obsession}`, 'inherited', 0.9);
    for (const structure of world.structures) {
      if (structure.ownerId === dead.id) structure.ownerId = heir.id;
    }
    const title = HEIR_KINDS[dead.heirKind] || '继承人';
    const event = logEvent(
      world,
      'inherit',
      `${dead.name}把留下来的一切交给了${title}${heir.name}。`,
      dead.id,
      { heirId: heir.id }
    );
    recordFact(world, {
      type: 'inherit',
      subjectId: dead.id,
      predicate: 'inheritedBy',
      object: heir.id,
      eventSeq: event.seq,
    });
    remember(heir, `你继承了${dead.name}留下的一切。`);
    return;
  }

  const items = dead.inventory;
  if (items.food || items.wood || items.stone || items.weapon) {
    world.remains.push({ x: dead.x, y: dead.y, name: dead.name, items: { ...items } });
  }
  for (const structure of world.structures) {
    if (structure.ownerId === dead.id) structure.ownerId = null;
  }
  logEvent(world, 'inherit', `${dead.name}没有继承人，留下了一座空宅。`, dead.id);
}

function damage(world, target, amount, by) {
  target.hp -= amount;
  if (target.hp <= 0 && target.alive) {
    kill(world, target, by ? `死在${by.name}手里。` : '伤重而死。', by?.id || null);
  }
}

// 亲眼看见一个人还活着，就会推翻“他死了”的信念。事实不搬家，信念会。
function correctBeliefs(world, a) {
  for (const belief of [...a.beliefs]) {
    if (belief.corrected || belief.claim?.kind !== 'death') continue;
    const subject = world.agents.find((o) => o.id === belief.claim.subjectId);
    if (!subject || !subject.alive) continue;
    if (Math.abs(subject.x - a.x) + Math.abs(subject.y - a.y) > 3) continue;
    belief.corrected = true;
    belief.confidence = 0;
    recordBelief(world, a, `${subject.name}还活着。我亲眼看见了。`, 'saw', 1);
    remember(a, `你看见了${subject.name}，他还活着。`);
  }
}

function learnByProximity(world, a) {
  for (const other of world.agents) {
    if (!other.alive || other.id === a.id) continue;
    if (Math.abs(other.x - a.x) + Math.abs(other.y - a.y) > 1) continue;
    if (a.languages[other.nativeLanguage]) continue;
    if (learnLanguage(a, other.nativeLanguage, 0.0004)) {
      remember(
        a,
        `你和${other.name}待久了，听懂了${LANGUAGE_LABEL[other.nativeLanguage]}。`
      );
    }
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

  correctBeliefs(world, a);
  learnByProximity(world, a);

  if (world.isNight && nearFire(world, a.x, a.y, 3) && a.lastRitualDay !== (world.day || 1)) {
    const hasRitual = world.institutions.some(
      (inst) => inst.active && inst.kind === 'doctrine' && inst.slots.ritual === 'campAtNight'
    );
    if (hasRitual) {
      a.lastRitualDay = world.day || 1;
      a.reputation += 2;
      remember(a, '你按教义回到了火边。');
    }
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
      if (a.exiledUntil > world.tick && inCamp(world, nx, ny)) {
        a.lastAction = '你被驱逐，不能回到营地';
        recordTrace(world, a, a.lastAction);
        endAction(world, a, 2);
        return;
      }
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
      recordFact(world, {
        type: 'gather',
        subjectId: a.id,
        predicate: 'gathered',
        object: spot.t === TILE.ROCK ? 'stone' : 'food',
        quantity: spot.t === TILE.BUSH ? 2 : 1,
        x: a.x,
        y: a.y,
      });
      recordBelief(world, a, `你采到了一些东西。`, 'did', 1, {
        kind: 'gather',
        subjectId: a.id,
        predicate: 'gathered',
        object: spot.t === TILE.ROCK ? 'stone' : 'food',
        quantity: spot.t === TILE.BUSH ? 2 : 1,
        place: placeName(world, a.x, a.y),
        time: world.tick,
      });
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
          recordFact(world, {
            type: 'fish',
            subjectId: a.id,
            predicate: 'caught',
            object: 'fish',
            quantity: 1,
            x: a.x,
            y: a.y,
          });
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
        recordFact(world, {
          type: 'plant',
          subjectId: a.id,
          predicate: 'planted',
          object: 'bush',
          x: a.x,
          y: a.y,
        });
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
        const s = { type: act.build, x: a.x, y: a.y, ownerId: a.id };
        if (act.build === 'fire') s.fuel = 600;
        world.structures.push(s);
        const madeCamp =
          act.build === 'fire' &&
          !world.structures.some((o) => o.type === 'camp' && Math.abs(o.x - a.x) + Math.abs(o.y - a.y) <= 3);
        if (madeCamp) world.structures.push({ type: 'camp', x: a.x, y: a.y, ownerId: a.id });
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
        recordBelief(world, a, `你建起了${names[act.build] || act.build}。`, 'did', 1, {
          kind: 'build',
          subjectId: a.id,
          predicate: 'built',
          object: act.build,
          place: placeName(world, a.x, a.y),
          time: world.tick,
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
        const shared = sharedLanguage(a, target);
        const understood = !!shared;
        const spokenLanguage = shared || a.nativeLanguage;
        const delta = understood ? 2 + Math.floor(world.rng() * 4) : 1 + Math.floor(world.rng() * 2);
        a.relationships[target.id] = (a.relationships[target.id] || 0) + delta;
        target.relationships[a.id] = (target.relationships[a.id] || 0) + delta;
        growSkill(a, 'talk', 0.04);

        if (say) {
          const spoken = logEvent(world, 'talk', `${a.name}对${target.name}说：「${say}」`, a.id, {
            understood,
            language: spokenLanguage,
          });
          recordFact(world, {
            type: 'talk',
            subjectId: a.id,
            predicate: 'said',
            object: say,
            targetId: target.id,
            language: spokenLanguage,
            understood,
            eventSeq: spoken.seq,
          });

          if (understood) {
            recordBelief(world, target, `${a.name}说：「${say}」`, 'told', 0.6, {
              kind: 'talk',
              subjectId: a.id,
              predicate: 'said',
              object: say,
              place: placeName(world, a.x, a.y),
              time: world.tick,
            });
            remember(a, `你对${target.name}说：「${say}」`);
            remember(target, `${a.name}对你说：「${say}」`);
            if ((target.reputation || 0) >= 10 && (a.relationships[target.id] || 0) >= 15) {
              maybeTurn(world, target, 'leader', `${a.name}把你当成了主心骨。`);
            }
            retellBelief(world, a, target);
          } else {
            remember(a, `你对${target.name}说了一句他不明白的话。`);
            remember(target, `${a.name}对你说了一句听不懂的话。`);
            if (learnLanguage(target, spokenLanguage, 0.03)) {
              remember(target, `你听懂了${LANGUAGE_LABEL[spokenLanguage]}。`);
            }
          }

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

      if (LANGUAGE_KEYS.includes(key) && a.languages[key] && !target.languages[key]) {
        const learned = learnLanguage(target, key, 0.34);
        a.energy = Math.max(0, a.energy - 2);
        growSkill(a, 'teach', 0.2);
        taught = true;
        if (learned) {
          recordTeaching(world, a, target, { key, kind: 'language', label: LANGUAGE_LABEL[key] });
        } else {
          logEvent(world, 'teach', `${a.name}在教${target.name}${LANGUAGE_LABEL[key]}。`, a.id);
          remember(a, `你在教${target.name}${LANGUAGE_LABEL[key]}。`);
          remember(target, `${a.name}在教你${LANGUAGE_LABEL[key]}。`);
        }
      }

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
        taught = true;
      }

      if (taught) {
        a.relationships[target.id] = (a.relationships[target.id] || 0) + 4;
        target.relationships[a.id] = (target.relationships[a.id] || 0) + 4;
      }
      break;
    }

    case 'adopt': {
      if (act.remaining > 0) break;
      const target = world.agents.find((o) => o.id === act.target && o.alive);
      if (!target || !adjacent(a, target)) break;
      if ((a.relationships[target.id] || 0) < 20) {
        remember(a, '你们还没有熟到那个地步。');
        break;
      }
      const kind = act.kind === 'apprentice' ? 'apprentice' : 'adopted';
      const label = kind === 'apprentice' ? '收下了一个徒弟' : '收养了一个人';
      a.heirId = target.id;
      a.heirKind = kind;
      target.mentorId = a.id;
      a.energy = Math.max(0, a.energy - 2);
      const event = logEvent(world, 'adopt', `${a.name}${label}：${target.name}。`, a.id, {
        targetId: target.id,
        kind,
      });
      recordFact(world, {
        type: 'adopt',
        subjectId: a.id,
        predicate: 'adopted',
        object: target.id,
        kind,
        eventSeq: event.seq,
      });
      recordBelief(world, target, `${a.name}${label}。`, 'relationship', 0.95, {
        kind: 'adopt',
        subjectId: a.id,
        predicate: 'adopted',
        object: target.id,
      });
      remember(a, `你${label}：${target.name}。他会继承你留下的一切。`);
      remember(target, `${a.name}${label}你。`);
      break;
    }

    case 'propose': {
      if (act.remaining > 0) break;
      proposeInstitution(world, a, act.kind, act.slots || {});
      break;
    }

    case 'join': {
      if (act.remaining > 0) break;
      joinFaction(world, a, act.faction);
      break;
    }

    case 'interpret': {
      if (act.remaining > 0) break;
      interpretInstitution(world, a, act.institution, act.reading);
      break;
    }

    case 'bury': {
      if (act.remaining > 0) break;
      const grave = world.structures.find(
        (s) =>
          s.type === 'grave' &&
          !s.buried &&
          Math.abs(s.x - a.x) + Math.abs(s.y - a.y) <= 1
      );
      if (!grave) {
        remember(a, '这里没有需要埋葬的人。');
        break;
      }
      grave.buried = true;
      const dead = world.agents.find((agent) => agent.id === grave.agentId);
      const kin =
        dead &&
        (a.heirId === dead.id ||
          a.mentorId === dead.id ||
          dead.heirId === a.id ||
          dead.mentorId === a.id);

      logEvent(world, 'bury', `${a.name}埋葬了${grave.name}。`, a.id, { deadId: grave.agentId });
      recordFact(world, {
        type: 'bury',
        subjectId: a.id,
        predicate: 'buried',
        object: grave.agentId || grave.name,
        x: grave.x,
        y: grave.y,
      });
      remember(a, `你埋葬了${grave.name}。`);
      if (
        world.institutions.some(
          (inst) => inst.active && inst.kind === 'doctrine' && inst.slots.ritual === 'buryDead'
        )
      ) {
        a.reputation += 3;
        remember(a, '你按教义埋葬了死者。');
      }
      if (kin) maybeTurn(world, a, 'kin_died', `你亲手埋葬了${grave.name}。`);
      break;
    }

    case 'moveIn': {
      if (act.remaining > 0) break;
      let moved = false;

      const shelter = world.structures.find(
        (s) => s.type === 'shelter' && !s.ownerId && Math.abs(s.x - a.x) + Math.abs(s.y - a.y) <= 1
      );
      if (shelter) {
        shelter.ownerId = a.id;
        moved = true;
        logEvent(world, 'settle', `${a.name}搬进了${shelter.name || '一座空宅'}。`, a.id);
        recordFact(world, {
          type: 'settle',
          subjectId: a.id,
          predicate: 'movedIn',
          object: 'shelter',
          x: shelter.x,
          y: shelter.y,
        });
        remember(a, '你搬进了一座空宅。');
      }

      const remains = world.remains.find(
        (r) => Math.abs(r.x - a.x) + Math.abs(r.y - a.y) <= 1
      );
      if (remains) {
        transferItems(remains.items, a.inventory);
        world.remains = world.remains.filter((r) => r !== remains);
        moved = true;
        logEvent(world, 'settle', `${a.name}收下了${remains.name}留下的东西。`, a.id);
        recordFact(world, {
          type: 'settle',
          subjectId: a.id,
          predicate: 'looted',
          object: remains.name,
          x: remains.x,
          y: remains.y,
        });
        remember(a, `你收下了${remains.name}留下的东西。`);
      }

      if (!moved) remember(a, '这里没有可以搬进去的地方。');
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
            maybeTurn(world, a, 'hunted', '你杀死了一头野兽，并且活了下来。');
          }
        }
        break;
      }

      const target = world.agents.find((o) => o.id === act.target && o.alive);
      if (target && adjacent(a, target)) {
        faceToward(a, target.x, target.y);
        const atk = 8 + a.skills.fight * 2 + a.inventory.weapon * 5 + Math.floor(world.rng() * 5);
        const def = target.skills.fight + target.inventory.weapon * 3 + (structureAt(world, target.x, target.y)?.type === 'shelter' ? 3 : 0);
        if ((target.relationships[a.id] || 0) >= 15) {
          maybeTurn(world, target, 'betrayed', `${a.name}对你动了手，而你信任他。`);
        }
        const dmg = Math.max(2, atk - def);
        damage(world, target, dmg, a);
        enforceAttack(world, a, target);
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
        recordBelief(world, target, `${a.name}攻击了你。`, 'victim', 1, {
          kind: 'fight',
          subjectId: a.id,
          predicate: 'hit',
          targetId: target.id,
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
      const shelter = structureAt(world, a.x, a.y);
      const mayUse =
        shelter?.type === 'shelter' &&
        (!shelter.ownerId || shelter.ownerId === a.id || sameFaction(world, a.id, shelter.ownerId));
      if (mayUse) a.energy = Math.min(100, a.energy + 0.2);
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
  if (!e.payload) return { ...e, payload: null };
  const payload = { ...e.payload };
  if (payload.action) payload.action = { ...payload.action };
  if (payload.claim) payload.claim = copyClaim(payload.claim);
  return { ...e, payload };
}

function copyAgentForStorage(a, deciding) {
  return {
    ...a,
    inventory: { ...a.inventory },
    tags: { ...a.tags },
    skills: { ...BASE_SKILLS, ...a.skills },
    knows: { ...emptyKnows(), ...a.knows },
    learning: { ...a.learning },
    languages: { ...a.languages },
    languageProgress: { ...a.languageProgress },
    relationships: { ...a.relationships },
    memory: [...a.memory],
    beliefs: (a.beliefs || []).map((b) => ({ ...b, claim: copyClaim(b.claim) })),
    turningPoints: (a.turningPoints || []).map((t) => Object.freeze({ ...t })),
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
    remains: world.remains.map(copyRemains),
    chronicle: world.chronicle.map((c) => ({ ...c })),
    nextChronicleId: world.nextChronicleId,
    institutions: world.institutions.map((inst) => ({
      ...inst,
      slots: { ...inst.slots },
      interpretations: { ...inst.interpretations },
      ...(inst.members ? { members: [...inst.members] } : {}),
    })),
    nextInstitutionId: world.nextInstitutionId,
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
    config: {
      paused: world.config.paused,
      speed: world.config.speed,
      distortionChance: world.config.distortionChance ?? DEFAULT_DISTORTION,
    },
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
    remains: (data.remains || []).map(copyRemains),
    chronicle: (data.chronicle || []).map((c) => Object.freeze({ ...c })),
    nextChronicleId: data.nextChronicleId || 1,
    institutions: (data.institutions || []).map((inst) => ({
      ...inst,
      slots: { ...inst.slots },
      interpretations: { ...inst.interpretations },
      ...(inst.members ? { members: [...inst.members] } : {}),
    })),
    nextInstitutionId: data.nextInstitutionId || 1,
    pendingTurnings: [],
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
    config: { paused: false, speed: 1, llmAgents: 0, distortionChance: DEFAULT_DISTORTION, ...data.config },
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
      nativeLanguage: a.nativeLanguage,
      languages: { ...a.languages },
      identity: a.identity,
      turningPoints: a.turningPoints.slice(-5).map((t) => ({ ...t })),
      beliefs: a.beliefs.slice(-10).map((b) => ({ ...b, claim: copyClaim(b.claim) })),
      memory: a.memory.slice(-20),
      letter: a.letter,
      useLLM: a.useLLM,
      lastSay: a.lastSay,
      inventory: { ...a.inventory },
    })),
    structures: world.structures.map((s) => ({
      type: s.type,
      x: s.x,
      y: s.y,
      name: s.name,
      ownerId: s.ownerId || null,
      vacant: s.type === 'shelter' && !s.ownerId,
    })),
    remains: world.remains.slice(-10).map(copyRemains),
    chronicle: world.chronicle.slice(-20).map((c) => ({ ...c })),
    institutions: world.institutions.slice(-10).map((inst) => ({
      id: inst.id,
      kind: inst.kind,
      active: inst.active,
      description: describeInstitution(inst),
      leaderId: inst.leaderId || null,
      members: inst.members ? [...inst.members] : [],
    })),
    wolves: world.wolves.map((w) => ({ id: w.id, x: w.x, y: w.y, hp: w.hp })),
    log: world.log.slice(-40),
    facts: world.facts.slice(-20).map((f) => ({ ...f })),
    returnSummary: world.returnSummary || null,
    apiConfigured: !!world.api.key,
    llmAgents: world.config.llmAgents,
    llmCalls: world.llmCalls || 0,
    llmErrors: world.llmErrors || 0,
    llmLastError: world.llmLastError || '',
  };
}
