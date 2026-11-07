import type { SQL } from 'drizzle-orm'
import type { Executor, RawRow } from './types'

/**
 * 把任意 drizzle 实例收成一个 `Executor`。
 *
 * 两句实话：
 *
 * 1. **方法名不统一。** drizzle 的 `node-postgres` / `pglite` 实例有 `execute()`，
 *    而 sqlite 系（`bun-sqlite`、`better-sqlite3`、`d1`）用的是 `all()`（`execute` 在
 *    这些 dialect 上不存在）。所以按能力探测，而不是按驱动名分支。
 * 2. **返回形状也不统一。** `bun:sqlite` 给行数组，`pg`/PGlite 给 `{ rows }`，D1 给
 *    `{ results }`。同样按形状归一化——我们拿到的是 drizzle 包过一层的东西，
 *    靠 `dialect` 字符串推断它内部返回到哪一层是猜，形状判断至少是自证的。
 *
 * 三种形状都有测试分别喂过（`executor.test.ts`）。
 */
export interface DrizzleLike {
  // 同步与异步都要接受：`bun:sqlite` / `better-sqlite3` 的 `all()` 是同步返回的，
  // `pg` / `pglite` / D1 的 `execute()` 是 Promise。await 一个非 Promise 是合法的，
  // 所以这里放宽到 unknown，而不是给每个驱动写一个适配器。
  execute?(query: SQL): unknown
  all?(query: SQL): unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function call(db: DrizzleLike, query: SQL): unknown {
  if (typeof db.execute === 'function') return db.execute(query)
  if (typeof db.all === 'function') return db.all(query)
  throw new TypeError('这个 drizzle 实例既没有 execute() 也没有 all()，无法执行 SQL')
}

export function createExecutor(db: DrizzleLike): Executor {
  return {
    async run(query) {
      const raw = await call(db, query)
      if (Array.isArray(raw)) return raw as RawRow[]
      if (isObject(raw)) {
        if (Array.isArray(raw.results)) return raw.results as RawRow[]
        if (Array.isArray(raw.rows)) return raw.rows as RawRow[]
      }
      throw new TypeError(`无法识别的 SQL 返回形状：${Object.prototype.toString.call(raw)}`)
    },
  }
}
