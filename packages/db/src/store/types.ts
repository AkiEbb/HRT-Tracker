import type { SQL } from 'drizzle-orm'

/**
 * 存储层的**接缝**：上层（auth、sync、share）只认这个接口，不认 D1 / better-sqlite3 / pg。
 *
 * 为什么要有这一层：v0.2 的验收里有一条"D1 与 VPS 都要绿"，而 D1 没有交互事务、单语句
 * ≤100 参数。如果业务代码直接拿 drizzle 的 `db` 写"读-改-写"，那么它在 SQLite 上跑得通、
 * 在 D1 上偶发丢写——这类 bug 只在生产出现。把需要原子性的动作各自收成**一条语句**，
 * 是能把这件事在测试里证明的唯一办法（见 `consumeInviteCode` / `casPutRecord` 的注释）。
 */

export type SqlDialect = 'sqlite' | 'pg'

/** 一行查询结果，列名即数据库列名（snake_case）。 */
export type RawRow = Record<string, unknown>

/**
 * 执行一条 SQL 并拿到行。
 *
 * 三个驱动的返回形状互不相同（bun:sqlite 是数组、pg/pglite 是 `{rows}`、D1 是 `{results}`），
 * 由 `createExecutor` 归一化。业务代码只看 `RawRow[]`。
 */
export interface Executor {
  run(query: SQL): Promise<RawRow[]>
}

export interface User {
  id: string
  email: string
  emailVerifiedAt: number | null
  status: 'incomplete' | 'active' | 'deleted'
  createdAt: number
  dekWrappedKek: string | null
  dekWrappedRecovery: string | null
  kdfSaltA: string | null
  kdfSaltB: string | null
  kdfParams: string | null
}

export interface Credential {
  userId: string
  passwordHash: string
  totpSecretCt: string | null
  totpEnabled: boolean
  updatedAt: number
}

export interface Session {
  id: string
  userId: string
  tokenHash: string
  deviceLabel: string | null
  createdAt: number
  lastSeen: number
  expiresAt: number
  revokedAt: number | null
}

/** 同步信封，服务端能看到的全部（§4.3）。 */
export interface Envelope {
  userId: string
  id: string
  kind: 'dose' | 'lab' | 'tombstone'
  takenAt: number
  rev: number
  iv: string
  ct: string
  deviceId: string
  updatedAt: number
}

export type NewUser = Pick<User, 'id' | 'email' | 'createdAt'> &
  Partial<Pick<User, 'emailVerifiedAt' | 'status'>>

/** 第 4 步上传的包裹材料（§6.3）。两段 salt 各自独立。 */
export interface KeyMaterial {
  dekWrappedKek: string
  dekWrappedRecovery: string
  kdfSaltA: string
  kdfSaltB: string
  kdfParams: string
}

export interface Cursor {
  updatedAt: number
  id: string
  limit: number
}

export interface ServerStore {
  /** 邮箱已存在时返回 `null`，而不是抛错——调用方要据此回一句"换个邮箱或去登录"。 */
  createUser(user: NewUser): Promise<User | null>
  getUserByEmail(email: string): Promise<User | null>
  getUserById(id: string): Promise<User | null>
  /** 只在 `incomplete` 状态下生效：重复提交包裹对象不该把已激活的账号改回去。 */
  activateUser(userId: string, material: KeyMaterial): Promise<boolean>
  /** 硬删（§25 决定）：记录、会话、凭据都随外键级联消失。 */
  deleteUser(userId: string): Promise<void>

  createInviteCode(
    codeHash: string,
    createdBy: string | null,
    createdAt: number,
    expiresAt: number | null,
  ): Promise<void>

  upsertCredential(credential: Credential): Promise<void>
  getCredential(userId: string): Promise<Credential | null>

  createSession(session: Session): Promise<void>
  /** 已撤销或过期的会话一律返回 `null`：过期判断只写在这里，不散到每个路由。 */
  getLiveSession(tokenHash: string, now: number): Promise<Session | null>
  touchSession(sessionId: string, now: number): Promise<void>
  revokeSession(sessionId: string, userId: string, now: number): Promise<boolean>
  revokeAllSessions(userId: string, now: number): Promise<number>
  listLiveSessions(userId: string, now: number): Promise<Session[]>

  /** 复合游标分页（§7.1）。`(updatedAt, id)` 两个字段都必须参与比较。 */
  pullRecords(userId: string, cursor: Cursor): Promise<Envelope[]>
  getRecord(userId: string, id: string): Promise<Envelope | null>
  /**
   * 原样写入一封记录信封，已存在则不动（不比较 rev）。
   * 带 rev 比较的 `casPutRecord` 属于同步切片——写冲突的判定要与客户端合并规则一起测，
   * 单独测一个 CAS 只能证明它自己。
   */
  insertRecord(record: Envelope): Promise<void>

  /**
   * 消费邀请码。**一条 UPDATE 完成"检查 + 使用"**：D1 没有交互事务，
   * 先查后写会让同一个码被两个并发请求同时用掉。
   */
  consumeInviteCode(codeHash: string, userId: string, now: number): Promise<boolean>

  kvGet(key: string, now: number): Promise<string | null>
  kvSet(key: string, value: string, expiresAt: number | null): Promise<void>
  kvDelete(key: string): Promise<void>
  /** 没有 KV 的 TTL 就自己扫：`expires_at` 到期的行删掉。 */
  kvSweep(now: number): Promise<number>
}
