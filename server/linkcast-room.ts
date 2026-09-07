import { DurableObject } from 'cloudflare:workers';

type Peer = { id: string; role: 'host' | 'viewer'; seen: number; removed?: boolean };
const LEASE_MS = 120_000;

export class LinkcastRoom extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private peers() {
    return this.ctx.getWebSockets().filter(ws => !this.peer(ws).removed);
  }
  private peer(ws: WebSocket): Peer { return ws.deserializeAttachment() as Peer; }
  private send(ws: WebSocket, data: unknown) {
    try { ws.send(JSON.stringify(data)); } catch { /* close handler reclaims the slot */ }
  }
  private signal(ws: WebSocket, senderId: string, kind: string, payload: unknown = {}) {
    this.send(ws, { type: 'signal', senderId, kind, payload: JSON.stringify(payload), id: 0 });
  }
  private remove(ws: WebSocket) {
    const peer = this.peer(ws);
    if (peer.removed) return;
    ws.serializeAttachment({ ...peer, removed: true });
    try { ws.close(1000, 'Disconnected'); } catch { /* already closed */ }
    if (peer.role === 'viewer') for (const host of this.peers().filter(s => this.peer(s).role === 'host')) this.signal(host, peer.id, 'leave');
  }
  private async sweep() {
    for (const ws of this.peers()) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
      if (Date.now() - Math.max(lastPing, this.peer(ws).seen) > LEASE_MS) {
        const peer = this.peer(ws);
        if (peer.role === 'host') {
          for (const viewer of this.peers().filter((candidate) => this.peer(candidate).role === 'viewer')) {
            this.signal(viewer, peer.id, 'host_lost');
          }
          await this.ctx.storage.put('hostGone', Date.now());
        }
        this.remove(ws);
      }
    }
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('peerId') || '';
    const role = url.searchParams.get('role');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(id) || (role !== 'host' && role !== 'viewer')) return new Response('Invalid peer', { status: 400 });
    // Serialize admission, including storage awaits, to enforce the five-viewer limit.
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.sweep();
      const hostId = await this.ctx.storage.get<string>('host');
      let error = '';
      if (role === 'host' && hostId && hostId !== id) error = 'room_forbidden';
      if (role === 'viewer' && !this.peers().some(ws => this.peer(ws).role === 'host')) error = 'room_offline';
      const existing = this.peers().find(ws => this.peer(ws).id === id);
      if (role === 'viewer' && !existing && this.peers().filter(ws => this.peer(ws).role === 'viewer').length >= 5) error = 'room_full';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (error) {
        server.accept();
        this.send(server, { type: 'error', error });
        server.close(1008, error);
        return new Response(null, { status: 101, webSocket: client });
      }
      const reconnectingHost = role === 'host' && hostId === id;
      if (role === 'host' && !hostId) await this.ctx.storage.put('host', id);
      if (role === 'host') await this.ctx.storage.delete('hostGone');
      if (existing) this.remove(existing);
      server.serializeAttachment({ id, role, seen: Date.now() } satisfies Peer);
      this.ctx.acceptWebSocket(server);
      this.send(server, { type: 'ready', hostId: role === 'host' ? id : hostId });
      if (role === 'viewer') {
        for (const host of this.peers().filter(ws => this.peer(ws).role === 'host')) this.signal(host, id, 'join');
      } else if (reconnectingHost) {
        for (const viewer of this.peers().filter((ws) => this.peer(ws).role === 'viewer')) this.signal(viewer, id, 'host_restart');
      }
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + LEASE_MS);
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (this.peer(ws).removed || typeof message !== 'string' || message.length > 120_000) return;
    const peer = this.peer(ws);
    ws.serializeAttachment({ ...peer, seen: Date.now() });
    try {
      const data = JSON.parse(message);
      if (data.type === 'leave') {
        if (peer.role === 'host') {
          for (const other of this.peers()) {
            if (this.peer(other).role === 'viewer') this.signal(other, peer.id, 'room_closed');
            this.remove(other);
          }
          await this.ctx.storage.deleteAll();
        } else this.remove(ws);
        return;
      }
      if (!['offer', 'answer', 'candidate', 'join'].includes(data.kind)) return;
      for (const target of this.peers()) {
        if (this.peer(target).id !== data.recipientId || this.peer(target).role === peer.role) continue;
        if ((data.kind === 'offer' && peer.role !== 'host') || (['answer', 'join'].includes(data.kind) && peer.role !== 'viewer')) return;
        this.signal(target, peer.id, data.kind, data.payload);
      }
    } catch { /* Invalid messages cannot change room membership. */ }
  }
  async webSocketClose(ws: WebSocket) {
    const peer = this.peer(ws);
    if (peer.removed) return;
    if (peer.role === 'host') {
      for (const viewer of this.peers().filter((candidate) => this.peer(candidate).role === 'viewer')) {
        this.signal(viewer, peer.id, 'host_lost');
      }
    }
    this.remove(ws);
    if (peer.role === 'host') {
      await this.ctx.storage.put('hostGone', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + LEASE_MS);
    }
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }
  async alarm() {
    await this.sweep();
    if (!this.peers().some(ws => this.peer(ws).role === 'host')) {
      const gone = await this.ctx.storage.get<number>('hostGone');
      if (gone && Date.now() - gone < LEASE_MS) {
        await this.ctx.storage.setAlarm(gone + LEASE_MS);
        return;
      }
      const host = await this.ctx.storage.get<string>('host');
      for (const ws of this.peers()) { this.signal(ws, host || '', 'room_closed'); this.remove(ws); }
      await this.ctx.storage.deleteAll();
    } else await this.ctx.storage.setAlarm(Date.now() + LEASE_MS);
  }
}
