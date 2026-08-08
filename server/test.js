// サーバーの動作テスト: npm test
// 実際にサーバーを起動して、2人のクライアントで一連の流れを確認する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
    open: () => new Promise((r) => ws.on('open', r)),
    close: () => ws.close(),
  };
}

test.before(async () => {
  proc = spawn('node', [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 700));
});

test.after(() => proc?.kill());

test('部屋を作って相手が参加し、同じシードで対戦が始まる', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);

  a.send({ t: 'create', name: 'いけだい' });
  const room = await a.wait('room');
  assert.match(room.code, /^[A-Z2-9]{4}$/, '4文字の部屋コードが返る');
  assert.equal(room.host, true);

  b.send({ t: 'join', code: room.code, name: 'ともだち' });
  const joined = await b.wait('room');
  assert.equal(joined.code, room.code);

  const peerForA = await a.wait('peer');
  assert.equal(peerForA.name, 'ともだち', '相手の名前が届く');

  a.send({ t: 'ready' });
  b.send({ t: 'ready' });
  const startA = await a.wait('start');
  const startB = await b.wait('start');
  assert.equal(startA.seed, startB.seed, '両者に同じシードが配られる（＝同じミノ順）');
  assert.ok(typeof startA.seed === 'number');

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

test('3人目は満員で入れない', async () => {
  const a = connect(); const b = connect(); const c = connect();
  await Promise.all([a.open(), b.open(), c.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');
  c.send({ t: 'join', code: room.code, name: 'C' });
  const err = await c.wait('error');
  assert.match(err.msg, /満員/);
  a.close(); b.close(); c.close();
});

test('おじゃまブロックと盤面が相手に中継される', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'attack', lines: 4 });
  const atk = await b.wait('attack');
  assert.equal(atk.lines, 4, '4段のおじゃまが相手に届く');

  a.send({ t: 'state', s: { ren: 3, linesSent: 4 } });
  const st = await b.wait('state');
  assert.equal(st.s.ren, 3, '相手の盤面情報が届く');

  a.close(); b.close();
});

test('攻撃量は不正な値でも安全に丸められる', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');

  a.send({ t: 'attack', lines: 9999 });
  const atk = await b.wait('attack');
  assert.equal(atk.lines, 20, '上限20に丸められる');

  a.close(); b.close();
});

test('倒れたら両者に勝敗が通知される', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'dead' });
  const ra = await a.wait('result');
  const rb = await b.wait('result');
  assert.equal(ra.win, false, '倒れた側は負け');
  assert.equal(rb.win, true, '相手は勝ち');

  a.close(); b.close();
});

test('相手が切断すると通知が届く', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');
  await a.wait('peer');

  b.close();
  const left = await a.wait('peerLeft');
  assert.ok(left);
  a.close();
});

test('再戦するとシードが変わる', async () => {
  const a = connect(); const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'create', name: 'A' });
  const room = await a.wait('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait('room');
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  const [s1] = await Promise.all([a.wait('start'), b.wait('start')]);

  a.send({ t: 'dead' });
  await Promise.all([a.wait('result'), b.wait('result')]);

  a.send({ t: 'rematch' }); b.send({ t: 'rematch' });
  const [s2] = await Promise.all([a.wait('start'), b.wait('start')]);
  assert.notEqual(s1.seed, s2.seed, '再戦では別のミノ順になる');

  a.close(); b.close();
});
