import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { CryptoError } from './errors'
import { deriveKek, KDF_PARAMS, type KdfParams } from './kdf'
import { randomBytes } from './random'

/**
 * 恢复短语是「第二把钥匙」（DESIGN §5.1 不变量 3）：它能包裹/解包 DEK，
 * **不是登录凭据**。所以这里只有词表与派生，没有「用短语登录」这种东西。
 *
 * 用 BIP39 而不是自己发明 24 个词：2048 词表 + 8 bit 校验和，写错一个词能被指出来，
 * 而不是在三个月后「恢复失败，原因不明」。用户也可能已经在别处抄过 BIP39 备份。
 */
export const RECOVERY_WORDS = 24
/** BIP39 的 24 词对应 256 bit 熵。 */
const ENTROPY_BYTES = 32

export function generateRecoveryPhrase(): string {
  return entropyToMnemonic(randomBytes(ENTROPY_BYTES), wordlist)
}

/**
 * 归一化到 BIP39 的规范形式：小写、单空格、NFKD。
 *
 * 用户从纸上抄回来时会有大小写、全角空格、换行、首尾空白；这些都是**抄写噪声**，
 * 不是密码内容，所以与安全密码不同，这里必须宽松。词与词之间的多空格也要折叠，
 * 否则「抄对了但多按了一个空格」会被 argon2 当成另一个密码，直接解不开。
 */
export function normalizePhrase(phrase: string): string {
  return phrase
    .normalize('NFKD')
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .join(' ')
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  const normalized = normalizePhrase(phrase)
  return normalized.split(' ').length === RECOVERY_WORDS && validateMnemonic(normalized, wordlist)
}

/**
 * 短语 → KEK2，走与安全密码相同的 argon2id 参数。
 *
 * 先校验再派生：一个拼错的词应该立刻报「短语不合法」，而不是算完 64 MiB 的 argon2
 * 之后再拿一个必然错误的密钥去解 DEK，最后报「认证失败」——那会让用户以为密文坏了。
 */
export async function recoveryToKek(
  phrase: string,
  salt: Uint8Array,
  params: KdfParams = KDF_PARAMS,
): Promise<Uint8Array> {
  const normalized = normalizePhrase(phrase)
  if (!isValidRecoveryPhrase(normalized)) {
    throw new CryptoError(
      'bad-mnemonic',
      `恢复短语必须是 ${RECOVERY_WORDS} 个合法单词，校验和不通过`,
    )
  }
  return deriveKek(normalized, salt, params)
}

/** 只做「短语 ↔ 熵」的往返，给测试与「显示短语」界面用。 */
export function phraseToEntropy(phrase: string): Uint8Array {
  const normalized = normalizePhrase(phrase)
  if (!isValidRecoveryPhrase(normalized)) {
    throw new CryptoError('bad-mnemonic', '恢复短语不合法')
  }
  return mnemonicToEntropy(normalized, wordlist)
}
