import { getDatabase } from '@/db';

const idPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const allowedKinds = new Set(['offer', 'answer', 'candidate']);

type SignalPayload = {
  roomId?: string;
  senderId?: string;
  recipientId?: string;
  kind?: string;
  payload?: unknown;
};

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const peerId = url.searchParams.get('peerId');
  const after = Number(url.searchParams.get('after') || 0);

  if (!isValidId(roomId) || !isValidId(peerId) || !Number.isSafeInteger(after) || after < 0) {
    return Response.json({ error: 'invalid_query' }, { status: 400 });
  }

  const result = await getDatabase()
    .prepare(
      'SELECT id, sender_id AS senderId, kind, payload FROM signals WHERE room_id = ? AND recipient_id = ? AND id > ? ORDER BY id ASC LIMIT 100',
    )
    .bind(roomId, peerId, after)
    .all<{ id: number; senderId: string; kind: string; payload: string }>();

  return Response.json({ signals: result.results });
}

export async function POST(request: Request) {
  let body: SignalPayload = {};
  try {
    body = (await request.json()) as SignalPayload;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (
    !isValidId(body.roomId) ||
    !isValidId(body.senderId) ||
    !isValidId(body.recipientId) ||
    !allowedKinds.has(body.kind || '')
  ) {
    return Response.json({ error: 'invalid_signal' }, { status: 400 });
  }

  const payload = JSON.stringify(body.payload ?? {});
  if (payload.length > 120_000) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const now = Math.floor(Date.now() / 1000);
  const database = getDatabase();
  const peer = await database
    .prepare('SELECT 1 AS found FROM peers WHERE room_id = ? AND peer_id = ?')
    .bind(body.roomId, body.senderId)
    .first<{ found: number }>();
  if (!peer) return Response.json({ error: 'unknown_peer' }, { status: 403 });

  const result = await database
    .prepare('INSERT INTO signals (room_id, sender_id, recipient_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(body.roomId, body.senderId, body.recipientId, body.kind, payload, now)
    .run();

  return Response.json({ id: result.meta.last_row_id });
}
