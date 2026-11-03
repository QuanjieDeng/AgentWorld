// brain.js — 两种大脑：规则驱动（默认）与 LLM 驱动（玩家自带 key）。
// 两者都只能提交"意图"，引擎负责判定。

import {
  TILE,
  W,
  H,
  DIRS,
  KNOWLEDGE_KEYS,
  KNOWLEDGE_LABEL,
  SKILL_KEYS,
  SKILL_LABEL,
  LANGUAGE_KEYS,
  LANGUAGE_LABEL,
  TURNING_TRIGGERS,
  sharedLanguage,
  describeInstitution,
  MIN_FACTION_RELATION,
  DEFAULT_REMEMBRANCE,
  LOW_REMEMBRANCE,
  resourceNear,
  isWalkable,
  logDecision,
  applyTurning,
  turningFallbackLabel,
} from './engine.js';
import { visibleAgents, visibleStructures, visibleWolves, heardSounds } from './perception.js';

const DIR_NAMES = { N: '北', S: '南', W: '西', E: '东' };

const TEACHABLE_KEYS = [...new Set([...KNOWLEDGE_KEYS, ...SKILL_KEYS, ...LANGUAGE_KEYS])];

// 脱变带来的行为倾向：aggression 影响动手门槛，talk 影响主动搭话与收养，night 影响夜里的胆量。
const IDENTITY_TRAITS = {
  手上带血的人: { aggression: 1, talk: -0.3 },
  复仇者: { aggression: 1, talk: -0.3 },
  幸存者: { aggression: -0.3 },
  释怀的人: { aggression: -0.5 },
  空下来的人: { talk: -0.4 },
  守墓人: { talk: -0.5 },
  断后的人: { talk: -0.4 },
  独行者: { talk: -1.2 },
  不再相信人的人: { talk: -1.2 },
  首领: { aggression: 0.5, talk: 0.3 },
  被追随的人: { aggression: 0.3, talk: 0.5 },
  猎手: { aggression: 0.6, night: true },
  不怕夜的人: { night: true },
};

const traitsOf = (agent) => IDENTITY_TRAITS[agent.identity] || {};

function dirTo(a, x, y) {
  const dx = x - a.x;
  const dy = y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  return dy > 0 ? 'S' : 'N';
}

function moveToward(a, x, y) {
  const steps = Math.max(1, Math.min(8, Math.abs(x - a.x) + Math.abs(y - a.y)));
  return { type: 'move', dir: dirTo(a, x, y), remaining: steps };
}

function nearestTile(world, a, types, radius) {
  let best = null;
  let bd = 1e9;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = a.x + dx;
      const y = a.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (!types.includes(world.map[y * W + x])) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bd) {
        bd = d;
        best = { x, y };
      }
    }
  }
  return best;
}

function nearestAgent(world, a, radius, pred = () => true) {
  let best = null;
  let bd = 1e9;
  for (const o of world.agents) {
    if (!o.alive || o.id === a.id) continue;
    const d = Math.abs(o.x - a.x) + Math.abs(o.y - a.y);
    if (d <= radius && d < bd && pred(o)) {
      bd = d;
      best = o;
    }
  }
  return best;
}

