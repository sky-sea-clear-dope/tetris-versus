// ウェブ版 対戦テトリス。
// ゲームの中身（エンジン）と通信部分は、スマホアプリ版とまったく同じものを使い回している。

import { TetrisGame, type Snapshot } from '../../app/src/engine/engine';
import {
  COLS, ROWS, COLORS, SHAPES, PIECE_ID, type PieceType, type Cell,
} from '../../app/src/engine/constants';
import { NetClient, type NetStatus, type PlayerInfo } from '../../app/src/net/client';
import { DEFAULT_SERVER_URL } from './config';
import * as audio from './audio';

// ---------------------------------------------------------------- 小道具

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string) => $(id).classList.remove('hidden');
const hide = (id: string) => $(id).classList.add('hidden');

/** サーバーのアドレス。?server=... → 保存値 → 既定値 の順で決める。 */
function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  return localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL;
}

function vibrate(ms: number | number[]) {
  try { navigator.vibrate?.(ms); } catch { /* 未対応端末は無視 */ }
}

let wakeLock: any = null;
async function keepAwake(on: boolean) {
  try {
    if (on) wakeLock = await (navigator as any).wakeLock?.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch { /* 未対応でも支障なし */ }
}

// ---------------------------------------------------------------- 描画

const boardCanvas = $('c-board') as HTMLCanvasElement;
const nextCanvas = $('c-next') as HTMLCanvasElement;

const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

function fitCanvas(cv: HTMLCanvasElement, cssW: number, cssH: number) {
  const r = dpr();
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  cv.width = Math.round(cssW * r);
  cv.height = Math.round(cssH * r);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}

let cellSize = 16;

/** 画面サイズに合わせて盤面の大きさを決め直す */
function layout() {
  const main = document.querySelector('.game-main') as HTMLElement;
  if (!main) return;
  const availW = main.clientWidth - 74 * 2 - 16 - 16;
  const availH = main.clientHeight - 4;
  cellSize = Math.max(9, Math.floor(Math.min(availW / COLS, availH / ROWS)));
  fitCanvas(boardCanvas, cellSize * COLS, cellSize * ROWS);
  drawAll();
  drawPeers();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** cells は ROWS×COLS。負の値はゴースト（落下予測位置）。 */
function paintBoard(ctx: CanvasRenderingContext2D, cells: Cell[][], cs: number) {
  const w = COLS * cs, h = ROWS * cs;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#0e1526';
  roundRect(ctx, 0, 0, w, h, 4);
  ctx.fill();

  // 薄い格子
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < COLS; x++) { ctx.moveTo(x * cs + .5, 0); ctx.lineTo(x * cs + .5, h); }
  for (let y = 1; y < ROWS; y++) { ctx.moveTo(0, y * cs + .5); ctx.lineTo(w, y * cs + .5); }
  ctx.stroke();

  const pad = cs > 12 ? 1 : 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v = cells[y]?.[x] ?? 0;
      if (v === 0) continue;
      const px = x * cs + pad, py = y * cs + pad, sz = cs - pad * 2;
      if (v < 0) {
        ctx.strokeStyle = COLORS[-v] ?? '#888';
        ctx.globalAlpha = .38;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, sz - 2, sz - 2);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = COLORS[v] ?? '#888';
        roundRect(ctx, px, py, sz, sz, Math.max(1, cs * .13));
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.22)';
        ctx.fillRect(px, py, sz, Math.max(1, sz * .18));
      }
    }
  }
}

