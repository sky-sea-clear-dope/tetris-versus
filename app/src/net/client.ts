// 対戦サーバーとのやりとり。切断時は自動で再接続を試みる。

import type { Snapshot } from '../engine/engine';

export type NetStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** 部屋にいる人ひとりぶんの情報 */
export interface PlayerInfo {
  /** 部屋のなかだけで通じる番号 */
  id: number;
  name: string;
  /** 部屋を作った人か */
  host: boolean;
  /** まだ倒れていないか */
  alive: boolean;
}

export interface NetHandlers {
  onStatus?: (status: NetStatus, detail?: string) => void;
  onRoom?: (code: string, host: boolean, id?: number) => void;
  /** 部屋の顔ぶれが変わったとき（入室・退室・脱落） */
  onPlayers?: (list: PlayerInfo[], started: boolean, you: number) => void;
  onPeer?: (name: string | null) => void;
  onPeerLeft?: () => void;
  onPeerReady?: () => void;
  onStart?: (seed: number, at: number) => void;
  onState?: (snapshot: Snapshot, from?: number) => void;
  onAttack?: (lines: number, from?: number) => void;
  /** 誰が誰におじゃまを送ったか（全員に届く） */
  onHit?: (from: number, to: number, lines: number) => void;
  /** 誰かが脱落した。left は残っている人数。 */
  onOut?: (id: number, left: number) => void;
  onResult?: (win: boolean, rank?: number, total?: number) => void;
  onError?: (msg: string) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: NetHandlers;
  private closedByUser = false;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string, handlers: NetHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  /** 画面が切り替わったときにハンドラを差し替える（未指定のものは元のまま残す） */
  setHandlers(next: NetHandlers) {
    this.handlers = { ...this.handlers, ...next };
  }

  connect() {
    this.closedByUser = false;
    this.handlers.onStatus?.('connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.handlers.onStatus?.('error', String(e));
      return;
    }

    this.ws.onopen = () => {
      this.retry = 0;
      this.handlers.onStatus?.('connected');
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 20000);
    };

    this.ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    this.ws.onerror = () => {
      this.handlers.onStatus?.('error', 'サーバーに接続できません');
    };

    this.ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closedByUser) return;
      this.handlers.onStatus?.('error', '接続が切れました。再接続中…');
      this.retry++;
      const delay = Math.min(1000 * this.retry, 8000);
      setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
    };
  }

  private dispatch(msg: any) {
    switch (msg.t) {
      case 'room': this.handlers.onRoom?.(msg.code, !!msg.host, msg.id ?? 0); break;
      case 'players': this.handlers.onPlayers?.(msg.list ?? [], !!msg.started, msg.you ?? 0); break;
      case 'peer': this.handlers.onPeer?.(msg.name ?? null); break;
      case 'peerLeft': this.handlers.onPeerLeft?.(); break;
      case 'peerReady':
      case 'peerRematch': this.handlers.onPeerReady?.(); break;
      case 'start': this.handlers.onStart?.(msg.seed, msg.at); break;
      case 'state': this.handlers.onState?.(msg.s, msg.from ?? 0); break;
      case 'attack': this.handlers.onAttack?.(msg.lines, msg.from ?? 0); break;
      case 'hit': this.handlers.onHit?.(msg.from ?? 0, msg.to ?? 0, msg.lines ?? 0); break;
      case 'out': this.handlers.onOut?.(msg.id ?? 0, msg.left ?? 0); break;
      case 'result': this.handlers.onResult?.(!!msg.win, msg.rank, msg.total); break;
      case 'error': this.handlers.onError?.(msg.msg); break;
    }
  }

  private send(obj: any) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  createRoom(name: string) { this.send({ t: 'create', name }); }
  joinRoom(code: string, name: string) { this.send({ t: 'join', code, name }); }
  ready() { this.send({ t: 'ready' }); }
  rematch() { this.send({ t: 'rematch' }); }
  /** 部屋主が対戦を始める */
  begin() { this.send({ t: 'begin' }); }
  sendState(s: Snapshot) { this.send({ t: 'state', s }); }
  sendAttack(lines: number) { if (lines > 0) this.send({ t: 'attack', lines }); }
  sendDead() { this.send({ t: 'dead' }); }
  leave() { this.send({ t: 'leave' }); }

  close() {
    this.closedByUser = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}
