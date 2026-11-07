/**
 * 加密层的错误只有两类：**输入不合法**（调用方写错了）与**认证失败**（有人动过密文，
 * 或密钥不对）。分开是因为界面要说人话：「安全密码不对」与「数据损坏，别再往库里写」
 * 是两句完全不同的话，混成一个 Error 会让前者变成惊吓。
 */
export type CryptoErrorCode =
  | 'empty-password'
  | 'bad-key-length'
  | 'bad-nonce-length'
  | 'bad-sealed-format'
  | 'empty-plaintext'
  | 'auth-failed'
  | 'bad-mnemonic'

export class CryptoError extends Error {
  override readonly name = 'CryptoError'
  readonly code: CryptoErrorCode

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
