import { type SQL, sql } from 'drizzle-orm'
import type {
  Credential,
  Cursor,
  Envelope,
  Executor,
  KeyMaterial,
  NewUser,
  RawRow,
  ServerStore,
  Session,
  SqlDialect,
  User,
} from './types'

/**
 * 存储层的唯一实现：一条 SQL 路径，两个方言。
 *
 * 不写两套 `RecordStoreSqlite` / `RecordStorePg`，因为那样两份实现里"哪个更快"会更早
 * 被优化掉一致性；这里的 SQL 只用两边都有的子集（`ON CONFLICT`、`RETURNING`、
 * `IS NULL`），差异只有两处，都在下面写清楚了：
 *
 * 1. **布尔**：SQLite 只有 0/1，PG 是真 `boolean`。写之前按方言转换，读之后统一映射回 `boolean`。
 * 2. **大整数**：PG 驱动把 `bigint` 读成**字符串**（node-postgres 的默认行为，避免精度丢失）。
 *    所以每个 mapper 都过一遍 `num()`——漏一处就会在某天变成 `'1790000000000' + 1`。
 */

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value))
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value)
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)
const boolOf = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 't'

const mapUser = (row: RawRow): User => ({
  id: String(row.id),
  email: String(row.email),
  emailVerifiedAt: numOrNull(row.email_verified_at),
  status: String(row.status) as User['status'],
  createdAt: num(row.created_at),
  dekWrappedKek: strOrNull(row.dek_wrapped_kek),
  dekWrappedRecovery: strOrNull(row.dek_wrapped_recovery),
  kdfSaltA: strOrNull(row.kdf_salt_a),
  kdfSaltB: strOrNull(row.kdf_salt_b),
  kdfParams: strOrNull(row.kdf_params),
})

const mapSession = (row: RawRow): Session => ({
  id: String(row.id),
  userId: String(row.user_id),
  tokenHash: String(row.token_hash),
  deviceLabel: strOrNull(row.device_label),
  createdAt: num(row.created_at),
  lastSeen: num(row.last_seen),
  expiresAt: num(row.expires_at),
  revokedAt: numOrNull(row.revoked_at),
})

const mapEnvelope = (row: RawRow): Envelope => ({
  userId: String(row.user_id),
  id: String(row.id),
  kind: String(row.kind) as Envelope['kind'],
  takenAt: num(row.taken_at),
  rev: num(row.rev),
  iv: String(row.iv),
  ct: String(row.ct),
  deviceId: String(row.device_id),
  updatedAt: num(row.updated_at),
})

const mapCredential = (row: RawRow): Credential => ({
  userId: String(row.user_id),
  passwordHash: String(row.password_hash),
  totpSecretCt: strOrNull(row.totp_secret_ct),
  totpEnabled: boolOf(row.totp_enabled),
  updatedAt: num(row.updated_at),
})

export interface ServerStoreOptions {
  exec: Executor
  dialect: SqlDialect
}

/**
 * 建一个 store。**`async` 是必要的**：SQLite 的外键级联默认是关的，
 * 必须在这个连接上先 `PRAGMA foreign_keys = ON`——不然"删账号即硬删密文"会留下孤儿行，
 * 而删除测试在 PG 上却是绿的（PG 永远级联）。
 */
