import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite'
import { drizzle as drizzlePg } from 'drizzle-orm/pglite'
import { createExecutor } from '../src/store/executor'
import { openServerStore } from '../src/store/sql'
import type { Envelope, ServerStore } from '../src/store/types'

/**
 * **同一套断言跑在两个真数据库上。**
 *
 * 存储层的价值全在"两个方言行为一致"，所以测试不能只跑 SQLite 再"相信" PG 也一样：
 * 每个用例都在后面那个 `backend` 上跑两遍。这里不 mock，也不抽象出第四个假实现——
 * 假实现只会证明假实现是对的。
 */

const migrations = (dialect: 'sqlite' | 'pg'): string[] => {
  const dir = join(import.meta.dir, '..', 'migrations', dialect)
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => join(dir, file))
}

const statements = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)

export interface Backend {
  name: string
  open(): Promise<{ store: ServerStore; reset(): Promise<void>; close(): Promise<void> }>
}

const T0 = 1_790_000_000_000

const sqliteBackend: Backend = {
  name: 'sqlite（bun:sqlite）',
  async open() {
    const db = new Database(':memory:')
    for (const file of migrations('sqlite')) {
      for (const statement of statements(file)) db.exec(statement)
    }
    const store = await openServerStore({
      exec: createExecutor(drizzleSqlite(db)),
      dialect: 'sqlite',
    })
    return {
      store,
      reset: async () => {
        db.exec('DELETE FROM users; DELETE FROM invite_codes; DELETE FROM storage_kv;')
      },
      close: async () => {
        db.close()
      },
    }
  },
}

const pgBackend: Backend = {
  name: 'pg（PGlite）',
  async open() {
    const pg = new PGlite()
    for (const file of migrations('pg')) {
      for (const statement of statements(file)) await pg.exec(statement)
    }
    const store = await openServerStore({
      exec: createExecutor(drizzlePg(pg)),
      dialect: 'pg',
    })
    return {
      store,
      reset: async () => {
        await pg.exec('TRUNCATE users, invite_codes, storage_kv RESTART IDENTITY CASCADE')
      },
      close: async () => {
        await pg.close()
      },
    }
  },
}

const backends: Backend[] = [sqliteBackend, pgBackend]

const envelope = (overrides: Partial<Envelope> = {}): Envelope => ({
  userId: 'user-1',
  id: 'dose-1',
  kind: 'dose',
  takenAt: T0,
  rev: 1,
  iv: 'aXY=',
  ct: 'Y3Q=',
  deviceId: 'device-a',
  updatedAt: T0,
  ...overrides,
})

/**
 * 起一次、清一次。
 *
 * 每个用例都新起一个 PGlite 要 1.8 秒，14 个用例就是 25 秒——测试跑得慢，人就开始
 * 跳过测试。所以每个后端只开一次，用例之间用 DELETE/TRUNCATE 复原。这不是"共享状态
 * 带来不确定性"：复原语句把每个用例都放回同一张白纸，而白纸的内容由 schema 决定。
 */
function harnessOf(backend: Backend) {
  let instance: Awaited<ReturnType<Backend['open']>> | null = null
  return {
    async store(): Promise<ServerStore> {
      instance ??= await backend.open()
      await instance.reset()
      return instance.store
    },
    async close(): Promise<void> {
      if (instance) {
        await instance.close()
        instance = null
      }
    },
  }
}

