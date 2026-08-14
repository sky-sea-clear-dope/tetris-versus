// 対戦サーバー: 部屋コードで最大4人をマッチングし、盤面とおじゃまを中継する。
// Render / Railway / Fly.io などにそのままデプロイできる。

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { scaleGarbage } from './garbage.js';

const PORT = process.env.PORT || 8080;

/** 1部屋の定員 */
const MAX_PLAYERS = 4;

/** @type {Map<string, Room>} */
const rooms = new Map();

// 部屋コードは数字だけ。スマホで数字キーパッドが出るので打ち間違いが起きにくく、
// 口で友達に伝えるのも楽（アルファベットだとiPhoneの自動大文字化で入力が乱れた）。
const CODE_CHARS = '0123456789';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {Player[]} */
    this.players = [];
    this.seed = 0;
    this.started = false;
    /** 部屋のなかだけで通じる番号を配るためのカウンタ */
    this.nextId = 1;
    /** 倒れた順（先に倒れた人ほど前） */
    this.deadOrder = [];
    this.createdAt = Date.now();
  }

  broadcast(msg, except) {
    for (const p of this.players) {
      if (p !== except) p.send(msg);
    }
  }

  /** 部屋主＝いちばん最初からいる人 */
  host() {
    return this.players[0] || null;
  }

  living() {
    return this.players.filter((p) => p.alive);
  }

  opponentOf(player) {
    return this.players.find((p) => p !== player) || null;
  }

  /** 全員に配る参加者一覧 */
  sendRoster() {
    const list = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      host: p === this.players[0],
      alive: p.alive,
    }));
    for (const p of this.players) {
      p.send({ t: 'players', list, started: this.started, you: p.id });
    }
    // 昔のアプリ（1対1しか知らない版）のための言い換え。
    // 新しいアプリは players だけを見るので、これは無視される。
    if (this.players.length === 2) {
      for (const p of this.players) {
        const other = this.opponentOf(p);
        p.send({ t: 'peer', name: other ? other.name : null });
      }
    }
  }

  /** 対戦を始める。2人以上そろっていれば何人でも始められる。 */
  begin() {
    if (this.started || this.players.length < 2) return false;
    this.started = true;
    this.deadOrder = [];
    this.seed = (Math.random() * 0x7fffffff) | 0;
    for (const p of this.players) {
      p.alive = true;
      p.ready = false;
      p.lastAttackedBy = 0;
    }
    this.sendRoster();
    this.broadcast({ t: 'start', seed: this.seed, at: Date.now() + 3000 });
    return true;
  }

  /** 昔のアプリ用。2人そろって両方が「準備完了」を押したときだけ動く。 */
  maybeStart() {
    if (this.players.length === 2 && this.players.every((p) => p.ready)) this.begin();
  }

  /**
   * おじゃまの送り先を決める。
   * 自分を最後に殴った相手が生きていれば、その人に返す（しかえし）。
   * いなければ、生きている相手から適当にひとり選ぶ。
   */
  targetFor(player) {
    const others = this.players.filter((p) => p.alive && p !== player);
    if (others.length === 0) return null;
    const revenge = others.find((p) => p.id === player.lastAttackedBy);
    if (revenge) return revenge;
    return others[Math.floor(Math.random() * others.length)];
  }

  /** 人数に応じておじゃまの段数を減らす */
  scaleLines(lines) {
    return scaleGarbage(lines, this.living().length);
  }

  /** ひとり脱落。最後の1人になったら決着。 */
  reportDead(player) {
    if (!this.started || !player.alive) return;
    player.alive = false;
    if (!this.deadOrder.includes(player)) this.deadOrder.push(player);
    // 倒れた人をしかえし相手にしていた人は、狙いを白紙に戻す
    for (const p of this.players) {
      if (p.lastAttackedBy === player.id) p.lastAttackedBy = 0;
    }
    const alive = this.living();
    this.broadcast({ t: 'out', id: player.id, left: alive.length });
    this.sendRoster();
    if (alive.length <= 1) this.endMatch();
  }

  /** 決着。全員に順位を配ってロビーに戻れる状態にする。 */
  endMatch() {
    if (!this.started) return;
    this.started = false;
    const winner = this.living()[0] || null;
    // 遅くまで残った人ほど上の順位
    const later = [...this.deadOrder].reverse();
    const total = this.players.length;
    for (const p of this.players) {
      let rank;
      if (winner && p === winner) rank = 1;
      else {
        const i = later.indexOf(p);
        rank = i >= 0 ? i + (winner ? 2 : 1) : total;
      }
      p.send({ t: 'result', win: winner === p, rank, total });
    }
    for (const p of this.players) p.alive = true;
    this.deadOrder = [];
    this.sendRoster();
  }
}

