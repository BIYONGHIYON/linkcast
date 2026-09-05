import { getDatabase } from '@/db';

const ROOM_TTL_SECONDS = 6 * 60 * 60;
const PEER_TTL_SECONDS = 30;
const MAX_VIEWERS = 5;
const idPattern = /^[a-zA-Z0-9_-]{8,80}$/;

type RoomPayload = {
  roomId?: string;
  peerId?: string;
  role?: 'host' | 'viewer' | 'leave';
};

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

async function readPayload(request: Request): Promise<RoomPayload> {
  try {
    return (await request.json()) as RoomPayload;
  } catch {
    return {};
  }
}

async function cleanExpiredRows(now: number) {
  const database = getDatabase();
  await database.batch([
    database.prepare('DELETE FROM signals WHERE created_at < ?').bind(now - 120),
    database.prepare('DELETE FROM peers WHERE last_seen_at < ?').bind(now - PEER_TTL_SECONDS),
    database.prepare('DELETE FROM rooms WHERE expires_at < ?').bind(now),
  ]);
}

async function removePeer(roomId: string, peerId: string) {
  const database = getDatabase();
  const room = await database
    .prepare('SELECT host_id AS hostId FROM rooms WHERE id = ?')
    .bind(roomId)
    .first<{ hostId: string }>();

  if (room?.hostId === peerId) {
    await database.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId).run();
    return;
  }

  if (room) {
    await database
      .prepare("INSERT INTO signals (room_id, sender_id, recipient_id, kind, payload, created_at) VALUES (?, ?, ?, 'leave', '{}', ?)")
      .bind(roomId, peerId, room.hostId, Math.floor(Date.now() / 1000))
      .run();
  }

  await database
    .prepare('DELETE FROM peers WHERE room_id = ? AND peer_id = ?')
    .bind(roomId, peerId)
    .run();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  if (!isValidId(roomId)) {
    return Response.json({ error: 'invalid_room' }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  await cleanExpiredRows(now);
  const room = await getDatabase()
    .prepare('SELECT host_id AS hostId, expires_at AS expiresAt FROM rooms WHERE id = ? AND expires_at > ?')
    .bind(roomId, now)
    .first<{ hostId: string; expiresAt: number }>();

  if (!room) return Response.json({ error: 'room_not_found' }, { status: 404 });
  return Response.json(room);
}

export async function POST(request: Request) {
  const body = await readPayload(request);
  if (!isValidId(body.roomId) || !isValidId(body.peerId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const database = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  await cleanExpiredRows(now);

  if (body.role === 'leave') {
    await removePeer(body.roomId, body.peerId);
    return Response.json({ ok: true });
  }

  if (body.role === 'host') {
    const expiresAt = now + ROOM_TTL_SECONDS;
    await database.batch([
      database
        .prepare('INSERT INTO rooms (id, host_id, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET host_id = excluded.host_id, expires_at = excluded.expires_at')
        .bind(body.roomId, body.peerId, now, expiresAt),
      database
        .prepare("INSERT INTO peers (room_id, peer_id, role, last_seen_at) VALUES (?, ?, 'host', ?)")
        .bind(body.roomId, body.peerId, now),
    ]);
    return Response.json({ roomId: body.roomId, hostId: body.peerId, expiresAt });
  }

  if (body.role !== 'viewer') {
    return Response.json({ error: 'invalid_role' }, { status: 400 });
  }

  const room = await database
    .prepare(`
      SELECT rooms.host_id AS hostId
      FROM rooms
      INNER JOIN peers ON peers.room_id = rooms.id AND peers.peer_id = rooms.host_id AND peers.role = 'host'
      WHERE rooms.id = ? AND rooms.expires_at > ? AND peers.last_seen_at >= ?
    `)
    .bind(body.roomId, now, now - PEER_TTL_SECONDS)
    .first<{ hostId: string }>();
  if (!room) return Response.json({ error: 'room_offline' }, { status: 404 });

  // 슬롯 확인과 참가자 등록을 하나의 INSERT 조건으로 처리해, 동시에 참가해도
  // 두 요청이 같은 빈 슬롯을 함께 통과하지 않도록 합니다.
  const registration = await database
    .prepare(`
      INSERT INTO peers (room_id, peer_id, role, last_seen_at)
      SELECT ?, ?, 'viewer', ?
      WHERE EXISTS (
        SELECT 1 FROM rooms WHERE id = ? AND expires_at > ?
      )
      AND (
        EXISTS (
          SELECT 1 FROM peers WHERE room_id = ? AND peer_id = ?
        )
        OR (
          SELECT COUNT(*) FROM peers
          WHERE room_id = ? AND role = 'viewer' AND last_seen_at >= ?
        ) < ?
      )
      ON CONFLICT(room_id, peer_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `)
    .bind(
      body.roomId,
      body.peerId,
      now,
      body.roomId,
      now,
      body.roomId,
      body.peerId,
      body.roomId,
      now - PEER_TTL_SECONDS,
      MAX_VIEWERS,
    )
    .run();

  if (registration.meta.changes !== 1) {
    const currentRoom = await database
      .prepare(`
        SELECT 1 AS found
        FROM rooms
        INNER JOIN peers ON peers.room_id = rooms.id AND peers.peer_id = rooms.host_id AND peers.role = 'host'
        WHERE rooms.id = ? AND rooms.expires_at > ? AND peers.last_seen_at >= ?
      `)
      .bind(body.roomId, now, now - PEER_TTL_SECONDS)
      .first<{ found: number }>();
    if (!currentRoom) return Response.json({ error: 'room_not_found' }, { status: 404 });
    return Response.json({ error: 'room_full' }, { status: 409 });
  }

  await database
    .prepare("INSERT INTO signals (room_id, sender_id, recipient_id, kind, payload, created_at) VALUES (?, ?, ?, 'join', '{}', ?)")
    .bind(body.roomId, body.peerId, room.hostId, now)
    .run();

  return Response.json({ roomId: body.roomId, hostId: room.hostId });
}

export async function PATCH(request: Request) {
  const body = await readPayload(request);
  if (!isValidId(body.roomId) || !isValidId(body.peerId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  await cleanExpiredRows(now);
  const result = await getDatabase()
    .prepare('UPDATE peers SET last_seen_at = ? WHERE room_id = ? AND peer_id = ?')
    .bind(now, body.roomId, body.peerId)
    .run();
  return Response.json({ ok: true, active: result.meta.changes === 1 });
}

export async function DELETE(request: Request) {
  const body = await readPayload(request);
  if (!isValidId(body.roomId) || !isValidId(body.peerId)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }
  await removePeer(body.roomId, body.peerId);
  return Response.json({ ok: true });
}
