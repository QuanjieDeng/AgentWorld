// sync-check.js — 在另一台机器上校验一份日志，并重建世界。
//
//   机器 A：curl 'http://A:4173/api/journal?nodeId=a' > journal.json
//   机器 B：node sync-check.js journal.json
//
// 只读、离线，不需要 API Key。

import fs from 'node:fs';
import { verifyJournal, rebuildFromJournal, stateHash, eventsHash } from './sync.js';

const file = process.argv[2];
if (!file) {
  console.error('用法：node sync-check.js <journal.json>');
  process.exit(2);
}

let envelope;
try {
  envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`读不了日志：${err.message}`);
  process.exit(2);
}

const check = verifyJournal(envelope);
if (!check.ok) {
  console.error(`日志校验失败：${check.reason}`);
  process.exit(1);
}

const world = rebuildFromJournal(envelope);
const hash = stateHash(world);
const eventMatch = eventsHash(world.eventLog) === envelope.eventsHash;
const same = hash === envelope.stateHash;

console.log(`协议 ${envelope.protocol} · 种子 ${envelope.seed} · 节点 ${envelope.nodeId}`);
console.log(`日志：第 ${envelope.fromSeq}–${envelope.toSeq} 条事件，${envelope.decisions.length} 个决策`);
console.log(`重建：第 ${world.tick} 刻（第 ${world.day} 天 ${world.clock}）`);
console.log(
  `活着 ${world.agents.filter((a) => a.alive).length} 人 · 坟 ${
    world.structures.filter((s) => s.type === 'grave').length
  } 座 · 制度 ${world.institutions.filter((i) => i.active).length} 条`
);
console.log(`stateHash ${hash}`);
console.log(`与日志声明一致：${same ? '是' : '否'}`);
console.log(`事件逐字节一致：${eventMatch ? '是' : '否'}`);

process.exit(same && eventMatch ? 0 : 1);
