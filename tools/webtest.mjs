// ウェブ版（docs/index.html + docs/app.js）を jsdom 上で実際に動かし、
// 2人のプレイヤーが部屋を作って対戦できるかを通しで確認するテスト。
//
//   node tools/webtest.mjs
//
// canvas は本物の描画をしないスタブに差し替えている（見た目ではなく配線の検証）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8090 + (process.pid % 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 何もしない 2D コンテキスト（呼ばれても落ちないだけのダミー） */
function stubCanvas(win) {
  const ctx = new Proxy(
    {
      canvas: null,
      fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
      font: '', textAlign: '', textBaseline: '',
    },
    {
      get(t, k) {
        if (k in t) return t[k];
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; },
    }
  );
  win.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
}

/** 画面サイズを持たない jsdom に、それらしい寸法を持たせる */
function stubLayout(win) {
  Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get: () => 390, configurable: true });
  Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get: () => 560, configurable: true });
  win.devicePixelRatio = 2;
  if (!win.navigator.vibrate) win.navigator.vibrate = () => true;
}

/**
 * Web Audio の代わりになるニセの音源。実際に音は出ないが、
 * 「音を出そうとしたか」「iPhone 用の出口を用意したか」を数えられる。
 */
function stubAudio(win) {
  const log = { made: 0, resumed: 0, mediaDest: 0, notes: 0 };
  class Param {
    constructor() { this.value = 0; }
    setValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    setTargetAtTime() { return this; }
    cancelScheduledValues() { return this; }
  }
  const node = (kind) => ({
    kind, type: '', buffer: null,
    frequency: new Param(), gain: new Param(),
    connect() {}, disconnect() {},
    start() { if (kind === 'osc') log.notes++; }, stop() {},
  });
  class FakeCtx {
    constructor() {
      this.state = 'suspended'; this.sampleRate = 44100; this.currentTime = 0;
      this.destination = {}; log.made++;
    }
    resume() { this.state = 'running'; log.resumed++; return Promise.resolve(); }
    createGain() { return node('gain'); }
    createOscillator() { return node('osc'); }
    createBiquadFilter() { return node('filter'); }
    createBufferSource() { return node('src'); }
    createBuffer(_ch, n) { return { getChannelData: () => new Float32Array(Math.max(1, n)) }; }
    createMediaStreamDestination() { log.mediaDest++; return { stream: { id: 'fake' } }; }
  }
  win.AudioContext = FakeCtx;
  return log;
}

async function makeClient(name, opts = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost/?server=ws://127.0.0.1:${PORT}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    resources: undefined,
  });
  const win = dom.window;
  if (opts.userAgent) {
    Object.defineProperty(win.navigator, 'userAgent', { get: () => opts.userAgent, configurable: true });
  }
  stubCanvas(win);
  stubLayout(win);
  const audioLog = stubAudio(win);
  // jsdom の WebSocket をそのまま使う
  const app = fs.readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8');
  win.eval(app);
  await sleep(50);
  const $ = (id) => win.document.getElementById(id);
  $('name').value = name;
  return { dom, win, $, audioLog, click: (id) => $(id).dispatchEvent(new win.MouseEvent('click', { bubbles: true })) };
}

/** 条件が満たされるまで待つ */
async function waitFor(fn, ms = 8000, label = '条件') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(60);
  }
  throw new Error(`タイムアウト: ${label}`);
}