class Player {
  constructor(ws, name) {
    this.ws = ws;
    this.id = 0;
    this.name = (name || 'プレイヤー').slice(0, 12);
    this.room = null;
    this.ready = false;
    this.alive = true;
    /** 自分を最後に殴った相手の番号（0＝まだ誰にもやられていない） */
    this.lastAttackedBy = 0;
    this.lastSeen = Date.now();
  }

  send(obj) {
    if (this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        /* 送信失敗は無視（切断検知に任せる） */
      }
    }
  }

  leaveRoom() {
    const room = this.room;
    if (!room) return;
    this.room = null;
    const wasStarted = room.started;
    room.players = room.players.filter((p) => p !== this);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    room.broadcast({ t: 'peerLeft', id: this.id });
    if (wasStarted) {
      // 対戦中に抜けた人は脱落あつかい
      this.alive = false;
      for (const p of room.players) {
        if (p.lastAttackedBy === this.id) p.lastAttackedBy = 0;
      }
      if (room.living().length <= 1) room.endMatch();
    }
    room.sendRoster();
  }
}

// ---------- HTTP（ヘルスチェック用） ----------

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const player = new Player(ws, null);
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
    player.lastSeen = Date.now();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    player.lastSeen = Date.now();
    handle(player, msg);
  });

  ws.on('close', () => player.leaveRoom());
  ws.on('error', () => player.leaveRoom());

  player.send({ t: 'hello' });
});

function handle(player, msg) {
  switch (msg.t) {
    // --- 部屋を作る ---
    case 'create': {
      player.leaveRoom();
      player.name = (msg.name || player.name).slice(0, 12);
      const room = new Room(makeCode());
      rooms.set(room.code, room);
      player.id = room.nextId++;
      player.alive = true;
      player.lastAttackedBy = 0;
      room.players.push(player);
      player.room = room;
      player.send({ t: 'room', code: room.code, host: true, you: player.name, id: player.id });
      room.sendRoster();
      break;
    }

    // --- 部屋に入る ---
    case 'join': {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return player.send({ t: 'error', msg: 'その部屋コードは見つかりません' });
      if (room.players.length >= MAX_PLAYERS) {
        return player.send({ t: 'error', msg: 'その部屋は満員です（4人まで）' });
      }
      if (room.started) {
        return player.send({ t: 'error', msg: 'いま対戦中です。終わるまで待ってください' });
      }

      player.leaveRoom();
      player.name = (msg.name || player.name).slice(0, 12);
      player.id = room.nextId++;
      player.alive = true;
      player.lastAttackedBy = 0;
      room.players.push(player);
      player.room = room;

      player.send({ t: 'room', code: room.code, host: false, you: player.name, id: player.id });
      room.sendRoster();
      break;
    }

    // --- 部屋主が対戦を始める ---
    case 'begin': {
      const room = player.room;
      if (!room) return;
      if (room.host() !== player) {
        return player.send({ t: 'error', msg: '部屋を作った人だけが始められます' });
      }
      if (room.players.length < 2) {
        return player.send({ t: 'error', msg: 'あと1人以上そろってから始めてください' });
      }
      room.begin();
      break;
    }

    // --- 準備完了（昔のアプリ用。2人のときだけ効く） ---
    case 'ready':
    case 'rematch': {
      if (!player.room) return;
      player.ready = true;
      const opp = player.room.opponentOf(player);
      if (opp) opp.send({ t: msg.t === 'rematch' ? 'peerRematch' : 'peerReady' });
      player.room.maybeStart();
      break;
    }

    // --- 自分の盤面をみんなに見せる ---
    case 'state': {
      const room = player.room;
      if (!room) return;
      room.broadcast({ t: 'state', from: player.id, s: msg.s }, player);
      break;
    }

    // --- おじゃまブロックを送る ---
    case 'attack': {
      const room = player.room;
      if (!room) return;
      const raw = Math.max(0, Math.min(20, Number(msg.lines) || 0));
      if (raw === 0) return;
      const target = room.targetFor(player);
      if (!target) return;
      const lines = room.scaleLines(raw);
      target.lastAttackedBy = player.id;
      target.send({ t: 'attack', from: player.id, lines });
      room.broadcast({ t: 'hit', from: player.id, to: target.id, lines });
      break;
    }

    // --- 倒れた ---
    case 'dead': {
      player.room?.reportDead(player);
      break;
    }

    case 'leave': {
      player.leaveRoom();
      break;
    }

    case 'ping': {
      player.send({ t: 'pong', ts: msg.ts });
      break;
    }
  }
}

// ---------- 切断検知 & 掃除 ----------

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }
}, 15000);

// 1時間以上放置された空き部屋を掃除
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 && now - room.createdAt > 3600_000) rooms.delete(code);
  }
}, 300_000);

server.listen(PORT, () => {
  console.log(`対戦サーバー起動: ポート ${PORT}（1部屋 最大${MAX_PLAYERS}人）`);
});
