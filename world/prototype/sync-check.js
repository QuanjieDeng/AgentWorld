// sync-check.js — 在另一台机器上校验一份日志，并重建世界。
//
//   机器 A：curl 'http://A:4173/api/journal?nodeId=a' > journal.json
//   机器 B：node sync-check.js journal.json
//           node sync-check.js journal.json --pubkey a-public.pem   # 同时验证来源
//
// 只读、离线，不需要 API Key。

import fs from 'node:fs';
import { verifyJournal, rebuildFromJournal, stateHash, eventsHash } from './sync.js';
import { keyIdFromPublicKey, verifyEnvelopeSignature } from './identity.js';

const args = process.argv.slice(2);
const pubkeyIndex = args.indexOf('--pubkey');
const pubkeyFile = pubkeyIndex >= 0 ? args[pubkeyIndex + 1] : '';
const file = args.find((arg, i) => !arg.startsWith('--') && i !== pubkeyIndex + 1);
if (!file) {
  console.error('用法：node sync-check.js <journal.json> [--pubkey <节点公钥.pem>]');
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

// 签名是“来源”证据，和内容校验分开报：没有公钥时只显示签名者，不假装验过。
let signatureOk = null;
if (envelope.signature) {
  console.log(
    `签名者 ${envelope.signature.nodeId} · ${envelope.signature.keyId}`
  );
  if (pubkeyFile) {
    let publicKey = '';
    try {
      publicKey = fs.readFileSync(pubkeyFile, 'utf8');
    } catch (err) {
      console.error(`读不了公钥：${err.message}`);
      process.exit(2);
    }
    const keyId = keyIdFromPublicKey(publicKey);
    signatureOk = verifyEnvelopeSignature(envelope, publicKey, {
      nodeId: envelope.signature.nodeId,
    });
    console.log(`公钥指纹 ${keyId || '（无效）'}`);
    console.log(`来源签名：${signatureOk ? '验证通过' : '验证失败'}`);
  } else {
    console.log('来源签名：未验证（用 --pubkey <公钥.pem> 验证）');
  }
} else {
  console.log('来源签名：无');
}
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

process.exit(same && eventMatch && signatureOk !== false ? 0 : 1);
