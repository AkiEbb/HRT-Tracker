import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle as drizzleSqlite } from 'drizzle-orm/bun-sqlite'
import { drizzle as drizzlePg } from 'drizzle-orm/pglite'
import { records as pgRecords, users as pgUsers } from '../src/schema.pg'
import { records as sqliteRecords, users as sqliteUsers } from '../src/schema.sqlite'

/**
 * 迁移文件的验收：**同一份数据写进两种方言、读回来逐字段相等**。
 *
 * 这里不去跑 drizzle-kit 或 drizzle migrator，而是直接把生成好的 `.sql` 灌进去——
 * 线上跑的就是这些 `.sql`，能跑通它们才叫能部署。PG 用 PGlite（真的 PostgreSQL
 * 编译成 wasm），所以 CI 不需要起 docker 也不需要 service 容器。
 */

const migrationsDir = (dialect: 'sqlite' | 'pg'): string[] => {
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

/** 每个 id 都带点难缠的字符：分隔符、引号、中文、emoji、以及一个纯数字长得像别的 id 的。 */
const IDs = ['dose:2026-11-01T09:00:00Z', 'a|b', "quote's", '中文-雌二醇', '🩷-emoji', '0042', '42']

const sameCursor = 1_790_000_000_000

const makeRows = (userId: string) =>
  IDs.map((id, index) => ({
    userId,
    id,
    kind: (index % 2 === 0 ? 'dose' : 'lab') as 'dose' | 'lab',
    // 故意让所有行落在同一个 updatedAt：这是"批量导入撞同一毫秒"的真实形态。
    takenAt: sameCursor - index * 3_600_000,
    rev: index + 1,
    iv: Buffer.from(`iv-${index}`).toString('base64'),
    ct: Buffer.from(`ct-${index}-🩷`).toString('base64'),
    deviceId: 'device-a',
    updatedAt: sameCursor,
  }))

describe('两种方言的迁移都能从零跑通', () => {
  test('sqlite：生成的 .sql 直接吃进 bun:sqlite，六张表都在', () => {
    const db = new Database(':memory:')
    for (const file of migrationsDir('sqlite')) {
      for (const statement of statements(file)) db.exec(statement)
    }
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name)
    expect(tables).toEqual([
      'credentials',
      'invite_codes',
      'records',
      'sessions',
      'storage_kv',
      'users',
    ])
    db.close()
  })

  test('pg：同一批 .sql 能在真 PostgreSQL（wasm）里跑通', async () => {
    const pg = new PGlite()
    for (const file of migrationsDir('pg')) {
      for (const statement of statements(file)) await pg.exec(statement)
    }
    const result = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    expect(result.rows.map((row) => row.table_name)).toEqual([
      'credentials',
      'invite_codes',
      'records',
      'sessions',
      'storage_kv',
      'users',
    ])
    await pg.close()
  })
})

describe('同一份信封数据两边都能原样存回去', () => {
  const userId = 'user-1'
  const rows = makeRows(userId)

  test('sqlite 侧：写进去、读回来，字段逐条相等', () => {
    const db = new Database(':memory:')
    for (const file of migrationsDir('sqlite')) {
      for (const statement of statements(file)) db.exec(statement)
    }
    const client = drizzleSqlite(db)

    client
      .insert(sqliteUsers)
      .values({ id: userId, email: 'a@example.com', createdAt: sameCursor })
      .run()
    client.insert(sqliteRecords).values(rows).run()

    const read = client.select().from(sqliteRecords).orderBy(sqliteRecords.id).all()
    expect(read.length).toBe(rows.length)
    for (const row of rows) {
      const stored = read.find((candidate) => candidate.id === row.id)
      expect(stored).toEqual(row)
    }
    db.close()
  })

  test('pg 侧：同样七行、同样值（难的字符一个都不能变形）', async () => {
    const pg = new PGlite()
    for (const file of migrationsDir('pg')) {
      for (const statement of statements(file)) await pg.exec(statement)
    }
    const client = drizzlePg(pg)

    await client
      .insert(pgUsers)
      .values({ id: userId, email: 'a@example.com', createdAt: sameCursor })
    await client.insert(pgRecords).values(rows)

    const read = await client.select().from(pgRecords).orderBy(pgRecords.id)
    expect(read.length).toBe(rows.length)
    for (const row of rows) {
      expect(read.find((candidate) => candidate.id === row.id)).toEqual(row)
    }
    await pg.close()
  })

  test('同一个 id 在两个用户名下可以共存，同用户名下重复则被拒', async () => {
    const db = new Database(':memory:')
    for (const file of migrationsDir('sqlite')) {
      for (const statement of statements(file)) db.exec(statement)
    }
    const client = drizzleSqlite(db)
    client
      .insert(sqliteUsers)
      .values([
        { id: 'user-1', email: 'a@example.com', createdAt: sameCursor },
        { id: 'user-2', email: 'b@example.com', createdAt: sameCursor },
      ])
      .run()

    const [first] = rows
    expect(first).toBeDefined()
    if (!first) throw new Error('fixture 为空')
    client
      .insert(sqliteRecords)
      .values({ ...first, userId: 'user-1' })
      .run()
    client
      .insert(sqliteRecords)
      .values({ ...first, userId: 'user-2' })
      .run()
    expect(client.select().from(sqliteRecords).all().length).toBe(2)
    expect(() =>
      client
        .insert(sqliteRecords)
        .values({ ...first, userId: 'user-1' })
        .run(),
    ).toThrow()
    db.close()
  })

  test('删除用户会级联删掉他的记录（硬删，不留孤儿密文）', async () => {
    const pg = new PGlite()
    for (const file of migrationsDir('pg')) {
      for (const statement of statements(file)) await pg.exec(statement)
    }
    const client = drizzlePg(pg)
    await client
      .insert(pgUsers)
      .values({ id: userId, email: 'a@example.com', createdAt: sameCursor })
    await client.insert(pgRecords).values(rows)
    await client.delete(pgUsers).where(eq(pgUsers.id, userId))
    expect((await client.select().from(pgRecords)).length).toBe(0)
    await pg.close()
  })
})

describe('复合游标查询走索引', () => {
  test('sqlite 的查询计划用到 records_user_cursor_idx', () => {
    const db = new Database(':memory:')
    for (const file of migrationsDir('sqlite')) {
      for (const statement of statements(file)) db.exec(statement)
    }
    const plan = db
      .query<{ detail: string }, [string, number, string, number]>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM records
         WHERE user_id = ?1 AND (updated_at > ?2 OR (updated_at = ?2 AND id > ?3))
         ORDER BY updated_at, id LIMIT ?4`,
      )
      .all('user-1', sameCursor, '', 200)
      .map((row) => row.detail)
      .join(' | ')
    expect(plan).toContain('records_user_cursor_idx')
    db.close()
  })
})