/** ミノ1個を枠の中央に描く */
function paintPiece(ctx: CanvasRenderingContext2D, type: PieceType | null, cx: number, cy: number, cs: number) {
  if (!type) return;
  const shape = SHAPES[type][0];
  const xs = shape.map((s) => s[0]), ys = shape.map((s) => s[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = (maxX - minX + 1) * cs, h = (maxY - minY + 1) * cs;
  const ox = cx - w / 2 - minX * cs, oy = cy - h / 2 - minY * cs;
  ctx.fillStyle = COLORS[PIECE_ID[type]];
  for (const [dx, dy] of shape) {
    roundRect(ctx, ox + dx * cs + .5, oy + dy * cs + .5, cs - 1, cs - 1, 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- 状態

// spectate ＝ 自分は倒れたが、まだ勝負がついていないので見物している状態
type Phase = 'home' | 'lobby' | 'count' | 'play' | 'pause' | 'spectate' | 'over';

/** 1部屋の定員（サーバーと合わせている） */
const MAX_PLAYERS = 4;

const state = {
  phase: 'home' as Phase,
  name: localStorage.getItem('name') || '',
  code: '' as string,
  host: false,
  /** 部屋のなかでの自分の番号 */
  meId: 0,
  /** 部屋にいる全員（自分をふくむ） */
  players: [] as PlayerInfo[],
  /** 相手ごとの盤面。鍵は番号。 */
  snaps: {} as Record<number, Snapshot>,
  /** いま自分がおじゃまを送っている相手 */
  aimTo: 0,
  /** 自分をねらってきている相手 */
  aimedBy: 0,
  game: null as TetrisGame | null,
  startAt: 0,
  win: null as boolean | null,
  softDrop: false,
  /** 一人用（マラソン）で遊んでいるか */
  solo: false,
};

/** 番号から名前を引く */
function nameOf(id: number): string {
  return state.players.find((p) => p.id === id)?.name || 'だれか';
}

// ---------------------------------------------------------------- ハイスコア

const BEST_KEY = 'soloBest';
const bestScore = () => Number(localStorage.getItem(BEST_KEY) || 0);
function saveBest(score: number): boolean {
  if (score <= bestScore()) return false;
  localStorage.setItem(BEST_KEY, String(score));
  return true;
}
function renderBest() {
  const b = bestScore();
  $('solo-best').textContent = b > 0 ? `これまでの最高 ${b.toLocaleString()} 点` : '好きなだけ練習できます';
}

let net: NetClient | null = null;

// ---------------------------------------------------------------- 通信

function setStatus(s: NetStatus, detail?: string) {
  const dot = $('dot'), txt = $('status-text');
  dot.className = 'dot';
  if (s === 'connecting') { dot.classList.add('busy'); txt.textContent = detail || 'サーバーに接続中…（初回は最大1分）'; }
  else if (s === 'connected') { dot.classList.add('on'); txt.textContent = '接続できています'; }
  else if (s === 'error') { dot.classList.add('err'); txt.textContent = detail || 'つながりません'; }
  else txt.textContent = '未接続';
}

function ensureNet(): NetClient {
  if (net) return net;
  net = new NetClient(serverUrl(), {
    onStatus: setStatus,
    onRoom: (code, host, id) => {
      state.code = code; state.host = host; state.meId = id ?? 0;
      state.players = []; state.snaps = {};
      goLobby();
    },
    onPlayers: (list, _started, you) => {
      state.players = list;
      if (you) state.meId = you;
      if (state.phase === 'lobby') renderLobby();
      else { renderPeers(); updateAliveLabel(); }
    },
    onStart: (seed, at) => startMatch(seed, at),
    onState: (snap, from) => {
      state.snaps[from || 0] = snap;
      drawPeers();
    },
    onAttack: (lines, from) => {
      if (state.solo) return; // 一人用ではおじゃまは飛んでこない
      state.aimedBy = from || 0;
      state.game?.receiveGarbage(lines);
      vibrate([0, 40, 60, 40]);
      audio.sfxWarn();
      lastCountShown = -1; // カウントダウンを鳴らし直す
      drawGauge();
      drawPeers();
    },
    onHit: (from, to) => {
      // 自分が撃ったぶんだけ「どこに飛んだか」を覚えておく
      if (from === state.meId) { state.aimTo = to; drawPeers(); }
    },
    onOut: (id, left) => {
      if (id === state.meId) { showSpectate(left); return; }
      showBanner(`${nameOf(id)} 脱落　のこり${left}人`);
      if (state.aimTo === id) state.aimTo = 0;
      if (state.aimedBy === id) state.aimedBy = 0;
      drawPeers();
      updateAliveLabel();
    },
    onResult: (win, rank, total) => finish(win, rank, total),
    onError: (msg) => setStatus('error', msg),
  });
  net.connect();
  return net;
}

// ---------------------------------------------------------------- 画面遷移

function goHome() {
  state.phase = 'home';
  state.solo = false;
  keepAwake(false);
  audio.stopMusic();
  show('home'); hide('lobby'); hide('game');
  renderBest();
}

function goLobby() {
  state.phase = 'lobby';
  audio.stopMusic();
  hide('home'); show('lobby'); hide('game');
  renderLobby();
}

/** 参加者ひとりぶんの行を作る */
function playerRow(label: string, tag: string, filled: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'player' + (filled ? '' : ' empty');
  const dot = document.createElement('span');
  dot.className = 'dot' + (filled ? ' on' : '');
  const wrap = document.createElement('div');
  const nm = document.createElement('div');
  nm.textContent = label;
  const tg = document.createElement('div');
  tg.className = 'tag';
  tg.textContent = tag;
  wrap.append(nm, tg);
  row.append(dot, wrap);
  return row;
}

function renderLobby() {
  $('lobby-code').textContent = state.code || '----';

  // 参加者一覧。まだサーバーから届いていないときは自分だけ出しておく。
  const list: PlayerInfo[] = state.players.length
    ? state.players
    : [{ id: state.meId, name: state.name || 'あなた', host: state.host, alive: true }];

  const box = $('lobby-players');
  box.innerHTML = '';
  for (const p of list) {
    const tags: string[] = [];
    if (p.id === state.meId) tags.push('あなた');
    if (p.host) tags.push('部屋主');
    box.append(playerRow(p.name, tags.join('・'), true));
  }
  for (let i = list.length; i < MAX_PLAYERS; i++) {
    box.append(playerRow('あいている席', 'コードを伝えて誘えます', false));
  }

  const me = state.players.find((p) => p.id === state.meId);
  const amHost = me ? me.host : state.host;
  const btn = $('btn-begin') as HTMLButtonElement;
  const enough = list.length >= 2;
  if (amHost) {
    btn.classList.remove('hidden');
    btn.disabled = !enough;
    btn.textContent = enough ? `${list.length}人ではじめる` : '仲間を待っています…';
    $('lobby-note').textContent = enough
      ? '全員そろったら「はじめる」を押してください。'
      : 'あと1人以上入ると始められます。';
  } else {
    btn.classList.add('hidden');
    $('lobby-note').textContent = '部屋主が「はじめる」を押すまで待ってください。';
  }
}

function startMatch(seed: number, at: number) {
  state.solo = false;
  state.snaps = {};
  state.aimTo = 0;
  state.aimedBy = 0;
  beginGame(seed, at);
  show('box-gauge'); show('box-peer');
  $('g-me').textContent = state.name || 'あなた';
  renderPeers();
  updateAliveLabel();
}

/** 画面の右上に「のこり◯人」を出す（1対1のときは相手の名前） */
function updateAliveLabel() {
  if (state.solo) return;
  const others = state.players.filter((p) => p.id !== state.meId);
  const alive = state.players.filter((p) => p.alive).length;
  $('g-peer').textContent = others.length <= 1
    ? (others[0]?.name || '相手')
    : `のこり ${alive}人`;
}

/** 一人用マラソンを始める。サーバーも相手も使わない。 */
function startSolo() {
  state.solo = true;
  beginGame((Math.random() * 2 ** 31) | 0, Date.now() + 3200);
  hide('box-gauge'); hide('box-peer');
  drawSoloHud();
}

function beginGame(seed: number, at: number) {
  state.game = new TetrisGame(seed);
  // 時間切れでおじゃまがせり上がった瞬間の演出
  state.game.onGarbageDrop = (lines) => {
    audio.sfxGarbage();
    vibrate([0, 90, 50, 120]);
    shakeBoard();
    hide('warn');
    lastCountShown = -1;
    drawGauge();
    showBanner(`おじゃま ${lines}段！`);
  };
  state.snaps = {};
  state.win = null;
  state.startAt = at;
  state.phase = 'count';
  hide('home'); hide('lobby'); show('game');
  hide('warn'); hide('banner'); hide('overlay');
  lastCountShown = -1;
  keepAwake(true);
  audio.startMusic();
  // 音の許可がまだ下りていないときは、その場で気づけるように知らせる
  setTimeout(() => {
    if (audio.status() === 'blocked') showBanner('画面をタップすると音が出ます');
  }, 600);
  requestAnimationFrame(() => { layout(); });
  lastFrame = performance.now();
  loop();
}

/** 一人用の見出し（レベルと点数） */
function drawSoloHud() {
  const g = state.game;
  if (!g) return;
  $('g-me').textContent = `レベル ${g.level}`;
  $('g-peer').textContent = `${g.score.toLocaleString()} 点`;
}

/** 一人用の終了画面 */
function finishSolo() {
  if (state.phase === 'over') return;
  state.phase = 'over';
  keepAwake(false);
  hide('warn');
  audio.stopMusic();
  audio.sfxEnd(false);
  vibrate(200);

  const g = state.game!;
  const isBest = saveBest(g.score);

  const ov = $('overlay');
  ov.innerHTML = '';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:30px;font-weight:900';
  h.textContent = isBest ? '自己ベスト更新！' : 'ゲームオーバー';
  const s = document.createElement('div');
  s.style.cssText = 'color:#e7ecf7;font-size:15px;line-height:1.9';
  s.textContent = `${g.score.toLocaleString()} 点`;
  const d = document.createElement('div');
  d.style.cssText = 'color:#8595b8;font-size:13px;line-height:1.8';
  d.textContent = `${g.linesCleared} ライン / レベル ${g.level}　最高 ${bestScore().toLocaleString()} 点`;
  const again = document.createElement('button');
  again.className = 'primary';
  again.style.cssText = 'width:200px';
  again.textContent = 'もう一度';
  again.onclick = () => startSolo();
  const home = document.createElement('button');
  home.className = 'link';
  home.textContent = 'ホームに戻る';
  home.onclick = () => goHome();
  ov.append(h, s, d, again, home);
  show('overlay');
}

/**
 * 自分だけ先に倒れたとき。まだ勝負はついていないので、
 * 部屋を出ずに最後の1人が決まるまで見ていられるようにする。
 */
function showSpectate(left: number) {
  if (state.phase === 'over') return;
  state.phase = 'spectate';
  keepAwake(false);
  hide('warn');
  audio.stopMusic();
  audio.sfxEnd(false);
  vibrate(200);
  updateAliveLabel();
  drawPeers();

  const ov = $('overlay');
  ov.innerHTML = '';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:26px;font-weight:900';
  h.textContent = '脱落…';
  const s = document.createElement('div');
  s.style.cssText = 'color:#8595b8;font-size:13px;line-height:1.8';
  s.textContent = `のこり${left}人。決着まで右で見ていられます。`;
  const home = document.createElement('button');
  home.className = 'link';
  home.textContent = 'ホームに戻る';
  home.onclick = () => { net?.leave(); state.code = ''; goHome(); };
  ov.append(h, s, home);
  show('overlay');
}

function finish(win: boolean, rank?: number, total?: number) {
  if (state.phase === 'over') return;
  const wasSpectating = state.phase === 'spectate';
  state.phase = 'over';
  state.win = win;
  keepAwake(false);
  hide('warn');
  audio.stopMusic();
  if (!wasSpectating) { audio.sfxEnd(win); vibrate(win ? [40, 60, 40] : 200); }

  const ov = $('overlay');
  ov.innerHTML = '';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:34px;font-weight:900';
  h.textContent = win ? 'かち！' : 'まけ…';
  const r = document.createElement('div');
  r.style.cssText = 'font-size:15px;font-weight:700';
  r.textContent = total && total > 2 && rank ? `${total}人中 ${rank}位` : '';
  const s = document.createElement('div');
  s.style.cssText = 'color:#8595b8;font-size:13px;line-height:1.8';
  const g = state.game;
  s.textContent = g ? `${g.linesCleared} ライン消去 / ${g.linesSent} 段おくった` : '';
  const again = document.createElement('button');
  again.className = 'primary';
  again.style.cssText = 'width:200px';
  again.textContent = 'ロビーに戻る';
  again.onclick = () => goLobby();
  const home = document.createElement('button');
  home.className = 'link';
  home.textContent = 'ホームに戻る';
  home.onclick = () => { net?.leave(); state.code = ''; goHome(); };
  ov.append(h, r, s, again, home);
  show('overlay');
}

/**
 * ゲーム中に「メニュー」を押したとき。
 *
 * うっかり押して遊びが台無しにならないよう、かならず一度たずねる。
 * ひとりのときは、たずねているあいだ時間を止めておける。
 * 対戦のときは相手が待っているので止められない。そのぶん、
 * 出ると負けになることをはっきり書いておく。
 */
function askMenu() {
  // 開始前のカウントダウン中は出さない。あの3秒はすぐ終わるし、
  // 数字を出している場所とぶつかってしまう。
  if (state.phase !== 'play') return;
  if (state.solo) state.phase = 'pause';

  const ov = $('overlay');
  ov.innerHTML = '';

  const h = document.createElement('div');
  h.style.cssText = 'font-size:20px;font-weight:800';
  h.textContent = 'メニューに戻りますか？';

  const s = document.createElement('div');
  s.style.cssText = 'color:#8595b8;font-size:13px;line-height:1.7';
  s.textContent = state.solo
    ? 'いまの遊びはここで終わりになります。'
    : '対戦の途中です。戻ると、あなたは脱落あつかいになります。';

  const back = document.createElement('button');
  back.className = 'primary';
  back.style.cssText = 'width:200px';
  back.textContent = 'メニューに戻る';
  back.onclick = () => {
    hide('overlay');
    if (!state.solo) {
      net?.sendDead(); net?.leave();
      state.code = ''; state.players = []; state.meId = 0;
    }
    goHome();
  };

  const stay = document.createElement('button');
  stay.className = 'link';
  stay.textContent = 'ゲームにもどる';
  stay.onclick = () => {
    hide('overlay');
    if (state.solo) state.phase = 'play';   // 一時停止を解く
  };

  ov.append(h, s, back, stay);
  show('overlay');
}

// ---------------------------------------------------------------- ゲームループ

const TICK_CAP = 100;
let lastFrame = 0;
let stateTimer = 0;

function loop() {
  if (state.phase !== 'count' && state.phase !== 'play' && state.phase !== 'pause'
      && state.phase !== 'spectate' && state.phase !== 'over') return;
  const now = performance.now();
  const dt = Math.min(now - lastFrame, TICK_CAP);
  lastFrame = now;

  // 一時停止のあいだは、時間をいっさい進めない。
  // ここで lastFrame だけ進めておくので、再開したときに
  // 止まっていたぶんがまとめて落ちてくることもない。
  if (state.phase === 'pause') { drawAll(); requestAnimationFrame(loop); return; }

  if (state.phase === 'count') {
    const left = Math.ceil((state.startAt - Date.now()) / 1000);
    if (left > 0) {
      const ov = $('overlay');
      ov.innerHTML = '';
      const c = document.createElement('div');
      c.className = 'count';
      c.textContent = String(left);
      ov.append(c);
      show('overlay');
    } else {
      hide('overlay');
      state.phase = 'play';
      vibrate(20);
    }
  } else if (state.phase === 'play') {
    const g = state.game!;
    const res = g.tick(dt, state.softDrop);
    if (res) onLock(res);

    drawWarning();
    audio.setDanger(dangerLevel());

    if (!state.solo) {
      stateTimer += dt;
      if (stateTimer >= 100) { // 相手には毎秒10回だけ送る
        stateTimer = 0;
        net?.sendState(g.snapshot());
      }
    }
  }

  drawAll();
  requestAnimationFrame(loop);
}

function onLock(res: ReturnType<TetrisGame['hardDrop']>) {
  const g = state.game!;
  if (!state.solo && res.attack > 0) net?.sendAttack(res.attack);
  if (res.linesCleared > 0) {
    vibrate(res.linesCleared >= 4 ? [30, 40, 30] : 25);
    audio.sfxClear(res.linesCleared);
    showBanner(labelOf(res));
  }
  audio.sfxLock();   // 「ドスン」。振動が効かない端末でも手ごたえが伝わるように
  if (g.incomingTotal === 0) hide('warn');
  lastCountShown = -1;
  drawGauge();
  if (res.topOut || !g.alive) {
    if (state.solo) { finishSolo(); return; }
    net?.sendState(g.snapshot());
    net?.sendDead();
  }
}

function labelOf(res: { kind: string; ren: number; perfectClear: boolean }): string {
  if (res.perfectClear) return 'パーフェクトクリア！';
  const names: Record<string, string> = {
    single: 'シングル', double: 'ダブル', triple: 'トリプル', tetris: 'テトリス！',
    'tspin-mini': 'T-Spin ミニ', 'tspin-single': 'T-Spin シングル',
    'tspin-double': 'T-Spin ダブル', 'tspin-triple': 'T-Spin トリプル',
  };
  const base = names[res.kind] || '';
  return res.ren >= 2 ? `${base}  ${res.ren} REN` : base;
}

let bannerTimer: any = null;
function showBanner(text: string) {
  if (!text) return;
  const b = $('banner');
  b.textContent = text;
  show('banner');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => hide('banner'), 900);
}

// ---------------------------------------------------------------- 各部の描画

function drawAll() {
  const g = state.game;
  if (!g) return;
  const ctx = boardCanvas.getContext('2d')!;
  paintBoard(ctx, g.renderBoard(true), cellSize);
  $('g-lines').textContent = `${g.linesCleared} ライン`;
  if (state.solo) drawSoloHud();
  drawNext();
  drawGauge();
}

/** これから出てくるミノ5個 */
function drawNext() {
  const g = state.game!;
  const nc = fitCanvas(nextCanvas, 60, 170);
  nc.clearRect(0, 0, 60, 170);
  g.nextPieces.slice(0, 5).forEach((t, i) => paintPiece(nc, t, 30, 17 + i * 34, 9));
}

function drawGauge() {
  const g = state.game;
  if (!g) return;
  const total = Math.min(g.incomingTotal, 20);
  const urgent = (g.incomingTimerMs ?? 9999) <= 1500;
  const el = $('gauge');
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = 'gauge-cell' + (total >= 4 ? ' hot' : '') + (urgent ? ' urgent' : '');
    el.append(d);
  }
}

// ---------------------------------------------------------------- おじゃまカウントダウン

/** 直前に表示した秒数。同じ秒のあいだは音を鳴らし直さないための目印。 */
let lastCountShown = -1;

function drawWarning() {
  const g = state.game;
  if (!g) return;
  const ms = g.incomingTimerMs;

  if (ms === null) {
    if (lastCountShown !== -1) { hide('warn'); lastCountShown = -1; }
    return;
  }

  const left = Math.max(1, Math.ceil(ms / 1000));
  const urgent = ms <= 1500;
  const el = $('warn');
  el.classList.toggle('urgent', urgent);
  show('warn');
  $('warn-lines').textContent = `${g.incomingTotal}段`;

  if (left === lastCountShown) return;
  lastCountShown = left;

  // 数字を作り直すことで、拡大アニメーションを毎秒やり直させる
  const num = $('warn-num');
  const fresh = num.cloneNode(false) as HTMLElement;
  fresh.textContent = String(left);
  num.replaceWith(fresh);

  audio.sfxTick(left);
  vibrate(urgent ? 45 : 15);
}

/** せり上がった瞬間に盤面を揺らす */
function shakeBoard() {
  const w = document.querySelector('.board-wrap') as HTMLElement | null;
  if (!w) return;
  w.classList.remove('shake');
  void w.offsetWidth; // アニメーションを確実にやり直させる
  w.classList.add('shake');
  setTimeout(() => w.classList.remove('shake'), 400);
}

/**
 * 積み上がったブロックが画面のどこまで来ているか（0＝空、1＝天井）。
 * この数字だけでBGMのテンポの段が決まる。
 * 半分で一段、8割でもう一段、9割でいちばん速くなる（決めているのは tune.ts）。
 *
 * 数えるのは、置き終わって固まったブロックだけ。
 * 落ちてきている最中のミノは、上のほうにあってもテンポには影響しない。
 */
function dangerLevel(): number {
  return state.game?.stackHeight() ?? 0;
}

/** 相手の小さな盤面。人数ぶん作って右側に縦に並べる。 */
let peerViews: { id: number; canvas: HTMLCanvasElement; el: HTMLElement }[] = [];

/** 相手の枠を作り直す（顔ぶれが変わったときだけ） */
function renderPeers() {
  const others = state.players.filter((p) => p.id !== state.meId);
  const same = others.length === peerViews.length
    && others.every((p, i) => peerViews[i].id === p.id);
  if (!same) {
    const box = $('peers');
    box.innerHTML = '';
    peerViews = [];
    for (const p of others) {
      const el = document.createElement('div');
      el.className = 'peer';
      const cv = document.createElement('canvas');
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = p.name;
      el.append(cv, nm);
      box.append(el);
      peerViews.push({ id: p.id, canvas: cv, el });
    }
  } else {
    others.forEach((p, i) => {
      const nm = peerViews[i].el.querySelector('.nm');
      if (nm) nm.textContent = p.name;
    });
  }
  $('box-peer').classList.toggle('hidden', others.length === 0);
  drawPeers();
}

function drawPeers() {
  if (peerViews.length === 0) return;
  const box = $('peers');
  // 枠の高さを人数で割って、はみ出さない大きさを決める（名前のぶん14px引く）
  const availH = Math.max(40, box.clientHeight);
  const availW = Math.max(20, box.clientWidth);
  const perH = Math.max(20, Math.floor(availH / peerViews.length) - 14);
  const cs = Math.max(2, Math.floor(Math.min(availW / COLS, perH / ROWS)));
  const w = COLS * cs + 2, h = ROWS * cs + 2;

  for (const v of peerViews) {
    const info = state.players.find((p) => p.id === v.id);
    v.el.classList.toggle('out', !!info && !info.alive);
    v.el.classList.toggle('aim', state.aimTo === v.id);
    v.el.classList.toggle('danger', state.aimedBy === v.id);

    const ctx = fitCanvas(v.canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0e1526';
    ctx.fillRect(0, 0, w, h);
    const snap = state.snaps[v.id];
    if (!snap) continue;
    const sz = Math.max(1, cs - 1);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const val = snap.board[y]?.[x] ?? 0;
        if (val <= 0) continue;
        ctx.fillStyle = COLORS[val] ?? '#888';
        ctx.fillRect(1 + x * cs, 1 + y * cs, sz, sz);
      }
    }
  }
}

// ---------------------------------------------------------------- 操作

type Act = 'left' | 'right' | 'down' | 'cw' | 'ccw' | 'hold' | 'drop';

const DAS = 150, ARR = 45;

function doAct(a: Act) {
  const g = state.game;
  if (!g || state.phase !== 'play' || !g.alive) return;
  switch (a) {
    case 'left': g.move(-1); break;
    case 'right': g.move(1); break;
    case 'down': g.softDrop(); break;
    case 'cw': g.rotate(1); break;
    case 'ccw': g.rotate(-1); break;
    case 'hold': g.holdPiece(); break;
    case 'drop': { vibrate(12); onLock(g.hardDrop()); break; }
  }
}

const REPEATING: Act[] = ['left', 'right', 'down'];

document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
  const act = btn.dataset.act as Act;
  let dasTimer: any = null, arrTimer: any = null;

  const stop = () => {
    clearTimeout(dasTimer); clearInterval(arrTimer);
    dasTimer = arrTimer = null;
    if (act === 'down') state.softDrop = false;
  };

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    doAct(act);
    if (act === 'down') state.softDrop = true;
    if (REPEATING.includes(act)) {
      dasTimer = setTimeout(() => { arrTimer = setInterval(() => doAct(act), ARR); }, DAS);
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    btn.addEventListener(ev, stop)
  );
});