export async function openServerStore(options: ServerStoreOptions): Promise<ServerStore> {
  const { exec, dialect } = options
  const flag = (value: boolean): number | boolean => (dialect === 'sqlite' ? Number(value) : value)

  if (dialect === 'sqlite') {
    await exec.run(sql`PRAGMA foreign_keys = ON`)
  }

  const store: ServerStore = {
    async createUser(user: NewUser) {
      const rows = await exec.run(sql`
        INSERT INTO users (id, email, email_verified_at, status, created_at)
        VALUES (
          ${user.id},
          ${user.email},
          ${user.emailVerifiedAt ?? null},
          ${user.status ?? 'incomplete'},
          ${user.createdAt}
        )
        ON CONFLICT (email) DO NOTHING
        RETURNING *
      `)
      const row = rows[0]
      return row ? mapUser(row) : null
    },

    async getUserByEmail(email: string) {
      const rows = await exec.run(sql`SELECT * FROM users WHERE email = ${email} LIMIT 1`)
      const row = rows[0]
      return row ? mapUser(row) : null
    },

    async getUserById(id: string) {
      const rows = await exec.run(sql`SELECT * FROM users WHERE id = ${id} LIMIT 1`)
      const row = rows[0]
      return row ? mapUser(row) : null
    },

    async activateUser(userId: string, material: KeyMaterial) {
      const rows = await exec.run(sql`
        UPDATE users SET
          dek_wrapped_kek = ${material.dekWrappedKek},
          dek_wrapped_recovery = ${material.dekWrappedRecovery},
          kdf_salt_a = ${material.kdfSaltA},
          kdf_salt_b = ${material.kdfSaltB},
          kdf_params = ${material.kdfParams},
          status = 'active'
        WHERE id = ${userId} AND status = 'incomplete'
        RETURNING id
      `)
      return rows.length > 0
    },

    async deleteUser(userId: string) {
      await exec.run(sql`DELETE FROM users WHERE id = ${userId}`)
    },

    async upsertCredential(credential: Credential) {
      await exec.run(sql`
        INSERT INTO credentials (user_id, password_hash, totp_secret_ct, totp_enabled, updated_at)
        VALUES (
          ${credential.userId},
          ${credential.passwordHash},
          ${credential.totpSecretCt},
          ${flag(credential.totpEnabled)},
          ${credential.updatedAt}
        )
        ON CONFLICT (user_id) DO UPDATE SET
          password_hash = excluded.password_hash,
          totp_secret_ct = excluded.totp_secret_ct,
          totp_enabled = excluded.totp_enabled,
          updated_at = excluded.updated_at
      `)
    },

    async getCredential(userId: string) {
      const rows = await exec.run(sql`SELECT * FROM credentials WHERE user_id = ${userId} LIMIT 1`)
      const row = rows[0]
      return row ? mapCredential(row) : null
    },

    async createSession(session: Session) {
      await exec.run(sql`
        INSERT INTO sessions (id, user_id, token_hash, device_label, created_at, last_seen, expires_at, revoked_at)
        VALUES (
          ${session.id},
          ${session.userId},
          ${session.tokenHash},
          ${session.deviceLabel},
          ${session.createdAt},
          ${session.lastSeen},
          ${session.expiresAt},
          ${session.revokedAt}
        )
      `)
    },

    async getLiveSession(tokenHash: string, now: number) {
      const rows = await exec.run(sql`
        SELECT * FROM sessions
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND expires_at > ${now}
        LIMIT 1
      `)
      const row = rows[0]
      return row ? mapSession(row) : null
    },

    async touchSession(sessionId: string, now: number) {
      await exec.run(sql`UPDATE sessions SET last_seen = ${now} WHERE id = ${sessionId}`)
    },

    async revokeSession(sessionId: string, userId: string, now: number) {
      const rows = await exec.run(sql`
        UPDATE sessions SET revoked_at = ${now}
        WHERE id = ${sessionId} AND user_id = ${userId} AND revoked_at IS NULL
        RETURNING id
      `)
      return rows.length > 0
    },

    async revokeAllSessions(userId: string, now: number) {
      const rows = await exec.run(sql`
        UPDATE sessions SET revoked_at = ${now}
        WHERE user_id = ${userId} AND revoked_at IS NULL
        RETURNING id
      `)
      return rows.length
    },

    async listLiveSessions(userId: string, now: number) {
      const rows = await exec.run(sql`
        SELECT * FROM sessions
        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now}
        ORDER BY last_seen DESC, id
      `)
      return rows.map(mapSession)
    },

    async pullRecords(userId: string, cursor: Cursor) {
      const rows = await exec.run(sql`
        SELECT * FROM records
        WHERE user_id = ${userId}
          AND (updated_at > ${cursor.updatedAt} OR (updated_at = ${cursor.updatedAt} AND id > ${cursor.id}))
        ORDER BY updated_at, id
        LIMIT ${cursor.limit}
      `)
      return rows.map(mapEnvelope)
    },

    async getRecord(userId: string, id: string) {
      const rows = await exec.run(sql`
        SELECT * FROM records WHERE user_id = ${userId} AND id = ${id} LIMIT 1
      `)
      const row = rows[0]
      return row ? mapEnvelope(row) : null
    },

    async insertRecord(record: Envelope) {
      await exec.run(sql`
        INSERT INTO records (user_id, id, kind, taken_at, rev, iv, ct, device_id, updated_at)
        VALUES (
          ${record.userId},
          ${record.id},
          ${record.kind},
          ${record.takenAt},
          ${record.rev},
          ${record.iv},
          ${record.ct},
          ${record.deviceId},
          ${record.updatedAt}
        )
        ON CONFLICT (user_id, id) DO NOTHING
      `)
    },

    async createInviteCode(
      codeHash: string,
      createdBy: string | null,
      createdAt: number,
      expiresAt: number | null,
    ) {
      await exec.run(sql`
        INSERT INTO invite_codes (code_hash, created_by, created_at, expires_at)
        VALUES (${codeHash}, ${createdBy}, ${createdAt}, ${expiresAt})
        ON CONFLICT (code_hash) DO NOTHING
      `)
    },

    async consumeInviteCode(codeHash: string, userId: string, now: number) {
      const rows = await exec.run(sql`
        UPDATE invite_codes SET used_by = ${userId}, used_at = ${now}
        WHERE code_hash = ${codeHash}
          AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${now})
        RETURNING code_hash
      `)
      return rows.length > 0
    },

    async kvGet(key: string, now: number) {
      const rows = await exec.run(
        sql`SELECT value, expires_at FROM storage_kv WHERE key = ${key} LIMIT 1`,
      )
      const row = rows[0]
      if (!row) return null
      const expiresAt = numOrNull(row.expires_at)
      if (expiresAt !== null && expiresAt <= now) {
        // 过期的顺手删掉：没有 KV 的 TTL，读取就是唯一的清扫时机。
        await exec.run(sql`DELETE FROM storage_kv WHERE key = ${key} AND expires_at <= ${now}`)
        return null
      }
      return String(row.value)
    },

    async kvSet(key: string, value: string, expiresAt: number | null) {
      await exec.run(sql`
        INSERT INTO storage_kv (key, value, expires_at)
        VALUES (${key}, ${value}, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at
      `)
    },

    async kvDelete(key: string) {
      await exec.run(sql`DELETE FROM storage_kv WHERE key = ${key}`)
    },

    async kvSweep(now: number) {
      const rows = await exec.run(sql`
        DELETE FROM storage_kv WHERE expires_at IS NOT NULL AND expires_at <= ${now} RETURNING key
      `)
      return rows.length
    },
  }

  return store
}

/** 只为测试与 CLI 需要：拿到原始 SQL 句柄。业务代码不该用它。 */
export const rawExec = (exec: Executor) => (query: SQL) => exec.run(query)
