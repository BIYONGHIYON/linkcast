import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    hostId: text('host_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('idx_rooms_expires_at').on(table.expiresAt)],
);

export const peers = sqliteTable(
  'peers',
  {
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    peerId: text('peer_id').notNull(),
    role: text('role', { enum: ['host', 'viewer'] }).notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.peerId] }),
    index('idx_peers_room_role').on(table.roomId, table.role),
    index('idx_peers_last_seen_at').on(table.lastSeenAt),
  ],
);

export const signals = sqliteTable(
  'signals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roomId: text('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(),
    recipientId: text('recipient_id').notNull(),
    kind: text('kind', {
      enum: ['join', 'offer', 'answer', 'candidate', 'leave'],
    }).notNull(),
    payload: text('payload').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_signals_recipient').on(
      table.roomId,
      table.recipientId,
      table.id,
    ),
    index('idx_signals_created_at').on(table.createdAt),
  ],
);
