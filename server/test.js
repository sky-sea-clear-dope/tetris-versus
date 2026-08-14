// サーバーの動作テスト: npm test
// 実際にサーバーを起動して、2〜4人のクライアントで一連の流れを確認する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { garbageScale, scaleGarbage } from './garbage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8199;
let proc;

/** メッセージを1件待つ小さなヘルパー */
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.findIndex((x) => x.type === msg.t);
    if (w >= 0) {
      const [{ resolve }] = waiters.splice(w, 1);
      resolve(msg);
    } else {
      inbox.push(msg);
    }
  });
  return {
    ws,
    inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    /** 指定した種類のメッセージが来るまで待つ */
    wait(type, timeout = 3000) {
      const i = inbox.findIndex((m) => m.t === type);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const entry = { type, resolve };
        waiters.push(entry);
        setTimeout(() => {
          const j = waiters.indexOf(entry);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`"${type}" が ${timeout}ms 以内に届きませんでした`));
          }
        }, timeout);
      });
    },
    /** たまっている同じ種類のメッセージを捨てる（次の1件を確実に見るため） */
    drain(type) {
      for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === type) inbox.splice(i, 1);
    },
    open: () => new Promise((r) => ws.on('open', r)),
    close: () => ws.close(),
  };
}

/** 人数ぶんつないで、ひとつの部屋に集める。返り値は [部屋主, ...参加者] と部屋コード。 */
async function makeRoom(names) {
  const cs = names.map(() => connect());
  await Promise.all(cs.map((c) => c.open()));
  cs[0].send({ t: 'create', name: names[0] });
  const room = await cs[0].wait('room');
  const ids = [room.id];
  for (let i = 1; i < cs.length; i++) {
    cs[i].send({ t: 'join', code: room.code, name: names[i] });
    const r = await cs[i].wait('room');
    ids.push(r.id);
  }
  // 全員ぶんの参加者一覧が行きわたるのを待つ
  await new Promise((r) => setTimeout(r, 120));
  cs.forEach((c) => c.drain('players'));
  return { cs, ids, code: room.code, close: () => cs.forEach((c) => c.close()) };
}

test.before(async () => {
  proc = spawn('node', [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));
});

test.after(() => proc?.kill());

test('部屋を作って相手が参加し、部屋主の合図で同じシードの対戦が始まる', async () => {
  const { cs: [a, b], close } = await makeRoom(['いけだい', 'ともだち']);

  a.send({ t: 'begin' });
  const startA = await a.wait('start');
  const startB = await b.wait('start');
  assert.equal(startA.seed, startB.seed, '両者に同じシードが配られる（＝同じミノ順）');
  assert.ok(typeof startA.seed === 'number');

  close();
});

test('部屋コードは数字4桁で、参加者一覧が全員に届く', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  assert.match(room.code, /^\d{4}$/, '数字4桁の部屋コードが返る');
  assert.equal(room.host, true);
  assert.ok(room.id > 0, '自分の番号がもらえる');

  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');

  // 部屋を作った直後にも「自分ひとり」の一覧が来るので、2人ぶん届くまで読み進める
  let list = [];
  for (let i = 0; i < 5 && list.length !== 2; i++) list = (await a.wait('players')).list;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((p) => p.name), ['A', 'B']);
  assert.equal(list[0].host, true, '先にいた人が部屋主');
  assert.equal(list[1].host, false);

  a.close(); b.close();
});

test('存在しない部屋コードはエラーになる', async () => {
  const c = connect();
  await c.open();
  c.send({ t: 'join', code: 'ZZZZ', name: 'まいご' });
  const err = await c.wait('error');
  assert.match(err.msg, /見つかりません/);
  c.close();
});

test('5人目は満員で入れない', async () => {
  const { cs, code, close } = await makeRoom(['A', 'B', 'C', 'D']);
  assert.equal(cs.length, 4);
  const e = connect();
  await e.open();
  e.send({ t: 'join', code, name: 'E' });
  const err = await e.wait('error');
  assert.match(err.msg, /満員/);
  e.close(); close();
});

test('部屋主でない人は対戦を始められない', async () => {
  const { cs: [a, b], close } = await makeRoom(['A', 'B']);
  b.send({ t: 'begin' });
  const err = await b.wait('error');
  assert.match(err.msg, /部屋を作った人/);
  a.close(); b.close(); close();
});

test('ひとりでは始められない', async () => {
  const a = connect();
  await a.open();
  a.send({ t: 'create', name: 'A' });
  await a.wait('room');
  a.send({ t: 'begin' });
  const err = await a.wait('error');
  assert.match(err.msg, /そろってから/);
  a.close();
});

test('おじゃまブロックと盤面が相手に中継される', async () => {
  const { cs: [a, b], ids, close } = await makeRoom(['A', 'B']);
  a.send({ t: 'begin' });
  await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'attack', lines: 4 });
  const atk = await b.wait('attack');
  assert.equal(atk.lines, 4, '1対1では4段がそのまま届く');
  assert.equal(atk.from, ids[0], '誰から来たかがわかる');

  a.send({ t: 'state', s: { ren: 3, linesSent: 4 } });
  const st = await b.wait('state');
  assert.equal(st.s.ren, 3, '相手の盤面情報が届く');
  assert.equal(st.from, ids[0], '誰の盤面かがわかる');

  close();
});