// パソコンのキーボードでも遊べるようにしておく（動作確認用）
const KEYMAP: Record<string, Act> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down',
  ArrowUp: 'cw', KeyZ: 'ccw', KeyX: 'cw', Space: 'drop',
};
const heldKeys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const a = KEYMAP[e.code];
  if (!a) return;
  e.preventDefault();
  if (heldKeys.has(e.code) && !REPEATING.includes(a)) return;
  heldKeys.add(e.code);
  if (a === 'down') state.softDrop = true;
  doAct(a);
});
window.addEventListener('keyup', (e) => {
  heldKeys.delete(e.code);
  if (KEYMAP[e.code] === 'down') state.softDrop = false;
});

// ---------------------------------------------------------------- ホーム画面の操作

const nameInput = $('name') as HTMLInputElement;
const codeInput = $('code') as HTMLInputElement;
const serverInput = $('server') as HTMLInputElement;

nameInput.value = state.name;
serverInput.value = serverUrl();

/** 入力欄の名前を取り込む（入力中でも押した瞬間の値を使う） */
function syncName() {
  state.name = nameInput.value.trim().slice(0, 12);
  localStorage.setItem('name', state.name);
  return state.name;
}
nameInput.addEventListener('input', syncName);
// 名前をタップしたら中身をぜんぶ選ぶ。そのまま打てば丸ごと書き換えられる。
nameInput.addEventListener('focus', () => setTimeout(() => nameInput.select(), 0));
// Enter（完了）でキーボードを閉じる
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
});
$('btn-name-clear').addEventListener('click', () => {
  nameInput.value = '';
  syncName();
  nameInput.focus();
});

