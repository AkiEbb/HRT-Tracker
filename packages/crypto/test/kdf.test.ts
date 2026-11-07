import { describe, expect, test } from 'bun:test'
import { CryptoError } from '../src/errors'
import { deriveKek, KDF_PARAMS, type KdfParams, newSalt, SALT_BYTES } from '../src/kdf'

/**
 * 预言机：**argon2 参考实现**（phc-winner-argon2 的 `argon2id_hash_raw`）算出来的值。
 * 不是拿我们的封装跟我们的封装比。
 *
 *   argon2id_hash_raw(t=3, m=65536 KiB, p=1,
 *                    pwd="correct horse battery staple", salt=0x00..0x0f, 32 bytes)
 *   = 0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e
 */
const REFERENCE_ARGON2ID = '0d1a3c6523c8f06e4e0af9c515aa5b5448cfebd6838f2d52c3d8b6ef8ddc3c2e'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const salt0to15 = new Uint8Array(16).map((_, i) => i)

describe('deriveKek：与 argon2 参考实现逐字节相同', () => {
  test('默认参数下（m=64MiB, t=3, p=1）算出的 32 字节与参考实现一致', async () => {
    const kek = await deriveKek('correct horse battery staple', salt0to15)
    expect(toHex(kek)).toBe(REFERENCE_ARGON2ID)
  })

  test('参数是数据不是常量：同一口令换盐、换参数都得到不同密钥', async () => {
    const weak: KdfParams = { memorySizeKiB: 8, iterations: 1, parallelism: 1 }
    const a = await deriveKek('same password', salt0to15, weak)
    const b = await deriveKek('same password', new Uint8Array(16).fill(9), weak)
    const c = await deriveKek('same password', salt0to15, { ...weak, iterations: 2 })
    expect(toHex(a)).not.toBe(toHex(b))
    expect(toHex(a)).not.toBe(toHex(c))
  })

  test('NFKC 归一化：全角字符与组合字符算同一个口令', async () => {
    const weak: KdfParams = { memorySizeKiB: 8, iterations: 1, parallelism: 1 }
    // U+FF21 全角 A 与 U+0041 在 NFKC 下是同一个字符；
    // "e" + U+0301（组合尖音）与 U+00E9 同理。
    const fullWidth = await deriveKek('\uFF21bc', salt0to15, weak)
    const ascii = await deriveKek('Abc', salt0to15, weak)
    const combining = await deriveKek('e\u0301', salt0to15, weak)
    const precomposed = await deriveKek('\u00E9', salt0to15, weak)
    expect(toHex(fullWidth)).toBe(toHex(ascii))
    expect(toHex(combining)).toBe(toHex(precomposed))
  })

  test('归一化不吃掉首尾空格：那是密码的一部分', async () => {
    const weak: KdfParams = { memorySizeKiB: 8, iterations: 1, parallelism: 1 }
    const withSpace = await deriveKek(' pass ', salt0to15, weak)
    const trimmed = await deriveKek('pass', salt0to15, weak)
    expect(toHex(withSpace)).not.toBe(toHex(trimmed))
  })

  test('空口令抛 empty-password，而不是算出一个"空密码的密钥"', async () => {
    await expect(deriveKek('', salt0to15)).rejects.toMatchObject({ code: 'empty-password' })
    await expect(deriveKek('', salt0to15)).rejects.toBeInstanceOf(CryptoError)
  })

  test('盐太短会被拒绝（8 字节以下）', async () => {
    await expect(deriveKek('x', new Uint8Array(4))).rejects.toBeInstanceOf(RangeError)
  })
})

describe('newSalt：每次都是新的，长度固定', () => {
  test('长度等于 SALT_BYTES，且两次不重复', () => {
    const a = newSalt()
    const b = newSalt()
    expect(a.length).toBe(SALT_BYTES)
    expect(toHex(a)).not.toBe(toHex(b))
  })

  test('默认参数写死在 64 MiB（单位是 KiB，不是 MB）', () => {
    expect(KDF_PARAMS.memorySizeKiB).toBe(65536)
    expect(KDF_PARAMS.iterations).toBe(3)
    expect(KDF_PARAMS.parallelism).toBe(1)
  })
})
