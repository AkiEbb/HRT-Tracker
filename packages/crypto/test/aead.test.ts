import { describe, expect, test } from 'bun:test'
import { CryptoError } from '../src/errors'
import {
  decodeSealed,
  encodeSealed,
  NONCE_BYTES,
  open,
  seal,
  sealWithNonce,
  TAG_BYTES,
  utf8,
} from '../src/index'
import { caught } from './helpers'

/**
 * 预言机：**libsodium** 的 `crypto_aead_xchacha20poly1305_ietf_encrypt`。
 *
 *   key = 0x00..0x1f, nonce = 0x20..0x37, aad = "aad", msg = "hello"
 *   => ct || tag = 753c21a714cee60f3e120febc6389fcaa7db74469e   (5+16 = 21 字节)
 *
 * 用 libsodium 而不是 @noble/ciphers 自己当预言机：后者就是我们的实现。
 */
const REFERENCE_XCHACHA_CT = '753c21a714cee60f3e120febc6389fcaa7db74469e'

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [])

const key0to31 = new Uint8Array(32).map((_, i) => i)
const nonce0x20to0x37 = new Uint8Array(24).map((_, i) => 0x20 + i)

describe('seal / open：与 libsodium 的 XChaCha20-Poly1305 逐字节相同', () => {
  test('同一 key / nonce / aad 下密文（含 tag）与参考实现完全一致', () => {
    const sealed = sealWithNonce(key0to31, nonce0x20to0x37, utf8('hello'), utf8('aad'))
    expect(toHex(sealed.iv)).toBe(toHex(nonce0x20to0x37))
    expect(toHex(sealed.ct)).toBe(REFERENCE_XCHACHA_CT)
    expect(sealed.ct.length).toBe(5 + TAG_BYTES)
  })

  test('反过来也成立：能解开 libsodium 产出的那段密文', () => {
    const reference = { iv: nonce0x20to0x37, ct: fromHex(REFERENCE_XCHACHA_CT) }
    expect(new TextDecoder().decode(open(key0to31, reference, utf8('aad')))).toBe('hello')
  })

  test('生产路径（seal 自取 nonce）仍然是同一个算法：解回来一模一样', () => {
    const sealed = seal(key0to31, utf8('hello'), utf8('aad'))
    expect(sealed.iv.length).toBe(NONCE_BYTES)
    expect(sealed.ct.length).toBe(5 + TAG_BYTES)
    expect(toHex(sealed.ct)).not.toBe(REFERENCE_XCHACHA_CT)
    expect(new TextDecoder().decode(open(key0to31, sealed, utf8('aad')))).toBe('hello')
  })

  test('往返：中文、emoji、长载荷都能原样回来', () => {
    const plaintext = utf8(`${'补佳乐 2mg '.repeat(50)}💊`)
    const sealed = seal(key0to31, plaintext, utf8('hrt:test'))
    expect(open(key0to31, sealed, utf8('hrt:test'))).toEqual(plaintext)
  })
})

describe('认证失败必须是真的失败，不能给半截结果', () => {
  const aad = utf8('hrt:record:v1|1:a|dose|1')
  const sealed = seal(key0to31, utf8('{"doseMG":2}'), aad)

  test('改密文第一个 bit 就抛 auth-failed', () => {
    const tampered = { iv: sealed.iv, ct: Uint8Array.from(sealed.ct) }
    tampered.ct[0] = (tampered.ct[0] as number) ^ 0x01
    expect(caught(() => open(key0to31, tampered, aad))).toMatchObject({ code: 'auth-failed' })
    expect(() => open(key0to31, tampered, aad)).toThrow(/解不开/)
  })

  test('改 tag（密文末尾）也抛 auth-failed', () => {
    const tampered = { iv: sealed.iv, ct: Uint8Array.from(sealed.ct) }
    const last = tampered.ct.length - 1
    tampered.ct[last] = (tampered.ct[last] as number) ^ 0x80
    expect(() => open(key0to31, tampered, aad)).toThrow(CryptoError)
  })

  test('换个 AAD 解不开：这就是"服务端挪行"被挡住的地方', () => {
    const otherAad = utf8('hrt:record:v1|1:a|dose|2')
    expect(() => open(key0to31, sealed, otherAad)).toThrow(/解不开/)
  })

  test('换把钥匙解不开', () => {
    const otherKey = new Uint8Array(32).fill(7)
    expect(caught(() => open(otherKey, sealed, aad))).toMatchObject({ code: 'auth-failed' })
  })

  test('nonce 长度不对时报 bad-nonce-length，而不是含糊的"失败"', () => {
    const shortIv = { iv: sealed.iv.slice(0, 12), ct: sealed.ct }
    expect(caught(() => open(key0to31, shortIv, aad))).toMatchObject({ code: 'bad-nonce-length' })
  })
})

describe('seal 输入约束', () => {
  test('密钥长度不是 32 字节直接拒绝', () => {
    expect(caught(() => seal(new Uint8Array(16), utf8('x'), utf8('a')))).toMatchObject({
      code: 'bad-key-length',
    })
  })

  test('空明文被拒绝（否则"解得开但为空"与"解不开"难以区分）', () => {
    expect(caught(() => seal(key0to31, new Uint8Array(0), utf8('a')))).toMatchObject({
      code: 'empty-plaintext',
    })
  })
})

describe('nonce 与编码', () => {
  test('同一明文同一密钥两次加密得到不同的 iv 与 ct', () => {
    const a = seal(key0to31, utf8('same'), utf8('aad'))
    const b = seal(key0to31, utf8('same'), utf8('aad'))
    expect(toHex(a.iv)).not.toBe(toHex(b.iv))
    expect(toHex(a.ct)).not.toBe(toHex(b.ct))
  })

  test('iv|ct 的 base64 往返无损，且段数/长度不对时报 bad-sealed-format', () => {
    const sealed = seal(key0to31, utf8('round trip'), utf8('aad'))
    const encoded = encodeSealed(sealed)
    expect(encoded.split('|').length).toBe(2)

    const decoded = decodeSealed(encoded)
    expect(toHex(decoded.iv)).toBe(toHex(sealed.iv))
    expect(toHex(decoded.ct)).toBe(toHex(sealed.ct))

    expect(caught(() => decodeSealed(encoded.replace('|', '')))).toMatchObject({
      code: 'bad-sealed-format',
    })
    // 两段都在但长度不对（2 字节的 iv）也要挡住，而不是解到一半才炸。
    expect(caught(() => decodeSealed('AAAA|AAAA'))).toMatchObject({ code: 'bad-sealed-format' })
  })

  test('base64 用的是 btoa/atob，不依赖 Buffer（浏览器里没有 Buffer）', () => {
    expect(typeof btoa).toBe('function')
    expect(typeof atob).toBe('function')
    const encoded = encodeSealed(seal(key0to31, utf8('x'), utf8('a')))
    const [ivPart, ctPart] = encoded.split('|') as [string, string]
    expect(atob(ivPart).length).toBe(NONCE_BYTES)
    expect(atob(ctPart).length).toBe(1 + TAG_BYTES)
  })
})
