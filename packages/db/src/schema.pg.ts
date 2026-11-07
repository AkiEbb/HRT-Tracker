import { bigint, boolean, index, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * PostgreSQL 方言的 schema。逻辑结构必须与 `schema.sqlite.ts` 一致，
 * 由 `test/schema-parity.test.ts` 强制比对表名、列名、可空性。
 *
 * 两处方言差异，都是刻意的：
 * - 时间用 `bigint` 但 `mode: 'number'`：node-postgres 默认把 bigint 读成字符串，
 *   那样每个时间戳都要 `Number()` 一遍，漏一个地方就变成字符串拼接。
 * - 没有 `storage_kv` 之外的 autoincrement；所有主键都是业务给的字符串 id（客户端生成，离线也能写）。
 */

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    emailVerifiedAt: bigint('email_verified_at', { mode: 'number' }),
    status: text('status', { enum: ['incomplete', 'active', 'deleted'] })
      .notNull()
      .default('incomplete'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    dekWrappedKek: text('dek_wrapped_kek'),
    dekWrappedRecovery: text('dek_wrapped_recovery'),
    kdfSaltA: text('kdf_salt_a'),
    kdfSaltB: text('kdf_salt_b'),
    kdfParams: text('kdf_params'),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
)

export const credentials = pgTable('credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  totpSecretCt: text('totp_secret_ct'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    deviceLabel: text('device_label'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSeen: bigint('last_seen', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    revokedAt: bigint('revoked_at', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
)

export const records = pgTable(
  'records',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    kind: text('kind', { enum: ['dose', 'lab', 'tombstone'] }).notNull(),
    takenAt: bigint('taken_at', { mode: 'number' }).notNull(),
    rev: bigint('rev', { mode: 'number' }).notNull(),
    iv: text('iv').notNull(),
    ct: text('ct').notNull(),
    deviceId: text('device_id').notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('records_user_cursor_idx').on(t.userId, t.updatedAt, t.id),
    index('records_user_taken_idx').on(t.userId, t.takenAt),
  ],
)

export const inviteCodes = pgTable('invite_codes', {
  codeHash: text('code_hash').primaryKey(),
  createdBy: text('created_by'),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }),
  usedAt: bigint('used_at', { mode: 'number' }),
})

export const storageKv = pgTable(
  'storage_kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }),
  },
  (t) => [index('storage_kv_expires_idx').on(t.expiresAt)],
)