for (const backend of backends) {
  const harness = harnessOf(backend)
  describe(`存储层 @ ${backend.name}`, () => {
    test('建用户：同一邮箱第二次返回 null，而不是抛异常', async () => {
      const store = await harness.store()
      const first = await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      expect(first?.status).toBe('incomplete')
      expect(first?.createdAt).toBe(T0)

      const second = await store.createUser({
        id: 'user-2',
        email: 'a@example.com',
        createdAt: T0 + 1,
      })
      expect(second).toBeNull()
      expect(await store.getUserById('user-2')).toBeNull()
    })

    test('激活只发生在 incomplete 上：重复上传包裹对象不改已激活的账号', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      const material = {
        dekWrappedKek: 'kek-blob',
        dekWrappedRecovery: 'recovery-blob',
        kdfSaltA: 'salt-a',
        kdfSaltB: 'salt-b',
        kdfParams: '{"memorySizeKiB":65536}',
      }
      expect(await store.activateUser('user-1', material)).toBe(true)
      const activated = await store.getUserById('user-1')
      expect(activated?.status).toBe('active')
      expect(activated?.dekWrappedKek).toBe('kek-blob')

      expect(
        await store.activateUser('user-1', { ...material, dekWrappedKek: 'attacker-blob' }),
      ).toBe(false)
      expect((await store.getUserById('user-1'))?.dekWrappedKek).toBe('kek-blob')
    })

    test('凭据 upsert 把 totp_enabled 存成真布尔（sqlite 存 0/1，读回来还是 boolean）', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.upsertCredential({
        userId: 'user-1',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
        totpSecretCt: null,
        totpEnabled: false,
        updatedAt: T0,
      })
      expect((await store.getCredential('user-1'))?.totpEnabled).toBe(false)

      await store.upsertCredential({
        userId: 'user-1',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA',
        totpSecretCt: 'ct',
        totpEnabled: true,
        updatedAt: T0 + 1,
      })
      const stored = await store.getCredential('user-1')
      expect(stored?.totpEnabled).toBe(true)
      expect(stored?.totpSecretCt).toBe('ct')
      expect(stored?.updatedAt).toBe(T0 + 1)
    })

    test('会话：过期与已撤销的 token 都查不到，活跃的能查到', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      const base = {
        userId: 'user-1',
        tokenHash: 'hash-live',
        deviceLabel: 'Pixel',
        createdAt: T0,
        lastSeen: T0,
        expiresAt: T0 + 1000,
        revokedAt: null,
      }
      await store.createSession({ id: 's-live', ...base })
      await store.createSession({
        id: 's-expired',
        ...base,
        tokenHash: 'hash-expired',
        expiresAt: T0 - 1,
      })
      await store.createSession({
        id: 's-revoked',
        ...base,
        tokenHash: 'hash-revoked',
        revokedAt: T0 - 5,
      })

      expect((await store.getLiveSession('hash-live', T0))?.id).toBe('s-live')
      expect(await store.getLiveSession('hash-expired', T0)).toBeNull()
      expect(await store.getLiveSession('hash-revoked', T0)).toBeNull()
      // 边界：expires_at == now 时算过期，否则"一毫秒前还能用"
      expect(await store.getLiveSession('hash-live', T0 + 1000)).toBeNull()
    })

    test('撤销一个会话返回 true，再撤销一次返回 false（幂等而不是重复写时间戳）', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.createSession({
        id: 's1',
        userId: 'user-1',
        tokenHash: 'hash-1',
        deviceLabel: null,
        createdAt: T0,
        lastSeen: T0,
        expiresAt: T0 + 1000,
        revokedAt: null,
      })
      expect(await store.revokeSession('s1', 'user-1', T0 + 1)).toBe(true)
      expect(await store.revokeSession('s1', 'user-1', T0 + 2)).toBe(false)
      // 别人的会话撤不掉
      expect(await store.revokeSession('s1', 'user-2', T0 + 3)).toBe(false)
    })

    test('revokeAllSessions 返回被撤销的条数，且不影响别人', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.createUser({ id: 'user-2', email: 'b@example.com', createdAt: T0 })
      for (const [id, userId] of [
        ['s1', 'user-1'],
        ['s2', 'user-1'],
        ['s3', 'user-2'],
      ] as const) {
        await store.createSession({
          id,
          userId,
          tokenHash: `hash-${id}`,
          deviceLabel: null,
          createdAt: T0,
          lastSeen: T0,
          expiresAt: T0 + 10_000,
          revokedAt: null,
        })
      }
      expect(await store.revokeAllSessions('user-1', T0 + 1)).toBe(2)
      expect((await store.listLiveSessions('user-1', T0 + 1)).length).toBe(0)
      expect((await store.listLiveSessions('user-2', T0 + 1)).length).toBe(1)
    })

    test('复合游标：同毫秒的多条记录不会整页跳过', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      // 五条落在同一 updated_at，正是批量导入的形态
      const ids = ['a', 'b', 'c', 'd', 'e']
      for (const id of ids) await store.insertRecord(envelope({ id }))

      const page1 = await store.pullRecords('user-1', { updatedAt: 0, id: '', limit: 2 })
      expect(page1.map((row) => row.id)).toEqual(['a', 'b'])
      const last = page1.at(-1)
      if (!last) throw new Error('空页')
      const page2 = await store.pullRecords('user-1', {
        updatedAt: last.updatedAt,
        id: last.id,
        limit: 2,
      })
      expect(page2.map((row) => row.id)).toEqual(['c', 'd'])
      const page3 = await store.pullRecords('user-1', {
        updatedAt: page2[1]?.updatedAt ?? 0,
        id: page2[1]?.id ?? '',
        limit: 2,
      })
      expect(page3.map((row) => row.id)).toEqual(['e'])
    })

    test('拉取只看自己的记录', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.createUser({ id: 'user-2', email: 'b@example.com', createdAt: T0 })
      await store.insertRecord(envelope({ id: 'mine' }))
      await store.insertRecord(envelope({ userId: 'user-2', id: 'theirs' }))
      const rows = await store.pullRecords('user-1', { updatedAt: 0, id: '', limit: 50 })
      expect(rows.map((row) => row.id)).toEqual(['mine'])
      expect(await store.getRecord('user-1', 'theirs')).toBeNull()
    })

    test('邀请码是一条 UPDATE 完成"检查 + 使用"：第二次必然失败', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.createUser({ id: 'user-2', email: 'b@example.com', createdAt: T0 })
      await store.createInviteCode('hash-code', null, T0, T0 + 1000)

      expect(await store.consumeInviteCode('hash-code', 'user-1', T0 + 1)).toBe(true)
      expect(await store.consumeInviteCode('hash-code', 'user-2', T0 + 2)).toBe(false)
    })

    test('过期的邀请码用不了', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.createInviteCode('hash-old', null, T0, T0 + 10)
      expect(await store.consumeInviteCode('hash-old', 'user-1', T0 + 11)).toBe(false)
      await store.createInviteCode('hash-forever', null, T0, null)
      expect(await store.consumeInviteCode('hash-forever', 'user-1', T0 + 999_999)).toBe(true)
    })

    test('KV：写进去能读出来，覆盖写不留旧值', async () => {
      const store = await harness.store()
      await store.kvSet('k', 'v1', null)
      expect(await store.kvGet('k', T0)).toBe('v1')
      await store.kvSet('k', 'v2', null)
      expect(await store.kvGet('k', T0)).toBe('v2')
      await store.kvDelete('k')
      expect(await store.kvGet('k', T0)).toBeNull()
    })

    test('KV 的 TTL 由读取方判断：过期即 null，并且行被顺手删掉', async () => {
      const store = await harness.store()
      await store.kvSet('short', 'v', T0 + 100)
      expect(await store.kvGet('short', T0 + 99)).toBe('v')
      expect(await store.kvGet('short', T0 + 100)).toBeNull()
      // 再读一次：不是"每次都重新判断过期"，而是真的删了
      expect(await store.kvSweep(T0 + 100)).toBe(0)
    })

    test('kvSweep 清理所有到期的键，返回条数', async () => {
      const store = await harness.store()
      await store.kvSet('a', '1', T0 + 1)
      await store.kvSet('b', '2', T0 + 1000)
      await store.kvSet('c', '3', null)
      expect(await store.kvSweep(T0 + 2)).toBe(1)
      expect(await store.kvGet('b', T0 + 2)).toBe('2')
      expect(await store.kvGet('c', T0 + 2)).toBe('3')
    })

    test('删账号是硬删：记录、会话、凭据一起消失（靠外键级联，不靠手写四条 DELETE）', async () => {
      const store = await harness.store()
      await store.createUser({ id: 'user-1', email: 'a@example.com', createdAt: T0 })
      await store.insertRecord(envelope())
      await store.createSession({
        id: 's1',
        userId: 'user-1',
        tokenHash: 'hash-1',
        deviceLabel: null,
        createdAt: T0,
        lastSeen: T0,
        expiresAt: T0 + 1000,
        revokedAt: null,
      })
      await store.upsertCredential({
        userId: 'user-1',
        passwordHash: 'phc',
        totpSecretCt: null,
        totpEnabled: false,
        updatedAt: T0,
      })

      await store.deleteUser('user-1')

      expect(await store.getUserById('user-1')).toBeNull()
      expect(await store.getRecord('user-1', 'dose-1')).toBeNull()
      expect(await store.getLiveSession('hash-1', T0)).toBeNull()
      expect(await store.getCredential('user-1')).toBeNull()
    })
  })

  afterAll(async () => {
    await harness.close()
  })
}
