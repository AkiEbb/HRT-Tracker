import { describe, expect, test } from 'bun:test'
import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core'
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core'
import * as pgSchema from '../src/schema.pg'
import * as sqliteSchema from '../src/schema.sqlite'

/**
 * 两份 schema 是手写的，所以必须有一个东西替我们记住"两边都要改"。
 *
 * 这个测试只比**逻辑形状**（表名、列名、可空性、是否主键），不比物理类型：
 * `integer` vs `bigint` 的差别是刻意的，而且写在两个文件的注释里。
 */

type Shape = {
  name: string
  columns: { name: string; notNull: boolean }[]
  /** 主键列，按名字排序；复合主键摊平成一个集合（这里没有多组复合主键的情况）。 */
  pk: string[]
}

const toShape = (
  name: string,
  columns: { name: string; notNull: boolean; primary: boolean }[],
  primaryKeys: { columns: { name: string }[] }[],
): Shape => ({
  name,
  columns: columns
    .map((column) => ({ name: column.name, notNull: column.notNull }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  pk: [
    ...columns.filter((column) => column.primary).map((column) => column.name),
    ...primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
  ].sort((a, b) => a.localeCompare(b)),
})

const sqliteTables = (): Shape[] =>
  Object.values(sqliteSchema)
    .filter((value) => typeof value === 'object')
    .map((table) => {
      const config = getSqliteTableConfig(table as Parameters<typeof getSqliteTableConfig>[0])
      return toShape(config.name, config.columns, config.primaryKeys)
    })
    .sort((a, b) => a.name.localeCompare(b.name))

const pgTables = (): Shape[] =>
  Object.values(pgSchema)
    .filter((value) => typeof value === 'object')
    .map((table) => {
      const config = getPgTableConfig(table as Parameters<typeof getPgTableConfig>[0])
      return toShape(config.name, config.columns, config.primaryKeys)
    })
    .sort((a, b) => a.name.localeCompare(b.name))

describe('两种方言是同一份逻辑 schema', () => {
  test('表名集合相同', () => {
    expect(sqliteTables().map((t) => t.name)).toEqual(pgTables().map((t) => t.name))
  })

  test('每张表的列名、可空性、主键归属都一样', () => {
    const sqlite = sqliteTables()
    const pg = pgTables()
    for (const left of sqlite) {
      const right = pg.find((t) => t.name === left.name)
      expect(right).toBeDefined()
      expect(right?.columns).toEqual(left.columns)
      expect(right?.pk).toEqual(left.pk)
    }
  })

  test('六张表一张都没少（少一张说明有人只改了一边）', () => {
    expect(sqliteTables().map((t) => t.name)).toEqual([
      'credentials',
      'invite_codes',
      'records',
      'sessions',
      'storage_kv',
      'users',
    ])
  })

  test('records 的复合主键是 (user_id, id)：不同用户撞同一个 id 不该互相覆盖', () => {
    const records = sqliteTables().find((t) => t.name === 'records')
    expect(records?.pk).toEqual(['id', 'user_id'])
  })
})