// 部屋コードは数字4桁。打った字がそのまま残るよう、数字以外が混ざったときだけ書き戻す。
codeInput.addEventListener('input', () => {
  const cleaned = codeInput.value.replace(/\D/g, '').slice(0, 4);
  if (cleaned !== codeInput.value) codeInput.value = cleaned;
});
codeInput.addEventListener('focus', () => setTimeout(() => codeInput.select(), 0));
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); codeInput.blur(); joinRoom(); }
});
serverInput.addEventListener('change', () => {
  const v = serverInput.value.trim();
  if (v) localStorage.setItem('serverUrl', v);
  else localStorage.removeItem('serverUrl');
  net?.close(); net = null;
  ensureNet();
});

$('btn-settings').addEventListener('click', () => $('settings').classList.toggle('hidden'));

// ゲーム中に最初の画面へ戻る（画面の左上）
$('btn-menu').addEventListener('click', (e) => { e.stopPropagation(); askMenu(); });

// 音のオン・オフ
const soundBtn = $('btn-sound');
function renderSoundBtn() {
  soundBtn.textContent = audio.isEnabled() ? '音 オン' : '音 オフ';
}
renderSoundBtn();
soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  audio.toggle();
  renderSoundBtn();
});

// ホーム画面の「音を鳴らしてみる」。対戦前にお互いの端末で音を確かめられる。
$('btn-sound-home').addEventListener('click', () => {
  audio.test();
  renderSoundBtn();
  setTimeout(() => {
    $('sound-hint').textContent = audio.status() === 'ok'
      ? '音は出せる状態です。聞こえなければ端末の音量を上げてください。'
      : '音を出す準備ができませんでした。もう一度押してみてください。';
  }, 400);
});