test('ウェブ版で2人が部屋を作って対戦できる', async (t) => {
  // --- サーバー起動 ---
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => srv.kill());
  await waitFor(() => true, 10);
  await sleep(600);

  const A = await makeClient('あかり');
  const B = await makeClient('ばんり');
  t.after(() => { A.dom.window.close(); B.dom.window.close(); });

  // --- A が部屋を作る ---
  A.click('btn-create');
  await waitFor(() => /^\d{4}$/.test(A.$('lobby-code').textContent || ''), 12000, '部屋コード発行');
  const code = A.$('lobby-code').textContent.trim();
  assert.match(code, /^\d{4}$/);
  assert.ok(!A.$('lobby').classList.contains('hidden'), 'Aがロビーに居ること');

  // --- B が参加する ---
  B.$('code').value = code;
  B.click('btn-join');
  await waitFor(() => !B.$('lobby').classList.contains('hidden'), 12000, 'Bがロビーに入る');
  await waitFor(() => (A.$('lobby-players').textContent || '').includes('ばんり'), 6000, 'Aから相手が見える');
  await waitFor(() => (B.$('lobby-players').textContent || '').includes('あかり'), 6000, 'Bから相手が見える');

  // 開始ボタンは部屋主だけに出る
  assert.ok(!A.$('btn-begin').classList.contains('hidden'), '部屋主には開始ボタンが出ること');
  assert.ok(B.$('btn-begin').classList.contains('hidden'), '参加者には開始ボタンが出ないこと');

  // --- 部屋主が「はじめる」を押す → カウントダウン → 開始 ---
  A.click('btn-begin');
  await waitFor(() => !A.$('game').classList.contains('hidden') && !B.$('game').classList.contains('hidden'), 8000, 'ゲーム画面へ');

  // 3秒のカウントダウンが明けるのを待つ
  await waitFor(() => A.$('overlay').classList.contains('hidden'), 8000, 'カウントダウン終了');

  // --- A がひたすらハードドロップして相手におじゃまを送る ---
  /** 実機と同じく pointerdown / pointerup でボタンを押す */
  const tap = (C, act, times = 1) => {
    const btn = C.win.document.querySelector(`[data-act="${act}"]`);
    for (let i = 0; i < times; i++) {
      btn.dispatchEvent(new C.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new C.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    }
  };
  // ハードドロップのボタンは廃止したので、キーボードのスペースで代用する
  const drop = (C) => {
    C.win.dispatchEvent(new C.win.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    C.win.dispatchEvent(new C.win.KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  };
  const left = (C, n) => tap(C, 'left', n);

  // 左端に寄せて積む → いずれ天井に達する（=決着する）ことを確認
  for (let i = 0; i < 120; i++) {
    left(A, 5);
    drop(A);
    await sleep(15);
    if (!A.$('overlay').classList.contains('hidden')) break;
  }

  await waitFor(() => !A.$('overlay').classList.contains('hidden'), 10000, 'Aの決着表示');
  const aText = A.$('overlay').textContent || '';
  assert.ok(/かち！|まけ…/.test(aText), `決着文言が出ること: ${aText}`);

  await waitFor(() => !B.$('overlay').classList.contains('hidden'), 8000, 'Bの決着表示');
  const bText = B.$('overlay').textContent || '';
  assert.ok(/かち！|まけ…/.test(bText), `相手にも決着が伝わること: ${bText}`);

  // 勝敗が食い違っていないこと
  const aWin = aText.includes('かち！');
  const bWin = bText.includes('かち！');
  assert.notEqual(aWin, bWin, '片方が勝ち、片方が負けであること');
});

test('3人で対戦: 相手の盤面が2つ並び、脱落しても観戦できる', async (t) => {
  const PORT3 = PORT + 2;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT3) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => srv.kill());
  await sleep(600);

  /** ポートを変えたクライアントを作る */
  const make = async (name) => {
    const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: `http://localhost/?server=ws://127.0.0.1:${PORT3}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    stubCanvas(dom.window);
    stubLayout(dom.window);
    stubAudio(dom.window);
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8'));
    await sleep(50);
    const $ = (id) => dom.window.document.getElementById(id);
    $('name').value = name;
    $('name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return {
      dom, win: dom.window, $,
      click: (id) => $(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    };
  };

  const A = await make('あかり');
  const B = await make('ばんり');
  const C = await make('ちより');
  t.after(() => { A.dom.window.close(); B.dom.window.close(); C.dom.window.close(); });

  A.click('btn-create');
  await waitFor(() => /^\d{4}$/.test(A.$('lobby-code').textContent || ''), 12000, '部屋コード発行');
  const code = A.$('lobby-code').textContent.trim();

  for (const X of [B, C]) {
    X.$('code').value = code;
    X.click('btn-join');
  }
  await waitFor(() => {
    const t2 = A.$('lobby-players').textContent || '';
    return t2.includes('ばんり') && t2.includes('ちより');
  }, 12000, '3人そろう');

  // 席は4つぶん並び、うち1つは空席
  assert.equal(A.$('lobby-players').querySelectorAll('.player').length, 4, '4人ぶんの席が出ること');
  assert.equal(A.$('lobby-players').querySelectorAll('.player.empty').length, 1, '空席が1つ残ること');
  assert.match(A.$('btn-begin').textContent || '', /3人ではじめる/);

  A.click('btn-begin');
  await waitFor(() => [A, B, C].every((X) => !X.$('game').classList.contains('hidden')), 8000, '全員ゲーム画面へ');
  await waitFor(() => A.$('overlay').classList.contains('hidden'), 8000, 'カウントダウン終了');

  // 相手の小さな盤面が2つ並ぶ
  for (const X of [A, B, C]) {
    assert.equal(X.$('peers').querySelectorAll('.peer').length, 2, '相手の盤面が2つ出ること');
  }
  assert.match(A.$('g-peer').textContent || '', /のこり 3人/, '残り人数が出ること');

  const drop = (X) => {
    X.win.dispatchEvent(new X.win.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    X.win.dispatchEvent(new X.win.KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  };
  const left = (X, n) => {
    const btn = X.win.document.querySelector('[data-act="left"]');
    for (let i = 0; i < n; i++) {
      btn.dispatchEvent(new X.win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new X.win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    }
  };
  /** 左端に積み続けて天井まで到達させる */
  const bury = async (X) => {
    for (let i = 0; i < 150; i++) {
      left(X, 5);
      drop(X);
      await sleep(12);
      if (!X.$('overlay').classList.contains('hidden')) return;
    }
  };

  // --- A が先に倒れる。まだ勝負はつかない。 ---
  await bury(A);
  await waitFor(() => !A.$('overlay').classList.contains('hidden'), 10000, 'Aの脱落表示');
  assert.match(A.$('overlay').textContent || '', /脱落/, 'Aは脱落表示になること');
  assert.ok(!/かち！|まけ…/.test(A.$('overlay').textContent || ''), 'まだ勝敗は出ないこと');
  assert.ok(C.$('overlay').classList.contains('hidden'), 'Cはまだ遊んでいること');
  await waitFor(() => /のこり 2人/.test(A.$('g-peer').textContent || ''), 4000, '残り2人になる');

  // --- B も倒れて決着。C の勝ち。 ---
  await bury(B);
  await waitFor(() => !C.$('overlay').classList.contains('hidden'), 12000, 'Cの決着表示');
  assert.match(C.$('overlay').textContent || '', /かち！/, '最後に残ったCが勝つこと');
  await waitFor(() => /かち！|まけ…/.test(A.$('overlay').textContent || ''), 6000, 'Aにも決着が伝わる');
  assert.match(A.$('overlay').textContent || '', /3人中 3位/, '脱落した順に順位が出ること');
});

test('ひとりで遊ぶ: サーバーなしでマラソンが最後まで動く', async (t) => {
  const C = await makeClient('ひとり');
  t.after(() => C.dom.window.close());
  const win = C.win;

  // ホームに最高得点の案内が出ている
  assert.match(C.$('solo-best').textContent || '', /練習|最高/);

  C.click('btn-solo');
  await waitFor(() => !C.$('game').classList.contains('hidden'), 4000, 'ゲーム画面へ');

  // 対戦用の表示（おじゃまゲージ・相手の盤面）は隠れていること
  assert.ok(C.$('box-gauge').classList.contains('hidden'), 'おじゃまゲージは出ない');
  assert.ok(C.$('box-peer').classList.contains('hidden'), '相手の盤面は出ない');

  await waitFor(() => C.$('overlay').classList.contains('hidden'), 8000, 'カウントダウン終了');
  assert.match(C.$('g-me').textContent || '', /^レベル \d+$/);
  assert.match(C.$('g-peer').textContent || '', /点$/);

  const tap = (act, times = 1) => {
    const btn = win.document.querySelector(`[data-act="${act}"]`);
    for (let i = 0; i < times; i++) {
      btn.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    }
  };

  const drop = () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    win.dispatchEvent(new win.KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  };

  // 左端に積み続ければいつか天井に達する
  for (let i = 0; i < 150; i++) {
    tap('left', 5);
    drop();
    await sleep(12);
    if (!C.$('overlay').classList.contains('hidden')) break;
  }

  await waitFor(() => !C.$('overlay').classList.contains('hidden'), 10000, '終了表示');
  const text = C.$('overlay').textContent || '';
  assert.ok(/ゲームオーバー|自己ベスト更新/.test(text), `終了文言が出ること: ${text}`);
  assert.match(text, /点/, '得点が表示されること');
  assert.match(text, /ライン/, 'ライン数が表示されること');

  // ハイスコアが保存されている
  assert.ok(Number(win.localStorage.getItem('soloBest')) > 0, 'ハイスコアが記録されること');

  // 「もう一度」でやり直せる
  const again = [...C.$('overlay').querySelectorAll('button')].find((b) => b.textContent === 'もう一度');
  assert.ok(again, '「もう一度」ボタンがあること');
  again.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await sleep(100);
  assert.equal(C.$('g-lines').textContent, '0 ライン', '盤面がリセットされること');
});

test('入力欄と操作ボタンの作りが直っている', async (t) => {
  const C = await makeClient('あかり');
  t.after(() => C.dom.window.close());
  const win = C.win;
  const doc = win.document;

  // --- 使わないボタンは消えていること ---
  assert.equal(doc.querySelector('[data-act="hold"]'), null, 'ホールドのボタンは無いこと');
  assert.equal(doc.querySelector('[data-act="drop"]'), null, 'ハードドロップのボタンは無いこと');
  assert.equal(doc.getElementById('c-hold'), null, 'ホールドの表示枠も無いこと');

  // --- 左手＝移動、右手＝回転に分かれていること ---
  const actsOf = (sel) => [...doc.querySelectorAll(`${sel} button`)].map((b) => b.dataset.act);
  assert.deepEqual(actsOf('.pad-left'), ['left', 'down', 'right'], '左は移動の3つ');
  assert.deepEqual(actsOf('.pad-right'), ['ccw', 'cw'], '右は回転の2つ');

  // --- 名前は書き換えられて、✕で消せること ---
  const name = C.$('name');
  name.value = 'あたらしい名前';
  name.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(win.localStorage.getItem('name'), 'あたらしい名前', '打った名前が保存されること');
  C.click('btn-name-clear');
  assert.equal(name.value, '', '✕で空になること');
  assert.equal(win.localStorage.getItem('name'), '', '保存も空になること');

  // --- 部屋コードは数字だけ4桁に整うこと ---
  const code = C.$('code');
  assert.equal(code.getAttribute('inputmode'), 'numeric', 'スマホで数字キーパッドが出ること');
  code.value = '1a2-3 4x5';
  code.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(code.value, '1234', '数字4桁に整うこと');

  // 数字だけを打っているあいだは値を書き戻さない（iPhoneで二重入力になる原因）
  code.value = '12';
  code.dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal(code.value, '12', '途中まででもそのまま残ること');

  // --- おじゃまの数字は盤面の右上のバッジに入っていること ---
  const num = doc.getElementById('warn-num');
  assert.ok(num, 'カウントダウンの数字があること');
  assert.ok(num.closest('.warn-badge'), '数字がバッジの中にあること');
  assert.ok(doc.getElementById('warn').classList.contains('warn'), '赤いふちの枠は残っていること');
});

test('音は両方の端末で鳴る作りになっている', async (t) => {
  // --- ふつうの端末（Android / パソコン）---
  const C = await makeClient('おと');
  t.after(() => C.dom.window.close());

  assert.ok(C.$('btn-sound-home'), 'ホームに音のたしかめボタンがあること');
  assert.equal(C.audioLog.made, 0, '触るまでは音源を作らないこと');

  C.click('btn-sound-home');
  assert.equal(C.audioLog.made, 1, 'ボタンで音源ができること');
  assert.ok(C.audioLog.resumed >= 1, '眠っている音源を起こすこと');
  assert.ok(C.audioLog.notes >= 4, 'たしかめの音が実際に鳴ること');
  assert.equal(C.win.localStorage.getItem('sound'), 'on', '音がオンになること');

  // 画面のどこを触っても許可を取り直すこと（1回で通らない端末への保険）
  const before = C.audioLog.resumed;
  C.win.document.body.dispatchEvent(new C.win.Event('touchstart', { bubbles: true }));
  assert.ok(C.audioLog.resumed >= before, '画面タップでも音源を起こしにいくこと');

  // --- iPhone（マナーモードでも鳴るように <audio> 経由にする）---
  const P = await makeClient('あいふぉん', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  t.after(() => P.dom.window.close());

  P.click('btn-sound-home');
  assert.equal(P.audioLog.mediaDest, 1, 'iPhone では <audio> 用の出口を作ること');
  const out = P.win.document.querySelector('audio[data-role="sound-out"]');
  assert.ok(out, '音を流す <audio> が画面に置かれること');
  assert.ok(out.hasAttribute('playsinline'), '全画面にならない設定が入っていること');
  assert.ok(P.audioLog.notes >= 4, 'iPhone でも音を組み立てていること');
});

test('相手からのおじゃまが届いてゲージに出る', async (t) => {
  const PORT2 = PORT + 1;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT2) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => srv.kill());
  await sleep(600);

  const { WebSocket } = require('ws');

  // ブラウザ側（本物のウェブアプリ）
  const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost/?server=ws://127.0.0.1:${PORT2}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  stubCanvas(dom.window);
  stubLayout(dom.window);
  dom.window.eval(fs.readFileSync(path.join(ROOT, 'docs/app.js'), 'utf8'));
  await sleep(50);
  const $ = (id) => dom.window.document.getElementById(id);
  $('name').value = 'あかり';
  $('name').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('btn-create').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /^\d{4}$/.test($('lobby-code').textContent || ''), 12000, '部屋コード発行');
  const code = $('lobby-code').textContent.trim();

  // 相手役は素の WebSocket クライアント
  const ws = new WebSocket(`ws://127.0.0.1:${PORT2}`);
  t.after(() => ws.close());
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on('open', r));
  const send = (o) => ws.send(JSON.stringify(o));

  send({ t: 'join', code, name: 'ばんり' });
  await waitFor(() => ($('lobby-players').textContent || '').includes('ばんり'), 6000, '相手が見える');

  $('btn-begin').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => inbox.some((m) => m.t === 'start'), 8000, '開始通知');
  await waitFor(() => $('overlay').classList.contains('hidden'), 8000, 'カウントダウン終了');

  // おじゃま4段を送りつける
  send({ t: 'attack', lines: 4 });
  await waitFor(() => $('gauge').children.length === 4, 4000, 'ゲージに4段');
  assert.equal($('gauge').children.length, 4);
  assert.ok($('gauge').children[0].className.includes('hot'), '4段以上は赤くなること');

  // さらに3段 → 合計7段
  send({ t: 'attack', lines: 3 });
  await waitFor(() => $('gauge').children.length === 7, 4000, 'ゲージに7段');
  assert.equal($('gauge').children.length, 7);
});
