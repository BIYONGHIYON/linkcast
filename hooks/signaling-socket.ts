export type SocketSignal = { id: number; senderId: string; kind: 'join' | 'leave' | 'offer' | 'answer' | 'candidate' | 'host_lost' | 'host_restart' | 'room_closed'; payload: string };

export class SignalingSocket {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private generation = 0;
  private attempts = 0;
  private lastPong = 0;
  private pending: SocketSignal[] = [];
  private listener: ((signal: SocketSignal) => void) | null = null;
  private session: { roomId: string; peerId: string; role: string } | null = null;
  private hostId = '';
  private connecting: Promise<{ hostId: string }> | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  subscribe(listener: (signal: SocketSignal) => void) {
    this.listener = listener;
    for (const signal of this.pending.splice(0)) listener(signal);
  }
  private emit(signal: SocketSignal) {
    if (this.listener) this.listener(signal);
    else if (this.pending.length < 256) this.pending.push(signal);
  }
  private connect(): Promise<{ hostId: string }> {
    if (this.connecting) return this.connecting;
    const operation = this.openSocket();
    this.connecting = operation;
    void operation.finally(() => {
      if (this.connecting === operation) this.connecting = null;
    }).catch(() => undefined);
    return operation;
  }
  private reconnect() {
    if (this.stopped || !this.session || this.timer) return;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect().catch(error => {
        if (['room_forbidden', 'room_full'].includes(error.name)) return;
        this.reconnect();
      });
    }, Math.min(400 * 2 ** Math.min(this.attempts++, 6), 15000) + Math.random() * 200);
  }
  private openSocket(): Promise<{ hostId: string }> {
    const session = this.session!;
    const generation = ++this.generation;
    const url = new URL('/api/socket', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    Object.entries(session).forEach(([key, value]) => url.searchParams.set(key, value));
    const ws = new WebSocket(url);
    this.socket = ws;
    return new Promise((resolve, reject) => {
      let ready = false;
      let terminal = false;
      const timeout = setTimeout(() => { reject(new Error('connection_timeout')); ws.close(); }, 8000);
      ws.onmessage = event => {
        if (generation !== this.generation || this.stopped) return;
        if (event.data === 'pong') { this.lastPong = Date.now(); return; }
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready') {
            clearTimeout(timeout);
            ready = true;
            this.hostId = message.hostId;
            this.attempts = 0;
            this.lastPong = Date.now();
            this.onStatus?.(true);
            if (this.heartbeat) clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (Date.now() - this.lastPong > 90000) { ws.close(); return; }
              if (ws.readyState === WebSocket.OPEN) ws.send('ping');
            }, 30000);
            resolve({ hostId: this.hostId });
          } else if (message.type === 'error') {
            clearTimeout(timeout);
            terminal = true;
            const error = new Error(message.error); error.name = message.error;
            reject(error);
          } else if (message.type === 'signal') {
            this.emit(message);
            if ((message.kind === 'room_closed' || message.kind === 'leave') && session.role === 'viewer' && message.senderId === this.hostId) {
              this.stopped = true;
              if (this.heartbeat) clearInterval(this.heartbeat);
              ws.close();
            }
          }
        } catch { /* Ignore malformed server messages. */ }
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error('socket_closed'));
        if (generation !== this.generation || this.stopped) return;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.onStatus?.(false);
        if (ready && !terminal) this.reconnect();
      };
      ws.onerror = () => ws.close();
    });
  }
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    if (path === '/api/signals') {
      if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('socket_not_ready');
      this.socket.send(JSON.stringify(body));
      return {} as T;
    }
    if (init?.method === 'PATCH') { this.resume(); return { active: true } as T; }
    if (init?.method === 'DELETE') { this.close(); return {} as T; }
    if (this.session?.peerId === body.peerId && this.session?.roomId === body.roomId) {
      if (this.socket?.readyState !== WebSocket.OPEN) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        return await this.connectWithRetry() as T;
      }
      this.socket.send(JSON.stringify({ kind: 'join', recipientId: this.hostId, payload: { reset: true } }));
      return { hostId: this.hostId } as T;
    }
    this.close();
    this.stopped = false;
    this.session = body;
    try { return await this.connectWithRetry() as T; }
    catch (error) { if (this.session === body) this.close(); throw error; }
  }
  private async connectWithRetry(): Promise<{ hostId: string }> {
    let attempts = 0;
    const session = this.session;
    while (!this.stopped && this.session === session) {
      try {
        return await this.connect();
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (['room_forbidden', 'room_full'].includes(name) || attempts >= 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempts++, 3000)));
      }
    }
    throw new Error('socket_closed');
  }
  resume() {
    if (this.stopped || !this.session) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastPong > 90000) this.socket.close();
      else this.socket.send('ping');
    } else if (this.socket?.readyState !== WebSocket.CONNECTING) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      void this.connect().catch(() => this.reconnect());
    }
  }
  close() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    this.connecting = null;
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ type: 'leave' })); } catch { /* Already disconnected. */ }
    }
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.listener = null;
    this.pending = [];
  }
}
