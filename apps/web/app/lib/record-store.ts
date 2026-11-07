import type { Dose, Lab } from '@hrt/protocol'

/**
 * 本地记录存储（v0.1：IndexedDB，明文）。
 *
 * 为什么先把接口立起来：v0.2 要加账号与真正的 E2EE，那时候存进去的必须是
 * `Envelope{iv, ct}`。只要页面只通过这个接口读写，加密层就是一次实现替换 +
 * 一条迁移，而不是把每个页面的读取路径重写一遍。
 *
 * 形状上刻意保持「按 kind 分表」：`dose` 与 `lab` 是两种完全不同的记录，
 * 用一个泛型表加 `kind` 字段只会让每次读都要在类型上做一次收窄。
 */

export type RecordKind = 'dose' | 'lab'

interface KindMap {
  dose: Dose
  lab: Lab
}

export interface RecordStore {
  list<K extends RecordKind>(kind: K): Promise<KindMap[K][]>
  put<K extends RecordKind>(kind: K, row: KindMap[K]): Promise<void>
  delete(kind: RecordKind, id: string): Promise<void>
  clear(): Promise<void>
}

/** 浏览器之外（SSR / 单测）没有 IndexedDB。调用方必须显式处理，而不是拿到一个空库。 */
export class StoreUnavailableError extends Error {
  constructor() {
    super('记录存储只在浏览器里可用')
    this.name = 'StoreUnavailableError'
  }
}

const DB_NAME = 'hrt-tracker'
const DB_VERSION = 1
const TAKEN_AT = 'takenAt'

export const hasIndexedDb = (): boolean => typeof indexedDB !== 'undefined'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const kind of ['dose', 'lab'] as const) {
        if (db.objectStoreNames.contains(kind)) continue
        const store = db.createObjectStore(kind, { keyPath: 'id' })
        // 曲线只需要「按时间取一段」，所以排序索引是唯一必要的索引。
        store.createIndex(TAKEN_AT, 'takenAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
    request.onblocked = () => reject(new Error('本地数据库被另一个标签页占着，请关掉它再试'))
  })
}

function run<T>(
  db: IDBDatabase,
  kind: RecordKind,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(kind, mode)
    let result: T | undefined
    tx.onerror = () => reject(tx.error ?? new Error('本地数据库操作失败'))
    tx.onabort = () => reject(tx.error ?? new Error('本地数据库事务被中止'))
    // 写入也要等事务 oncomplete：拿到 onsuccess 不等于已经落盘。
    tx.oncomplete = () => resolve(result as T)
    const request = body(tx.objectStore(kind))
    if (request !== null) {
      request.onsuccess = () => {
        result = request.result as T
      }
    }
  })
}

export function createIdbRecordStore(): RecordStore {
  if (!hasIndexedDb()) throw new StoreUnavailableError()

  let opening: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => {
    opening ??= openDb()
    return opening
  }

  const list = async <K extends RecordKind>(kind: K): Promise<KindMap[K][]> => {
    const database = await db()
    const rows = await run<KindMap[K][]>(database, kind, 'readonly', (store) =>
      store.index(TAKEN_AT).getAll(),
    )
    return rows
  }

  return {
    list,
    async put(kind, row) {
      const database = await db()
      await run(database, kind, 'readwrite', (store) => store.put(row))
    },
    async delete(kind, id) {
      const database = await db()
      await run(database, kind, 'readwrite', (store) => store.delete(id))
    },
    async clear() {
      const database = await db()
      await run(database, 'dose', 'readwrite', (store) => store.clear())
      await run(database, 'lab', 'readwrite', (store) => store.clear())
    },
  }
}