function nearestStructure(world, a, type, radius) {
  let best = null;
  let bd = 1e9;
  for (const s of world.structures) {
    if (s.type !== type) continue;
    const d = Math.abs(s.x - a.x) + Math.abs(s.y - a.y);
    if (d <= radius && d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

function fleeAction() {
  return { type: 'flee', remaining: 5 };
}

function adjacentWater(world, a) {
  return [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => {
    const x = a.x + dx;
    const y = a.y + dy;
    return x >= 0 && y >= 0 && x < W && y < H && world.map[y * W + x] === TILE.WATER;
  });
}

function mockSay(world, a, other) {
  const o = a.tags.obsession;
  const lines = [];
  if (o.includes('饭')) lines.push('今天还够吃吗？', '省着点。');
  if (o.includes('梦')) lines.push('你信这是真的吗？', '我总觉得还没醒。');
  if (o.includes('回来')) lines.push('你见过一个说会回来的人吗？', '他答应过我的。');
  if (o.includes('话')) lines.push('有件事我一直没说完。', '你愿意听吗？');
  if (o.includes('墙') || o.includes('屋')) lines.push('这地方得有个能挡风的东西。', '有墙才叫屋子。');
  if (o.includes('名字')) lines.push('你叫什么？我得记下来。', '死了的人也该有名字。');
  if (!lines.length) lines.push('这里以前是什么地方？', '你也是刚来的吗？', '火别灭了。');
  lines.push(`我叫${a.name}。`, `${other.name}，你冷吗？`);
  return lines[Math.floor(world.rng() * lines.length)];
}

// ---------- 规则大脑（离线可用） ----------

export function mockDecide(world, a) {
  const traits = traitsOf(a);
  if (a.hunger < 32 && a.inventory.food > 0) return { type: 'eat', remaining: 1 };

  const wolf = world.wolves.find((w) => Math.abs(w.x - a.x) + Math.abs(w.y - a.y) <= 1);
  if (wolf) {
    const brave = a.hp > (traits.night ? 25 : 45) || a.inventory.weapon;
    if (brave) return { type: 'attack', target: 'wolf', reason: '它要咬我', remaining: 2 };
    return fleeAction();
  }

  const hostile = nearestAgent(world, a, 1, (o) => (a.relationships[o.id] || 0) < -20);
  if (hostile) {
    const ready = a.hp > 50 - (traits.aggression || 0) * 15;
    if (ready && a.skills.fight >= 2) return { type: 'attack', target: hostile.id, reason: '上一次的仇还没算', remaining: 2 };
    return fleeAction();
  }

  // 快饿死且身上没有吃的：向身边有食物的人动手
  if (a.hunger < 12 && a.inventory.food === 0) {
    const rich = nearestAgent(world, a, 4, (o) => o.inventory.food > 0);
    if (rich) return { type: 'attack', target: rich.id, reason: '我快饿死了，他手里有吃的', remaining: 2 };
  }

  // 饿了：找吃的
  if (a.hunger < 55) {
    const bush = nearestTile(world, a, [TILE.BUSH], 14);
    if (bush) {
      if (Math.abs(bush.x - a.x) + Math.abs(bush.y - a.y) <= 1) return { type: 'gather', remaining: 6 };
      return moveToward(a, bush.x, bush.y);
    }
    const foodTree = nearestTile(world, a, [TILE.TREE], 10);
    if (foodTree) {
      if (Math.abs(foodTree.x - a.x) + Math.abs(foodTree.y - a.y) <= 1) return { type: 'gather', remaining: 6 };
      return moveToward(a, foodTree.x, foodTree.y);
    }
    if (a.knows.fish && adjacentWater(world, a)) return { type: 'fish', remaining: 60 };
    if (a.knows.fish) {
      const water = nearestTile(world, a, [TILE.WATER], 16);
      if (water) return moveToward(a, water.x, water.y);
    }
  }

  // 夜：回营地；被驱逐的人进不了营地。
  if (world.isNight && !(a.exiledUntil > world.tick)) {
    const camp = nearestStructure(world, a, 'camp', 40);
    if (camp) {
      const d = Math.abs(camp.x - a.x) + Math.abs(camp.y - a.y);
      const fireAtCamp = world.structures.some(
        (s) => s.type === 'fire' && Math.abs(s.x - camp.x) + Math.abs(s.y - camp.y) <= 2
      );
      if (!fireAtCamp) {
        if (d <= 1 && a.inventory.wood >= 5 && a.knows.fire) {
          return { type: 'build', build: 'fire', remaining: 20 };
        }
        if (d <= 2 && !a.knows.fire) return { type: 'rest', remaining: 30 };
        return moveToward(a, camp.x, camp.y);
      }
      if (d <= 2) return { type: 'rest', remaining: 30 };
      return moveToward(a, camp.x, camp.y);
    }
    if (a.inventory.wood >= 5 && a.knows.fire) {
      return { type: 'build', build: 'fire', reason: '天黑了，得有火', remaining: 20 };
    }
    const tree = nearestTile(world, a, [TILE.TREE], 16);
    if (tree) {
      if (Math.abs(tree.x - a.x) + Math.abs(tree.y - a.y) <= 1) return { type: 'gather', remaining: 6 };
      return moveToward(a, tree.x, tree.y);
    }
  }

  if (a.energy < 22) return { type: 'rest', remaining: 30 };

  // 快要被忘记了，就去找人说话：被惦记才清醒。
  if ((a.remembrance ?? DEFAULT_REMEMBRANCE) < LOW_REMEMBRANCE) {
    const other = nearestAgent(world, a, 3);
    if (other) {
      if (Math.abs(other.x - a.x) + Math.abs(other.y - a.y) <= 1) {
        return { type: 'talk', target: other.id, say: mockSay(world, a, other), remaining: 2 };
      }
      return moveToward(a, other.x, other.y);
    }
  }

  // 亲手埋葬自己的继承人/收养人，是这一生少数几个真正的转折。
  const kinGrave = world.structures.find((s) => {
    if (s.type !== 'grave' || s.buried) return false;
    const dead = world.agents.find((x) => x.id === s.agentId);
    return (
      dead &&
      (dead.heirId === a.id ||
        dead.mentorId === a.id ||
        a.heirId === dead.id ||
        a.mentorId === dead.id)
    );
  });
  if (kinGrave) {
    const d = Math.abs(kinGrave.x - a.x) + Math.abs(kinGrave.y - a.y);
    if (d <= 6) {
      if (d <= 1) return { type: 'bury', remaining: 1 };
      return moveToward(a, kinGrave.x, kinGrave.y);
    }
  }

  // 手边有资源就采
  const nearRes = resourceNear(world, a, [TILE.TREE, TILE.BUSH, TILE.ROCK]);
  if (nearRes) return { type: 'gather', remaining: 6 };

  if (
    a.knows.farm &&
    a.inventory.food >= 6 &&
    world.map[a.y * W + a.x] === TILE.GRASS &&
    !world.structures.some((s) => s.x === a.x && s.y === a.y) &&
    world.rng() < 0.05
  ) {
    return { type: 'plant', reason: '多种一点，以后有得吃', remaining: 4 };
  }

  const shelterNear = world.structures.some(
    (s) => s.type === 'shelter' && s.ownerId && Math.abs(s.x - a.x) + Math.abs(s.y - a.y) <= 4
  );

  // 空宅和遗产：没人继承的东西，谁先搬进去就是谁的。
  const vacant = world.structures.find(
    (s) => s.type === 'shelter' && !s.ownerId && Math.abs(s.x - a.x) + Math.abs(s.y - a.y) <= 12
  );
  const remains = world.remains.find(
    (r) => Math.abs(r.x - a.x) + Math.abs(r.y - a.y) <= 12
  );
  const destination = remains && a.hunger < 50 ? remains : vacant;
  if (destination && !shelterNear) {
    if (Math.abs(destination.x - a.x) + Math.abs(destination.y - a.y) <= 1) {
      return { type: 'moveIn', remaining: 1 };
    }
    return moveToward(a, destination.x, destination.y);
  }

  // 没有继承人时，遇到足够亲近的人就收养或收徒。
  // 声望够高的人会立制度；有结社就去加入。
  if (!a.hasProposedInstitution && (a.reputation || 0) >= 10 && world.rng() < 0.02) {
    const has = (kind) => world.institutions.some((inst) => inst.active && inst.kind === kind);
    if (!has('law')) {
      return {
        type: 'propose',
        kind: 'law',
        slots: {
          action: 'attack',
          place: 'camp',
          subject: 'anyone',
          weapon: 'any',
          reputation: 'any',
          penalty: 'reputation',
        },
        remaining: 1,
      };
    }
    if (!has('doctrine')) {
      return {
        type: 'propose',
        kind: 'doctrine',
        slots: { taboo: 'attack', ritual: 'buryDead', when: 'always' },
        remaining: 1,
      };
    }
    if (!has('faction')) {
      return {
        type: 'propose',
        kind: 'faction',
        slots: { name: `${a.name}的结社`, shared: 'yes', joinRequirement: 'trust' },
        remaining: 1,
      };
    }
  }

  if ((a.reputation || 0) >= 10 && world.institutions.length && world.rng() < 0.01) {
    const institution = world.institutions.find(
      (inst) => inst.active && !inst.interpretations[a.id]
    );
    if (institution) {
      return {
        type: 'interpret',
        institution: institution.id,
        reading: world.rng() < 0.5 ? 'strict' : 'lenient',
        remaining: 1,
      };
    }
  }

  if (world.rng() < 0.02) {
    const faction = world.institutions.find(
      (inst) =>
        inst.kind === 'faction' &&
        inst.active &&
        !inst.members.includes(a.id) &&
        (inst.slots.joinRequirement === 'reputation'
          ? (a.reputation || 0) >= 10
          : (a.relationships[inst.leaderId] || 0) >= MIN_FACTION_RELATION)
    );
    if (faction) return { type: 'join', faction: faction.id, remaining: 1 };
  }

  const adoptChance = Math.max(0, 0.05 + (traits.talk || 0) * 0.02);
  if (!a.heirId && adoptChance > 0 && world.rng() < adoptChance) {
    const close = nearestAgent(world, a, 2, (o) => (a.relationships[o.id] || 0) >= 15);
    if (close) {
      if (Math.abs(close.x - a.x) + Math.abs(close.y - a.y) <= 1) {
        return {
          type: 'adopt',
          target: close.id,
          kind: (a.skills.teach || 0) >= 2 ? 'apprentice' : 'adopted',
          remaining: 1,
        };
      }
      return moveToward(a, close.x, close.y);
    }
  }

  if (a.knows.shelter && !shelterNear && a.inventory.wood >= 15 && world.rng() < 0.05) {
    return { type: 'build', build: 'shelter', reason: '想有个能挡风的地方', remaining: 40 };
  }
  if (a.knows.wall && a.inventory.stone >= 8 && world.rng() < 0.03) {
    return { type: 'build', build: 'wall', reason: '想把这里围起来', remaining: 30 };
  }

  // 教身边人一件自己会、对方不会的事。知识和技能都会流动。
  if (world.rng() < 0.12) {
    const other = nearestAgent(world, a, 2);
    if (other) {
      const missing = KNOWLEDGE_KEYS.find((k) => a.knows[k] && !other.knows[k]);
      const missingLanguage = LANGUAGE_KEYS.find((l) => a.languages[l] && !other.languages[l]);
      const skillCandidate = SKILL_KEYS.filter((k) => k !== 'teach').find(
        (k) => (a.skills[k] || 0) >= 3 && (other.skills[k] || 0) < a.skills[k] - 1
      );
      const topic =
        (!sharedLanguage(a, other) && missingLanguage) || missing || skillCandidate || missingLanguage;
      if (topic) {
        if (Math.abs(other.x - a.x) + Math.abs(other.y - a.y) <= 1) {
          return { type: 'teach', target: other.id, skill: topic, remaining: 1 };
        }
        return moveToward(a, other.x, other.y);
      }
    }
  }

  const talkChance = Math.max(0, 0.18 + (traits.talk || 0) * 0.15);
  if (talkChance > 0 && a.inventory.food > 0 && world.rng() < talkChance) {
    const other = nearestAgent(world, a, 3);
    if (other) return { type: 'talk', target: other.id, say: mockSay(world, a, other), remaining: 2 };
  }

  if (world.rng() < 0.7) {
    const res = nearestTile(world, a, [TILE.TREE, TILE.BUSH, TILE.ROCK], 18);
    if (res) return moveToward(a, res.x, res.y);
  }

  const dirs = ['N', 'S', 'E', 'W'];
  return { type: 'move', dir: dirs[Math.floor(world.rng() * 4)], remaining: 3 + Math.floor(world.rng() * 4) };
}

// ---------- LLM 大脑 ----------

function describePerception(world, a) {
  const seen = visibleAgents(world, a)
    .slice(0, 6)
    .map(({ agent: o, dist, dir }) => {
      const rel = a.relationships[o.id] || 0;
      const att = rel > 5 ? '（亲近）' : rel < -5 ? '（敌意）' : '';
      return `${o.name}在你${dir}边大约${dist}步远${att}`;
    });

  const res = [];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = a.x + dx;
      const y = a.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = world.map[y * W + x];
      if ([TILE.TREE, TILE.BUSH, TILE.ROCK].includes(t)) {
        const name = { 2: '树', 5: '灌木', 3: '岩石' }[t];
        res.push(`${name}在你${DIR_NAMES[dirTo(a, x, y)]}边${Math.abs(dx) + Math.abs(dy)}格`);
      }
    }
  }

  const structs = visibleStructures(world, a)
    .slice(0, 5)
    .map(({ structure: s, dist, dir }) => {
      const name = { fire: '火堆', shelter: '窝棚', wall: '墙', grave: '坟', camp: '营地' }[s.type] || s.type;
      const state = s.type === 'shelter' && !s.ownerId ? '（空着）' : '';
      return `${name}${state}在你${dir}边大约${dist}步远`;
    });

  const remains = world.remains
    .filter((r) => Math.abs(r.x - a.x) + Math.abs(r.y - a.y) <= 10)
    .map((r) => `${r.name}留下的东西在你${DIR_NAMES[dirTo(a, r.x, r.y)]}边大约${Math.abs(r.x - a.x) + Math.abs(r.y - a.y)}步远`);

  const wolves = visibleWolves(world, a).map(
    ({ dist, dir }) => `一头野兽在你${dir}边大约${dist}步远`
  );

  const heard = heardSounds(world, a).map((s) => `${s.dir}边${s.band}，${s.text}`);
  const water = nearestTile(world, a, [TILE.WATER], 24);

  return {
    seen: seen.join('；') || '你看不见任何人',
    heard: heard.join('；') || '四周很安静',
    res: [...new Set(res)].slice(0, 8).join('；') || '没有',
    structs: structs.join('；') || '没有',
    remains: remains.join('；') || '没有',
    wolves: wolves.join('；'),
    water: water
      ? `最近的水在你${DIR_NAMES[dirTo(a, water.x, water.y)]}边大约${Math.abs(water.x - a.x) + Math.abs(water.y - a.y)}格`
      : '附近没有水',
  };
}

function buildPrompt(world, a) {
  const near = describePerception(world, a);
  const sys = `你叫${a.name}。你已经死了，在一片废墟中的岛上醒来。人类已经停止繁衍，你是最后一批被上传的人之一。没有人解释这里是哪里，世界不解释任何东西。
你的一生：出身${a.tags.origin}；你放不下的执念是「${a.tags.obsession}」；你的禀赋是${a.tags.aptitude}；你有一道旧伤：${a.tags.wound}。
你只能输出一个 JSON，不要解释，不要 Markdown，不要代码块。`;

  const canWalk = ['N', 'S', 'E', 'W'].filter((d) => {
    const [dx, dy] = DIRS[d];
    return isWalkable(world, a.x + dx, a.y + dy);
  });

  const user = `时间：第${world.day}天 ${world.clock}（${world.isNight ? '夜' : '昼'}）
你的位置：(${a.x},${a.y})，可走的方向：${canWalk.map((d) => DIR_NAMES[d]).join('、') || '无'}
状态：生命${Math.round(a.hp)}，饥饿${Math.round(a.hunger)}，体力${Math.round(a.energy)}，被记住${Math.round(a.remembrance ?? DEFAULT_REMEMBRANCE)}/100
你说的语言：${LANGUAGE_LABEL[a.nativeLanguage]}；你会的语言：${Object.keys(a.languages).map((l) => LANGUAGE_LABEL[l]).join('、')}
${a.exiledUntil > world.tick ? '你被驱逐了，不能回到营地。' : ''}
${a.mentorId ? `收养你的人：${world.agents.find((x) => x.id === a.mentorId)?.name || '某个人'}` : ''}
${a.inheritedObsession ? `你接过了${a.inheritedFrom}没做完的事：${a.inheritedObsession}` : ''}
${a.identity ? `你现在的身份：${a.identity}` : ''}
你刚才：${a.lastAction || '刚醒来'}
背包：食物${a.inventory.food}，木头${a.inventory.wood}，石头${a.inventory.stone}，${a.inventory.weapon ? '有武器' : '赤手空拳'}
你会：${Object.entries(a.skills).filter(([, v]) => v > 0).map(([k, v]) => `${SKILL_LABEL[k] || k}${v.toFixed(1)}`).join('、')}
你会做的事：${KNOWLEDGE_KEYS.filter((k) => a.knows[k]).map((k) => KNOWLEDGE_LABEL[k]).join('、') || '没有'}
你不会做的事：${KNOWLEDGE_KEYS.filter((k) => !a.knows[k]).map((k) => KNOWLEDGE_LABEL[k]).join('、') || '没有'}
${Object.keys(a.learning || {}).length ? `你正在学：${Object.entries(a.learning).map(([k, v]) => `${KNOWLEDGE_LABEL[k]}（${Math.round(v * 100)}%）`).join('、')}` : ''}
你看见的人：${near.seen}
你看见的建筑：${near.structs}
无人继承的遗产：${near.remains}
现有制度：${world.institutions.filter((i) => i.active).map((i) => `${i.id} ${describeInstitution(i)}`).join('；') || '没有'}
${near.wolves ? `你看见的野兽：${near.wolves}` : ''}
你听见：${near.heard}
身边的资源：${near.res}
${near.water}
最近发生：${a.memory.slice(-4).join('；') || '没有'}
你相信最近发生的事：${a.beliefs.slice(-3).map((b) => b.proposition).join('；') || '没有'}
${a.letter ? `你听见一个声音说：「${a.letter}」` : ''}

规则：一次移动默认走多格（steps 1-8）；采集要站在资源旁边（1 格）；交谈、教导、收养和攻击要与对方相邻（1 格），如果对方不在旁边，就先朝他的方向移动；建火堆需 5 木头，窝棚需 10 木头，墙需 5 石头；吃东西需要背包里有食物。生火、窝棚、墙、捕鱼、耕种、削武器都是岛上独有的知识，不会就做不成；你可以在相邻时把你会而对方不会的东西教给他。把一个人收作继承人（收养或收徒），你死后他会得到你的东西、部分技能、知识和信念；关系要足够亲近。没有人继承的遗产和空宅可以搬进去。站在坟旁边可以埋葬死者；埋葬自己收养或收徒的人，会改变你的一生。不同语言的人听不懂彼此说的话；你可以教对方你的语言，也可能在长期接触中慢慢学会对方的语言。立制度必须填满这些槽位：律法 {action:"attack", place:"camp"或"anywhere", subject:"anyone"或"members"或"outsiders", weapon:"any"或"armed", reputation:"any"或"low", penalty:"reputation"或"exile"}；教义 {taboo:"attack", ritual:"campAtNight"或"buryDead", when:"always"或"night"}；结社 {name:"不超过12字", shared:"yes"或"no", joinRequirement:"trust"或"reputation"}。声望不到 10 不能立制度。声望够高的人也可以争夺制度的解释权：strict 严格执行，lenient 宽缓处理；活着的解释者里声望最高的那个决定这条制度怎么执行。饥饿会持续下降，归零就会死，所以先保证有食物；体力归零也会持续掉血，必须休息。水边的鱼是无限的，站在水边可以捕鱼；花 1 份食物可以在草地上种一丛灌木，两天后长出来；树和灌木被采完后要很久才能长回来。天黑以后野兽会出现，待在有火的地方更安全。攻击必须有真实的理由（饥饿、仇恨、恐惧、被挑衅），不能无缘无故。重要的行动（建造、制造、逃离、耕种）都写一句 reason，它会留在你的人生记录里。

选择你接下来的行动。只输出一个 JSON：
{"action":"move","dir":"N|S|E|W","steps":1到8}
{"action":"gather"}
{"action":"fish"}
{"action":"plant","reason":"为什么要种"}
{"action":"eat"}
{"action":"craft","reason":"为什么要做"}
{"action":"build","build":"fire|shelter|wall","reason":"为什么要建"}
{"action":"talk","target":"名字","say":"一句话"}
{"action":"teach","target":"名字","skill":"${TEACHABLE_KEYS.join('|')}","reason":"为什么要教"}
{"action":"adopt","target":"名字","kind":"adopted|apprentice","reason":"为什么要把身后事交给他"}
{"action":"moveIn","reason":"为什么要搬进去"}
{"action":"bury","reason":"为什么要埋葬"}
{"action":"propose","kind":"law|doctrine|faction","slots":{},"reason":"为什么要立"}
{"action":"join","faction":"结社 id","reason":"为什么要加入"}
{"action":"interpret","institution":"制度 id","reading":"strict|lenient","reason":"为什么要这样解释"}
{"action":"attack","target":"名字或野兽","reason":"为什么动手"}
{"action":"flee","reason":"为什么要逃"}
{"action":"rest"}
{"action":"idle"}`;

  return { sys, user };
}

function normalize(world, a, raw) {
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;

  const whyText = String(obj.reason || obj.why || '').slice(0, 60);
  const ACTIONS = ['move', 'gather', 'eat', 'craft', 'build', 'talk', 'teach', 'adopt', 'moveIn', 'bury', 'propose', 'join', 'interpret', 'attack', 'flee', 'rest', 'idle', 'fish', 'plant'];
  const action = ACTIONS.includes(obj.action) ? obj.action : ACTIONS.includes(obj.type) ? obj.type : null;

  if (action === 'move') {
    const dirMap = {
      N: 'N', S: 'S', E: 'E', W: 'W',
      北: 'N', 南: 'S', 东: 'E', 西: 'W',
      north: 'N', south: 'S', east: 'E', west: 'W',
    };
    const dir = dirMap[obj.dir] || dirMap[obj.direction] || 'N';
    const steps = Math.max(1, Math.min(8, Number(obj.steps ?? obj.n) || 4));
    return { type: 'move', dir, remaining: steps };
  }
  if (action === 'gather') return { type: 'gather', remaining: 6 };
  if (action === 'fish') {
    if (adjacentWater(world, a)) return { type: 'fish', remaining: 60 };
    const water = nearestTile(world, a, [TILE.WATER], 20);
    if (water) return moveToward(a, water.x, water.y);
    return null;
  }
  if (action === 'plant') {
    if (a.inventory.food < 1) return null;
    if (world.map[a.y * W + a.x] !== TILE.GRASS) return null;
    if (world.structures.some((s) => s.x === a.x && s.y === a.y)) return null;
    return { type: 'plant', reason: whyText, remaining: 4 };
  }
  if (action === 'eat') return a.inventory.food > 0 ? { type: 'eat', remaining: 1 } : null;
  if (action === 'craft') return a.inventory.wood >= 2 ? { type: 'craft', reason: whyText, remaining: 10 } : null;
  if (action === 'build') {
    const b = obj.build || obj.building || (['fire', 'shelter', 'wall'].includes(obj.type) ? obj.type : null);
    if (!['fire', 'shelter', 'wall'].includes(b)) return null;
    const need = b === 'wall' ? a.inventory.stone >= 5 : a.inventory.wood >= 5;
    return need ? { type: 'build', build: b, reason: whyText, remaining: b === 'shelter' ? 40 : 25 } : null;
  }
  if (action === 'talk') {
    const targetName = obj.target ?? obj.to ?? obj.name;
    const t = world.agents.find((o) => o.alive && (o.name === targetName || o.id === targetName));
    if (!t) return null;
    if (Math.abs(t.x - a.x) + Math.abs(t.y - a.y) > 1) return moveToward(a, t.x, t.y);
    return { type: 'talk', target: t.id, say: String(obj.say || obj.text || obj.message || '').slice(0, 80), remaining: 2 };
  }
  if (action === 'teach') {
    const targetName = obj.target ?? obj.to ?? obj.name;
    const t = world.agents.find((o) => o.alive && (o.name === targetName || o.id === targetName));
    if (!t) return null;
    if (Math.abs(t.x - a.x) + Math.abs(t.y - a.y) > 1) return moveToward(a, t.x, t.y);
    const skill = String(obj.skill ?? obj.what ?? '').trim();
    if (!TEACHABLE_KEYS.includes(skill)) return null;
    return { type: 'teach', target: t.id, skill, reason: whyText, remaining: 1 };
  }
  if (action === 'adopt') {
    const targetName = obj.target ?? obj.to ?? obj.name;
    const t = world.agents.find((o) => o.alive && (o.name === targetName || o.id === targetName));
    if (!t) return null;
    if (Math.abs(t.x - a.x) + Math.abs(t.y - a.y) > 1) return moveToward(a, t.x, t.y);
    return {
      type: 'adopt',
      target: t.id,
      kind: obj.kind === 'apprentice' ? 'apprentice' : 'adopted',
      reason: whyText,
      remaining: 1,
    };
  }
  if (action === 'moveIn') return { type: 'moveIn', reason: whyText, remaining: 1 };
  if (action === 'bury') return { type: 'bury', reason: whyText, remaining: 1 };
  if (action === 'propose') {
    const kind = String(obj.kind || obj.institution || '').trim();
    if (!['law', 'doctrine', 'faction'].includes(kind)) return null;
    const slots = obj.slots && typeof obj.slots === 'object' ? obj.slots : {};
    return { type: 'propose', kind, slots, reason: whyText, remaining: 1 };
  }
  if (action === 'join') {
    const faction = String(obj.faction || obj.id || '').trim();
    if (!faction) return null;
    return { type: 'join', faction, reason: whyText, remaining: 1 };
  }
  if (action === 'interpret') {
    const institution = String(obj.institution || obj.id || '').trim();
    const reading = String(obj.reading || '').trim();
    if (!institution || !['strict', 'lenient'].includes(reading)) return null;
    return { type: 'interpret', institution, reading, reason: whyText, remaining: 1 };
  }
  if (action === 'attack') {
    const t = String(obj.target ?? obj.to ?? obj.name ?? '');
    const reason = String(obj.reason || obj.why || '').slice(0, 60);

    if (t === '野兽' || t === '狼' || t === 'wolf' || t === 'beast') {
      const near = world.wolves.find((w) => Math.abs(w.x - a.x) + Math.abs(w.y - a.y) <= 1);
      if (near) return { type: 'attack', target: 'wolf', reason, remaining: 2 };
      if (world.wolves.length) {
        const wolf = world.wolves.reduce((best, w) => {
          const d = Math.abs(w.x - a.x) + Math.abs(w.y - a.y);
          return !best || d < best.d ? { w, d } : best;
        }, null);
        if (wolf) return moveToward(a, wolf.w.x, wolf.w.y);
      }
      return null;
    }

    const o = world.agents.find((x) => x.alive && (x.name === t || x.id === t));
    if (!o) return null;
    if (Math.abs(o.x - a.x) + Math.abs(o.y - a.y) > 1) return moveToward(a, o.x, o.y);
    return { type: 'attack', target: o.id, reason, remaining: 2 };
  }
  if (action === 'flee') return { type: 'flee', reason: whyText, remaining: 5 };
  if (action === 'rest') return { type: 'rest', remaining: 30 };
  if (action === 'idle') return { type: 'idle', remaining: 5 };
  return null;
}

function endpoint(base, provider) {
  const b = base.replace(/\/+$/, '');
  if (provider === 'anthropic') {
    if (b.endsWith('/v1/messages')) return b;
    if (b.endsWith('/v1')) return `${b}/messages`;
    return `${b}/v1/messages`;
  }
  if (b.endsWith('/chat/completions')) return b;
  return `${b}/chat/completions`;
}

export async function requestLLM(world, sys, user, maxTokens = 400) {
  const anthropic = world.api.provider === 'anthropic';
  const url = endpoint(world.api.base, world.api.provider);

  const headers = { 'Content-Type': 'application/json' };
  let body;

  if (anthropic) {
    headers['x-api-key'] = world.api.key;
    headers.Authorization = `Bearer ${world.api.key}`;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: world.api.model,
      max_tokens: maxTokens,
      temperature: 0.9,
      system: sys,
      messages: [{ role: 'user', content: user }],
    };
  } else {
    headers.Authorization = `Bearer ${world.api.key}`;
    body = {
      model: world.api.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.9,
      max_tokens: maxTokens,
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  return anthropic
    ? (data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    : data?.choices?.[0]?.message?.content || '';
}

async function llmDecide(world, a) {
  const { sys, user } = buildPrompt(world, a);
  return normalize(world, a, await requestLLM(world, sys, user));
}

async function llmTurning(world, a, proposal) {
  const definition = TURNING_TRIGGERS[proposal.trigger];
  if (!definition) return null;
  const sys = `你叫${a.name}。你刚经历了一件改变你的事。你只能从给定的身份里选一个。只输出一个 JSON，不要解释，不要代码块。`;
  const user = `发生了什么：${proposal.reason}
可选的身份：${definition.labels.join('、')}
输出：{"label":"选中的身份"}`;
  const text = await requestLLM(world, sys, user);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return String(JSON.parse(match[0]).label || '');
  } catch {
    return null;
  }
}

// ---------- 调度 ----------

function recordDecision(world, a, action, source) {
  logDecision(world, {
    agentId: a.id,
    source,
    action,
    rngAfter: world.rng.getState(),
  });
}

function applyReplayDecisions(world) {
  const { queue } = world.replay;
  while (world.replay.index < queue.length && queue[world.replay.index].tick <= world.tick) {
    const d = queue[world.replay.index++];
    const a = world.agents.find((x) => x.id === d.agentId);
    if (!a || !a.alive) continue;
    a.queuedAction = { ...d.action };
    a.deciding = false;
    a.cooldownUntil = Math.max(a.cooldownUntil || 0, world.tick + 2);
    if (typeof d.rngAfter === 'number') world.rng.setState(d.rngAfter);
    logDecision(world, {
      agentId: d.agentId,
      source: d.source,
      action: d.action,
      rngAfter: d.rngAfter,
    });
  }
  world.pendingDecisions = [];
}

export function processBrains(world) {
  if (world.pendingTurnings?.length) {
    const pending = world.pendingTurnings;
    world.pendingTurnings = [];
    for (const proposal of pending) {
      const a = world.agents.find((x) => x.id === proposal.agentId);
      if (!a || !a.alive) continue;

      if (!world.api.key || !a.useLLM || world.ruleOnly || world.inflight >= 6) {
        applyTurning(
          world,
          a,
          proposal.trigger,
          turningFallbackLabel(world, proposal.trigger),
          proposal.reason
        );
        continue;
      }

      world.inflight++;
      world.llmCalls = (world.llmCalls || 0) + 1;
      llmTurning(world, a, proposal)
        .then((label) => applyTurning(world, a, proposal.trigger, label, proposal.reason))
        .catch((err) => {
          world.llmErrors = (world.llmErrors || 0) + 1;
          world.llmLastError = String(err?.message || err);
          applyTurning(
            world,
            a,
            proposal.trigger,
            turningFallbackLabel(world, proposal.trigger),
            proposal.reason
          );
        })
        .finally(() => {
          world.inflight--;
        });
    }
  }

  if (world.replay) {
    applyReplayDecisions(world);
    return;
  }

  const queue = world.pendingDecisions;
  world.pendingDecisions = [];
  if (!queue.length) return;

  for (const a of queue) {
    if (!a.alive) {
      a.deciding = false;
      continue;
    }

    if (world.api.key && a.useLLM && !world.ruleOnly && world.inflight < 6) {
      world.inflight++;
      world.llmCalls = (world.llmCalls || 0) + 1;
      llmDecide(world, a)
        .then((act) => {
          const action = act || mockDecide(world, a);
          a.queuedAction = action;
          recordDecision(world, a, action, 'llm');
        })
        .catch((err) => {
          world.llmErrors = (world.llmErrors || 0) + 1;
          world.llmLastError = String(err?.message || err);
          const action = mockDecide(world, a);
          a.queuedAction = action;
          recordDecision(world, a, action, 'fallback');
        })
        .finally(() => {
          world.inflight--;
          a.deciding = false;
          a.cooldownUntil = Math.max(a.cooldownUntil || 0, world.tick + 2);
        });
    } else {
      const action = mockDecide(world, a);
      a.queuedAction = action;
      recordDecision(world, a, action, 'rule');
      a.deciding = false;
      a.cooldownUntil = Math.max(a.cooldownUntil || 0, world.tick + 2);
    }
  }
}
