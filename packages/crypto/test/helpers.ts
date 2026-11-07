import type { CryptoError, CryptoErrorCode } from '../src/errors'

/**
 * 断言「同步抛错」的统一写法。
 *
 * `expect(fn).toThrow(...)` 只能匹配字符串 / 正则 / 类，匹配不到 `code` 字段；
 * 而 `code` 恰恰是本项目要区分的东西（`auth-failed` 与 `bad-mnemonic` 在界面上是两句话）。
 * 所以这里自己接住错误，再用 `toMatchObject` 断言字段。
 */
export function caught(fn: () => unknown): CryptoError & { code: CryptoErrorCode } {
  try {
    fn()
  } catch (error) {
    return error as CryptoError & { code: CryptoErrorCode }
  }
  throw new Error('期望这里抛错，但它正常返回了')
}
