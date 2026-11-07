import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { CryptoError } from './errors'
import { assertKey, NONCE_BYTES, randomBytes, TAG_BYTES } from './random'

export interface Sealed {
  /** 24 字节随机 nonce。每次 seal 都是新的，绝不复用。 */
  iv: Uint8Array
  /** ciphertext || tag，tag 是末尾 16 字节。 */
  ct: Uint8Array
}

const encoder = new TextEncoder()

/**
 * 加密。**必须**给 AAD：这条密文属于谁，由 AAD 说清楚，而不是由「存在哪一行」暗示。
 *
 * 空明文被拒绝，因为长度为零的 `ct` 只剩 tag，解出来是空字符串，与「解密失败」在界面上
 * 很难区分；本项目没有合法的空载荷（每条记录至少有一个字段）。
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed {
  assertKey(key)
  if (plaintext.length === 0) {
    throw new CryptoError('empty-plaintext', '不接受空明文：没有合法的载荷是零字节的')
  }
  const iv = randomBytes(NONCE_BYTES)
  const ct = xchacha20poly1305(key, iv, aad).encrypt(plaintext)
  return { iv, ct }
}

/**
 * 给定 nonce 的加密。**只给测试向量用**：生产代码没有理由自己造 nonce，
 * 一旦调用方开始传 nonce，`seal` 那个「每次都新随机」的保证就形同虚设。
 * 它存在只是因为要与 libsodium 逐字节对照—没有指定 nonce，就无从对比。
 */
export function sealWithNonce(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Sealed {
  assertKey(key)
  if (iv.length !== NONCE_BYTES) {
    throw new CryptoError('bad-nonce-length', `nonce 必须是 ${NONCE_BYTES} 字节`)
  }
  if (plaintext.length === 0) {
    throw new CryptoError('empty-plaintext', '不接受空明文：没有合法的载荷是零字节的')
  }
  return { iv: Uint8Array.from(iv), ct: xchacha20poly1305(key, iv, aad).encrypt(plaintext) }
}

/**
 * 解密。任何一处不对（密钥错、AAD 错、密文被改、nonce 长度错）都抛 `auth-failed`，
 * 并且**不返回部分明文**——AEAD 的意义就在这里。
 */
export function open(key: Uint8Array, sealed: Sealed, aad: Uint8Array): Uint8Array {
  assertKey(key)
  if (sealed.iv.length !== NONCE_BYTES) {
    throw new CryptoError(
      'bad-nonce-length',
      `nonce 必须是 ${NONCE_BYTES} 字节，收到 ${sealed.iv.length} 字节`,
    )
  }
  if (sealed.ct.length < TAG_BYTES) {
    throw new CryptoError(
      'auth-failed',
      `密文至少 ${TAG_BYTES} 字节（只有 tag 也不行），收到 ${sealed.ct.length} 字节`,
    )
  }
  try {
    return xchacha20poly1305(key, sealed.iv, aad).decrypt(sealed.ct)
  } catch (cause) {
    throw new CryptoError('auth-failed', '解不开：密钥不匹配，或数据被改过', { cause })
  }
}

/**
 * base64 用平台自带的 `btoa` / `atob`，不用 `Buffer`：这段代码要在浏览器里跑，
 * 而 `Buffer` 在浏览器里不存在（打包时被 polyfill 掉更糟，会悄悄多出几百 KB）。
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 存储形态：`base64(iv) + '|' + base64(ct||tag)`。
 *
 * tag 已经在内，**不要再单独切一段 tag**——两份「tag 在哪」的约定迟早会打架。
 */
export function encodeSealed(sealed: Sealed): string {
  return `${toBase64(sealed.iv)}|${toBase64(sealed.ct)}`
}

export function decodeSealed(text: string): Sealed {
  const parts = text.split('|')
  if (parts.length !== 2) {
    throw new CryptoError('bad-sealed-format', `密文对象必须是 iv|ct 两段，收到 ${parts.length} 段`)
  }
  const [ivText, ctText] = parts as [string, string]
  const iv = fromBase64(ivText)
  const ct = fromBase64(ctText)
  if (iv.length !== NONCE_BYTES) {
    throw new CryptoError('bad-sealed-format', `iv 段必须是 ${NONCE_BYTES} 字节，收到 ${iv.length}`)
  }
  if (ct.length < TAG_BYTES) {
    throw new CryptoError('bad-sealed-format', `ct 段至少要 ${TAG_BYTES} 字节，收到 ${ct.length}`)
  }
  return { iv, ct }
}

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}
