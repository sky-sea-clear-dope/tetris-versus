// 対戦サーバー: 部屋コードで2人をマッチングし、盤面とおじゃまを中継する。
// Render / Railway / Fly.io などにそのままデプロイできる。

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(I,O,0,1)は除外

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
    this.createdAt = Date.now();
  }

  broadcast(msg, except) {
    for (const p of this.players) {
      if (p !== except) p.send(msg);
    }
  }

  opponentOf(player) {
    return this.players.find((p) => p !== player) || null;
  }

  maybeStart() {
    if (this.players.length === 2 && this.players.every((p) => p.ready) && !this.started) {
      this.started = true;
      this.seed = (Math.random() * 0x7fffffff) | 0;
      for (const p of this.players) {
        p.alive = true;
        p.ready = false;
      }
      this.broadcast({ t: 'start', seed: this.seed, at: Date.now() + 3000 });
    }
  }

  /** どちらかが倒れたら決着 */
  reportDead(player) {
    if (!this.started) return;
    player.alive = false;
    const winner = this.opponentOf(player);
    this.started = false;
    player.send({ t: 'result', win: false });
    if (winner) winner.send({ t: 'result', win: true });
  }
}

class Player {
  constructor(ws, name) {
    this.ws = ws;
    this.name = (name || 'プレイヤー').slice(0, 12);
    this.room = null;
    this.ready = false;
    this.alive = true;
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
    room.players = room.players.filter((p) => p !== this);
    this.room = null;
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      room.started = false;
      room.broadcast({ t: 'peerLeft' });
    }
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
      room.players.push(player);
      player.room = room;
      player.send({ t: 'room', code: room.code, host: true, you: player.name });
      break;
    }

    // --- 部屋に入る ---
    case 'join': {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return player.send({ t: 'error', msg: 'その部屋コードは見つかりません' });
      if (room.players.length >= 2) return player.send({ t: 'error', msg: 'その部屋は満員です' });

      player.leaveRoom();
      player.name = (msg.name || player.name).slice(0, 12);
      room.players.push(player);
      player.room = room;

      player.send({ t: 'room', code: room.code, host: false, you: player.name });
      for (const p of room.players) {
        const other = room.opponentOf(p);
        p.send({ t: 'peer', name: other ? other.name : null });
      }
      break;
    }

    // --- 準備完了 ---
    case 'ready': {
      if (!player.room) return;
      player.ready = true;
      const opp = player.room.opponentOf(player);
      if (opp) opp.send({ t: 'peerReady' });
      player.room.maybeStart();
      break;
    }

    // --- 自分の盤面を相手に見せる ---
    case 'state': {
      const opp = player.room?.opponentOf(player);
      if (opp) opp.send({ t: 'state', s: msg.s });
      break;
    }

    // --- おじゃまブロックを送る ---
    case 'attack': {
      const lines = Math.max(0, Math.min(20, Number(msg.lines) || 0));
      if (lines === 0) return;
      const opp = player.room?.opponentOf(player);
      if (opp) opp.send({ t: 'attack', lines });
      break;
    }

    // --- 倒れた ---
    case 'dead': {
      player.room?.reportDead(player);
      break;
    }

    // --- もう一戦 ---
    case 'rematch': {
      if (!player.room) return;
      player.ready = true;
      const opp = player.room.opponentOf(player);
      if (opp) opp.send({ t: 'peerRematch' });
      player.room.maybeStart();
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
  console.log(`対戦サーバー起動: ポート ${PORT}`);
});