$('btn-create').addEventListener('click', () => {
  audio.unlock();
  const me = syncName() || 'プレイヤー';
  const n = ensureNet();
  waitConnected(() => n.createRoom(me));
});

$('btn-solo').addEventListener('click', () => {
  audio.unlock();
  syncName();
  startSolo();
});

function joinRoom() {
  audio.unlock();
  const code = codeInput.value.replace(/\D/g, '');
  if (code.length !== 4) { setStatus('error', '数字4桁のコードを入れてください'); return; }
  const me = syncName() || 'プレイヤー';
  const n = ensureNet();
  waitConnected(() => n.joinRoom(code, me));
}
$('btn-join').addEventListener('click', joinRoom);

// 部屋主だけが押せる。全員そろったらここから始まる。
$('btn-begin').addEventListener('click', () => {
  audio.unlock();
  net?.begin();
  const btn = $('btn-begin') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'はじめます…';
});

$('btn-leave').addEventListener('click', () => {
  net?.leave();
  state.code = ''; state.players = []; state.meId = 0;
  goHome();
});

/** 接続が済むまで待ってから実行する（無料サーバーの寝起きに対応） */
function waitConnected(fn: () => void, tries = 0) {
  const n = net;
  if (!n) return;
  if ((n as any).ws?.readyState === 1) { fn(); return; }
  if (tries > 120) { setStatus('error', 'サーバーに接続できませんでした'); return; }
  setTimeout(() => waitConnected(fn, tries + 1), 500);
}

