import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * SQLite / D1 方言的 schema。**逻辑结构与 `schema.pg.ts` 必须一致**——
 * 一致性由 `test/schema-parity.test.ts` 逐表逐列比对，不靠"记得两边都改"。
 *
 * 时间一律 epoch 毫秒（`INTEGER`，SQLite 的 INTEGER 是 64 位，装得下）。
 * 布尔一律 `INTEGER` 0/1：SQLite 没有 boolean 类型，用 0/1 比用 'true'/'false' 少一类错。
 * JSON 一律 `TEXT`，存进之前由调用方 stringify —— 让 SQLite 和 PG 都别去猜结构化。
 */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** 登录标识。规范化（小写 + trim）在写入前完成，见 `normalizeEmail`。 */
    email: text('email').notNull(),
    emailVerifiedAt: integer('email_verified_at'),
    /**
     * `incomplete` = 还没上传 `dek_wrapped_*` 的半成品账号（§6.3 第 4 步之前），
     * 只能完成注册或注销，不能写任何数据。`deleted` 是墓碑，真正的硬删会把它也删掉。
     */
    status: text('status', { enum: ['incomplete', 'active', 'deleted'] })
      .notNull()
      .default('incomplete'),
    createdAt: integer('created_at').notNull(),
    /** 两段包裹对象（`base64(iv)|base64(ct)`）。服务端只搬运，永不解析。 */
    dekWrappedKek: text('dek_wrapped_kek'),
    dekWrappedRecovery: text('dek_wrapped_recovery'),
    /** 两个 salt 各自独立：口令泄漏不该牵连恢复短语的派生。 */
    kdfSaltA: text('kdf_salt_a'),
    kdfSaltB: text('kdf_salt_b'),
    /** `{ memorySizeKiB, iterations, parallelism }` —— 参数是数据，老账号要能用老参数解开。 */
    kdfParams: text('kdf_params'),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email)],
)

export const credentials = sqliteTable('credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Argon2id PHC 串（`$argon2id$v=19$m=65536,t=3,p=1$…`），用于**登录校验**，与 KEK 无关。 */
  passwordHash: text('password_hash').notNull(),
  totpSecretCt: text('totp_secret_ct'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
})

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 只存 SHA-256(token)：库被拖走后，里面没有任何能直接当 cookie 用的东西。 */
    tokenHash: text('token_hash').notNull(),
    deviceLabel: text('device_label'),
    createdAt: integer('created_at').notNull(),
    lastSeen: integer('last_seen').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
)

/**
 * 同步信封（§4.3 / §7）。服务端能看到的全部就是这些列：
 * 谁（`user_id`）、哪条（`id`）、什么类型（`kind`）、什么时候打的（`taken_at`）、
 * 第几版（`rev`）、以及一串它读不懂的字节（`iv` / `ct`）。
 *
 * 复合主键 `(user_id, id)`：`id` 是客户端生成、还能来自导入文件的自由字符串，
 * 两个用户撞同一个 `id` 不是安全事件，但绝不能因此互相覆盖。
 */
export const records = sqliteTable(
  'records',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    kind: text('kind', { enum: ['dose', 'lab', 'tombstone'] }).notNull(),
    takenAt: integer('taken_at').notNull(),
    rev: integer('rev').notNull(),
    iv: text('iv').notNull(),
    ct: text('ct').notNull(),
    deviceId: text('device_id').notNull(),
    /** 服务端时钟，**唯一**用来做游标排序；客户端时间只活在密文里。 */
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    // 复合游标 (updated_at, id)：批量导入让上千条同毫秒落地时，只按时间分页会整页跳过。
    index('records_user_cursor_idx').on(t.userId, t.updatedAt, t.id),
    index('records_user_taken_idx').on(t.userId, t.takenAt),
  ],
)

export const inviteCodes = sqliteTable('invite_codes', {
  /** 只存哈希：这张表被读走不等于邀请码被读走。 */
  codeHash: text('code_hash').primaryKey(),
  createdBy: text('created_by'),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
  usedAt: integer('used_at'),
})

/**
 * VPS 上替身 Cloudflare KV 的那张表（§13）。CF 目标用真 KV，本表只在 node-server 下用。
 * `expires_at` 由读取方判断并顺手删除 —— 没有 KV 的 TTL，就自己造一个。
 */
export const storageKv = sqliteTable(
  'storage_kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
  },
  (t) => [index('storage_kv_expires_idx').on(t.expiresAt)],
)
