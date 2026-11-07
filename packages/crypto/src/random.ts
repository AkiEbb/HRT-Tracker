import { CryptoError } from './errors'

/**
 * 所有长度都是**字节**。
 *
 * 32 字节密钥是 XChaCha20 的固定要求；24 字节 nonce 是 XChaCha 相对 IETF ChaCha 的
 * 唯一优势所在（192-bit nonce 可以纯随机，不必计数器，也就不需要处理「计数器回绕导致
 * nonce 复用」这种灾难）。
 */
export const KEY_BYTES = 32
export const NONCE_BYTES = 24
export const TAG_BYTES = 16

/**
 * 只信任平台 CSPRNG。浏览器、Bun、Workers、Node ≥ 19 都实现了 `crypto.getRandomValues`，
 * 所以这里不需要回落到 `Math.random`（回落是这类模块最常见的自毁方式）。
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`randomBytes 需要正整数长度，收到 ${length}`)
  }
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('bad-key-length', `密钥必须是 ${KEY_BYTES} 字节，收到 ${key.length} 字节`)
  }
}