test('攻撃量は不正な値でも安全に丸められる', async () => {
  const { cs: [a, b], close } = await makeRoom(['A', 'B']);
  a.send({ t: 'begin' });
  await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'attack', lines: 9999 });
  const atk = await b.wait('attack');
  assert.equal(atk.lines, 20, '上限20に丸められる');

  close();
});

test('人数が増えるとおじゃまの段数が減る', () => {
  assert.equal(garbageScale(2), 1);
  assert.equal(garbageScale(3), 0.75);
  assert.equal(garbageScale(4), 0.6);
  // 4人なら10段の攻撃が6段になる
  assert.equal(scaleGarbage(10, 4), 6);
  assert.equal(scaleGarbage(10, 3), 8);
  assert.equal(scaleGarbage(1, 4), 1, '減らしても0段にはならない');
});

test('4人だとおじゃまが実際に減って届く', async () => {
  const { cs, close } = await makeRoom(['A', 'B', 'C', 'D']);
  const [a] = cs;
  a.send({ t: 'begin' });
  await Promise.all(cs.map((c) => c.wait('start')));

  a.send({ t: 'attack', lines: 10 });
  const hit = await a.wait('hit');
  assert.equal(hit.lines, 6, '10段が6段になる');

  close();
});

test('しかえし優先: 自分を殴った相手に送り返す', async () => {
  const { cs, ids, close } = await makeRoom(['A', 'B', 'C']);
  const [a, b, c] = cs;
  a.send({ t: 'begin' });
  await Promise.all(cs.map((x) => x.wait('start')));

  // B が A を狙うまで撃たせる（3人なので最初はランダム）
  let hitOnA = null;
  for (let i = 0; i < 40 && !hitOnA; i++) {
    b.send({ t: 'attack', lines: 4 });
    const h = await b.wait('hit');
    if (h.to === ids[0]) hitOnA = h;
  }
  assert.ok(hitOnA, 'B の攻撃がいつかは A に当たる');

  // A が撃ち返すと、必ず B に飛ぶ
  a.drain('hit');
  for (let i = 0; i < 5; i++) {
    a.send({ t: 'attack', lines: 4 });
    const h = await a.wait('hit');
    assert.equal(h.from, ids[0]);
    assert.equal(h.to, ids[1], 'A は自分を殴った B に送り返す');
  }
  assert.ok(c, 'C は巻き込まれない');

  close();
});

test('3人: ひとり倒れても勝負は続き、最後の1人が勝つ', async () => {
  const { cs, ids, close } = await makeRoom(['A', 'B', 'C']);
  const [a, b, c] = cs;
  a.send({ t: 'begin' });
  await Promise.all(cs.map((x) => x.wait('start')));

  // A が倒れる
  a.send({ t: 'dead' });
  const outA = await b.wait('out');
  assert.equal(outA.id, ids[0]);
  assert.equal(outA.left, 2, 'まだ2人残っている');

  // この時点では誰にも勝敗は出ていない
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!b.inbox.some((m) => m.t === 'result'), 'まだ決着していない');

  // 倒れた A にも、B と C の盤面は届き続ける
  b.send({ t: 'state', s: { ren: 1 } });
  const seen = await a.wait('state');
  assert.equal(seen.from, ids[1], '脱落しても観戦できる');

  // B も倒れて決着
  b.send({ t: 'dead' });
  const rc = await c.wait('result');
  const rb = await b.wait('result');
  const ra = await a.wait('result');
  assert.equal(rc.win, true, '最後まで残った C の勝ち');
  assert.equal(rc.rank, 1);
  assert.equal(rb.win, false);
  assert.equal(rb.rank, 2, '2番目に倒れた B が2位');
  assert.equal(ra.rank, 3, '最初に倒れた A が3位');
  assert.equal(ra.total, 3);

  close();
});

test('相手が切断すると通知が届く', async () => {
  const { cs: [a, b], close } = await makeRoom(['A', 'B']);
  b.close();
  const left = await a.wait('peerLeft');
  assert.ok(left);
  a.close(); close();
});

test('対戦中に抜けると脱落あつかいになり、残りで決着する', async () => {
  const { cs, close } = await makeRoom(['A', 'B', 'C']);
  const [a, b, c] = cs;
  a.send({ t: 'begin' });
  await Promise.all(cs.map((x) => x.wait('start')));

  b.close();
  // 切断は peerLeft で伝わる。残り2人なので勝負は続く。
  const left = await a.wait('peerLeft');
  assert.ok(left, '切断の知らせが届く');

  a.send({ t: 'dead' });
  const rc = await c.wait('result');
  assert.equal(rc.win, true, '残った C の勝ち');

  a.close(); c.close(); close();
});

test('もう一度始めるとシードが変わる', async () => {
  const { cs: [a, b], close } = await makeRoom(['A', 'B']);
  a.send({ t: 'begin' });
  const [s1] = await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'dead' });
  await Promise.all([a.wait('result'), b.wait('result')]);

  a.send({ t: 'begin' });
  const [s2] = await Promise.all([a.wait('start'), b.wait('start')]);
  assert.notEqual(s1.seed, s2.seed, '次の対戦では別のミノ順になる');

  close();
});

test('昔のアプリ（準備完了を押す版）でもそのまま遊べる', async () => {
  const { cs: [a, b], close } = await makeRoom(['A', 'B']);
  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  const [s1, s2] = await Promise.all([a.wait('start'), b.wait('start')]);
  assert.equal(s1.seed, s2.seed);
  close();
});
