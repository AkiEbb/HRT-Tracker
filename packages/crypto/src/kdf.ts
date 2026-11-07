import { argon2id } from 'hash-wasm'
import { CryptoError } from './errors'
import { assertKey, randomBytes } from './random'

/**
 * KDF 参数存进 `users.kdf_params`（DESIGN §6.1），所以它是**数据**，不是常量：
 * 参数将来只会变强，老账号必须能按自己那份参数解开。
 *
 * `memorySizeKiB` 而不是 `memorySizeMB`：hash-wasm（同 argon2 参考实现）的单位是 KiB，
 * 用 MB 会写出一个看起来 64、实际 64 KiB 的配置——这类「单位差 1024 倍」的 bug 在
 * 安全参数上不会报错，只会把强度悄悄降到 1/1024。
 */
export interface KdfParams {
  memorySizeKiB: number
  iterations: number
  parallelism: number
}

export const KDF_PARAMS: KdfParams = {
  memorySizeKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
}

/** salt 长度。16 字节是 argon2 的推荐值，也是 `users.kdf_salt_a/b` 的列宽。 */
export const SALT_BYTES = 16

/**
 * 口令 → KEK。
 *
 * 口令先做 **NFKC 归一化**：同一个密码在 macOS 输入法与 Windows 输入法下可能产生
 * 不同码点的「同一个字」（全角/半角和组合字符），不归一化就会出现「我明明输对了」。
 * 归一化**不 trim**：首尾空格是用户密码的一部分，悄悄吃掉它同样是「输对了却进不去」。
 */
export async function deriveKek(
  password: string,
  salt: Uint8Array,
  params: KdfParams = KDF_PARAMS,
): Promise<Uint8Array> {
  const normalized = password.normalize('NFKC')
  if (normalized.length === 0) {
    throw new CryptoError('empty-password', '安全密码不能为空')
  }
  if (salt.length < 8) {
    throw new RangeError(`salt 至少 8 字节，收到 ${salt.length}`)
  }
  if (params.memorySizeKiB < 8 || params.iterations < 1 || params.parallelism < 1) {
    throw new RangeError(`KDF 参数不合法：${JSON.stringify(params)}`)
  }
  const key = await argon2id({
    password: normalized,
    salt,
    iterations: params.iterations,
    memorySize: params.memorySizeKiB,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })
  // hash-wasm 声明返回 Uint8Array，但它的返回类型由 outputType 决定，
  // 这里顺手断言一次，免得哪天换库后静默变成字符串。
  assertKey(key)
  return key
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES)
}
