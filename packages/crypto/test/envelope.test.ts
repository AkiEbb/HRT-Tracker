import { describe, expect, test } from 'bun:test'
import { DEK_RECOVERY_AAD, DEK_WRAP_AAD, recordAad } from '../src/aad'
import {
  createKeys,
  decodeRecord,
  encodeRecord,
  newDek,
  openRecord,
  sealRecord,
  unwrapDekWithKek,
  unwrapDekWithRecovery,
  wrapDekWithKek,
  wrapDekWithRecovery,
} from '../src/envelope'
import { CryptoError } from '../src/errors'
import { deriveKek } from '../src/kdf'
import { recoveryToKek } from '../src/recovery'
import { caught } from './helpers'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe('recordAad：id 里带 "|" 也不能撞', () => {
  test('长度前缀让 "a|b" + "dose" 与 "a" + "dose" 不同（id 里带分隔符也不蹭车）', () => {
    const first = toHex(recordAad({ id: 'a|b', kind: 'dose', rev: 1 }))
    const second = toHex(recordAad({ id: 'a', kind: 'dose', rev: 1 }))
    const third = toHex(recordAad({ id: 'a|b', kind: 'dose', rev: 2 }))
    const fourth = toHex(recordAad({ id: 'a|b', kind: 'lab', rev: 1 }))
    expect(first).not.toBe(second)
    expect(first).not.toBe(third)
    expect(first).not.toBe(fourth)
  })

  test('kind 里的 "|" 直接拒绝，于是"字段互换却不撞"这种构造根本不存在', () => {
    // 裸 "|" 拼接下 id="ab", kind="dose" 与 id="a", kind="b|dose" 会拼出同样的字符串。
    // 本实现用两道锁挡住它：kind 不允许含 "|"（结构性），id 走长度前缀（编码上）。
    expect(caught(() => recordAad({ id: 'a', kind: 'b|dose', rev: 1 }))).toBeInstanceOf(RangeError)

    // id 自带分隔符时，长度前缀仍然把它与后面的 kind/rev 分得开：
    //   hrt:record:v1|1:a|dose|1     vs     hrt:record:v1|9:a|dose|1|dose|1
    const plain = toHex(recordAad({ id: 'a', kind: 'dose', rev: 1 }))
    const tricky = toHex(recordAad({ id: 'a|dose|1', kind: 'dose', rev: 1 }))
    expect(plain).not.toBe(tricky)
  })

  test('kind 为空或含 "|" 直接拒绝，rev 必须是非负整数', () => {
    expect(() => recordAad({ id: 'a', kind: '', rev: 1 })).toThrow(RangeError)
    expect(() => recordAad({ id: 'a', kind: 'do|se', rev: 1 })).toThrow(RangeError)
    expect(() => recordAad({ id: 'a', kind: 'dose', rev: -1 })).toThrow(RangeError)
    expect(() => recordAad({ id: 'a', kind: 'dose', rev: 1.5 })).toThrow(RangeError)
  })
})

describe('记录加密：AAD 绑死 id / kind / rev', () => {
  const dek = new Uint8Array(32).fill(5)
  const payload = { doseMG: 2, compound: 'E2', route: 'oral' }

  test('往返得到同一份载荷', () => {
    const sealed = sealRecord(dek, { id: 'id-1', kind: 'dose', rev: 1 }, payload)
    expect(openRecord(dek, sealed)).toEqual(payload)
  })

  test('把密文挪到别的 id 下解不开（服务端挪行）', () => {
    const sealed = sealRecord(dek, { id: 'id-1', kind: 'dose', rev: 1 }, payload)
    const moved = { ...sealed, id: 'id-2' }
    expect(caught(() => openRecord(dek, moved))).toMatchObject({ code: 'auth-failed' })
  })

  test('回放旧 rev 解不开（服务端回滚）', () => {
    const sealed = sealRecord(dek, { id: 'id-1', kind: 'dose', rev: 3 }, payload)
    const replayed = { ...sealed, rev: 2 }
    expect(caught(() => openRecord(dek, replayed))).toMatchObject({ code: 'auth-failed' })
  })

  test('kind 被改（dose 冒充 lab）解不开', () => {
    const sealed = sealRecord(dek, { id: 'id-1', kind: 'dose', rev: 1 }, payload)
    expect(caught(() => openRecord(dek, { ...sealed, kind: 'lab' }))).toMatchObject({
      code: 'auth-failed',
    })
  })

  test('存储形态 iv|ct 往返无损', () => {
    const sealed = sealRecord(dek, { id: 'id-1', kind: 'dose', rev: 1 }, payload)
    const fields = encodeRecord(sealed)
    const back = decodeRecord({ id: 'id-1', kind: 'dose', rev: 1 }, fields)
    expect(toHex(back.iv)).toBe(toHex(sealed.iv))
    expect(toHex(back.ct)).toBe(toHex(sealed.ct))
    expect(openRecord(dek, back)).toEqual(payload)
  })
})