// ---------------------------------------------------------------- 起動

window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 200));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { audio.stopMusic(); return; }
  if (state.phase === 'play') {
    lastFrame = performance.now();
    keepAwake(true);
    audio.startMusic();
  }
});
// ---------------------------------------------------------------- 画面を固定する
// 遊んでいる最中に画面が拡大されてしまうのを止める。
// iPhone は「拡大禁止」の指定（viewport の user-scalable=no）を無視するので、
// 拡大しようとする動きそのものを、ここで全部つかまえて打ち消している。

// 二本指を広げる動き（iPhone 独自の合図）
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// 二本以上の指で画面をなぞったとき（ピンチ）
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// 素早く二回たたく拡大。ただし入力欄では文字が打てなくなるので、そこだけ見逃す。
let lastTapAt = 0;
document.addEventListener('touchend', (e) => {
  const el = e.target as HTMLElement | null;
  const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const now = Date.now();
  if (!typing && now - lastTapAt < 350) e.preventDefault();
  lastTapAt = now;
}, { passive: false });

// どこを触っても音の許可を取り直す。ボタンを1回押しただけでは
// 許可が下りない端末があるため、遊んでいるうちに必ず通るようにしておく。
document.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
document.addEventListener('touchstart', () => audio.unlock(), { passive: true });

goHome();
ensureNet();
