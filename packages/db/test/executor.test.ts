import { describe, expect, test } from 'bun:test'
import { createExecutor } from '../src/store/executor'
import type { RawRow } from '../src/store/types'

/**
 * 三种返回形状各喂一次。
 *
 * 这不是在测 mock——归一化函数的作用对象**就是**这些形状本身（数组 / `{rows}` /
 * `{results}`），所以拿真形状喂它是唯一能测的东西。真正跑通 SQL 的是 `store.test.ts`
 * 里那两个真数据库。
 */

const query = undefined as never
const rows: RawRow[] = [{ id: 'a' }]

describe('createExecutor 归一化', () => {
  test('bun:sqlite 的 all() 返回行数组', async () => {
    const exec = createExecutor({ all: async () => rows })
    expect(await exec.run(query)).toEqual(rows)
  })

  test('pg / PGlite 的 execute() 返回 { rows }', async () => {
    const exec = createExecutor({ execute: async () => ({ rows, rowCount: 1 }) })
    expect(await exec.run(query)).toEqual(rows)
  })

  test('D1 的 execute() 返回 { results }', async () => {
    const exec = createExecutor({ execute: async () => ({ results: rows, success: true }) })
    expect(await exec.run(query)).toEqual(rows)
  })

  test('同时有 execute 和 all 时优先 execute（pg 侧的形状）', async () => {
    const exec = createExecutor({
      execute: async () => ({ rows }),
      all: async () => [],
    })
    expect(await exec.run(query)).toEqual(rows)
  })

  test('空结果集归一成空数组，不抛错', async () => {
    const exec = createExecutor({ execute: async () => ({ rows: [] }) })
    expect(await exec.run(query)).toEqual([])
  })

  test('认不出的形状要吵，而不是静默返回空（静默返回空会让所有写操作"成功"）', async () => {
    const exec = createExecutor({ execute: async () => ({ ok: 1 }) })
    await expect(exec.run(query)).rejects.toThrow(TypeError)
  })

  test('实例既没有 execute 也没有 all 时直接说清楚', async () => {
    const exec = createExecutor({})
    await expect(exec.run(query)).rejects.toThrow(/execute\(\) 也没有 all\(\)/)
  })
})