describe('DEK 包裹：域分隔不是装饰', () => {
  const dek = new Uint8Array(32).fill(9)
  const kek = new Uint8Array(32).fill(11)

  test('用 KEK 包裹再用 KEK 解开，拿到同一把 DEK', () => {
    const wrapped = wrapDekWithKek(dek, kek)
    expect(toHex(unwrapDekWithKek(wrapped, kek))).toBe(toHex(dek))
  })

  test('被恢复短语包的那段密文不能塞进 dek_wrapped_kek 列', () => {
    const wrappedByRecovery = wrapDekWithRecovery(dek, kek)
    expect(caught(() => unwrapDekWithKek(wrappedByRecovery, kek))).toMatchObject({
      code: 'auth-failed',
    })
  })

  test('反过来也不成立：KEK 包的那段不能当恢复包用', () => {
    const wrappedByKek = wrapDekWithKek(dek, kek)
    expect(caught(() => unwrapDekWithRecovery(wrappedByKek, kek))).toMatchObject({
      code: 'auth-failed',
    })
  })

  test('两个域的 AAD 本身就不一样', () => {
    expect(toHex(DEK_WRAP_AAD)).not.toBe(toHex(DEK_RECOVERY_AAD))
  })

  test('wrong KEK 解不开', () => {
    const wrapped = wrapDekWithKek(dek, kek)
    expect(caught(() => unwrapDekWithKek(wrapped, new Uint8Array(32).fill(12)))).toMatchObject({
      code: 'auth-failed',
    })
  })

  test('解出的长度不是 32 字节时报 bad-key-length（而不是当密钥用下去）', () => {
    const shortDek = new Uint8Array(16).fill(1)
    const wrapped = wrapDekWithRecovery(shortDek, kek)
    expect(caught(() => unwrapDekWithRecovery(wrapped, kek))).toMatchObject({
      code: 'bad-key-length',
    })
  })
})

describe('createKeys：注册时的一次成型', () => {
  const weak = { memorySizeKiB: 8, iterations: 1, parallelism: 1 }

  test('两把钥匙都能解出同一把 DEK；短语是 24 词；盐互不相同', async () => {
    const created = await createKeys('correct horse battery staple', weak)
    expect(created.recoveryPhrase.split(' ').length).toBe(24)

    const kek = await deriveKek('correct horse battery staple', created.keys.kekSalt, weak)
    const kek2 = await recoveryToKek(created.recoveryPhrase, created.keys.recoverySalt, weak)
    const fromKek = unwrapDekWithKek(created.dekWrappedByKek, kek)
    const fromRecovery = unwrapDekWithRecovery(created.dekWrappedByRecovery, kek2)

    expect(toHex(fromKek)).toBe(toHex(created.keys.dek))
    expect(toHex(fromRecovery)).toBe(toHex(created.keys.dek))
    expect(toHex(created.keys.kekSalt)).not.toBe(toHex(created.keys.recoverySalt))
  })

  test('两次注册得到不同 DEK 与不同短语', async () => {
    const a = await createKeys('same password', weak)
    const b = await createKeys('same password', weak)
    expect(toHex(a.keys.dek)).not.toBe(toHex(b.keys.dek))
    expect(a.recoveryPhrase).not.toBe(b.recoveryPhrase)
  })

  test('newDek 就是 32 字节随机', () => {
    const a = newDek()
    expect(a.length).toBe(32)
    expect(toHex(a)).not.toBe(toHex(newDek()))
  })
})

describe('载荷必须能往返成 JSON 对象', () => {
  test('数组与标量在 openRecord 里也是合法 JSON（约束放在调用方）', () => {
    const dek = new Uint8Array(32).fill(1)
    const sealed = sealRecord(dek, { id: 'x', kind: 'lab', rev: 1 }, [1, 2, 3])
    expect(openRecord(dek, sealed)).toEqual([1, 2, 3])
  })

  test('密文被截断时抛的是 CryptoError，不是 JSON 解析错误', () => {
    const dek = new Uint8Array(32).fill(1)
    const sealed = sealRecord(dek, { id: 'x', kind: 'lab', rev: 1 }, { a: 1 })
    const truncated = { ...sealed, ct: sealed.ct.slice(0, 8) }
    expect(() => openRecord(dek, truncated)).toThrow(CryptoError)
  })
})
