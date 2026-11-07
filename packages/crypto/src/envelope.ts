import { DEK_RECOVERY_AAD, DEK_WRAP_AAD, recordAad } from './aad'
import { decodeSealed, encodeSealed, open, seal, utf8 } from './aead'
import { CryptoError } from './errors'
import { deriveKek, KDF_PARAMS, type KdfParams, newSalt } from './kdf'
import { randomBytes } from './random'
import { generateRecoveryPhrase, recoveryToKek } from './recovery'

/**
 * 这一层只做三件事：把 DEK 包起来、把记录包起来、把两者解回来。
 * 它不认识协议类型（`Dose` / `Lab`），也不认识数据库——那些是 `@hrt/protocol` 与 store 的事。
 */
export const DEK_BYTES = 32

export function newDek(): Uint8Array {
  return randomBytes(DEK_BYTES)
}

/** 用 KEK 包 DEK，AAD 域分隔到 `wrapped-by:kek`。 */
export function wrapDekWithKek(dek: Uint8Array, kek: Uint8Array): string {
  return encodeSealed(seal(kek, dek, DEK_WRAP_AAD))
}

export function unwrapDekWithKek(wrapped: string, kek: Uint8Array): Uint8Array {
  const dek = open(kek, decodeSealed(wrapped), DEK_WRAP_AAD)
  if (dek.length !== DEK_BYTES) {
    throw new CryptoError('bad-key-length', `解出的 DEK 应为 ${DEK_BYTES} 字节，得到 ${dek.length}`)
  }
  return dek
}

/** 用恢复短语派生的 KEK2 包 DEK，AAD 域分隔到 `wrapped-by:recovery`。 */
export function wrapDekWithRecovery(dek: Uint8Array, kek2: Uint8Array): string {
  return encodeSealed(seal(kek2, dek, DEK_RECOVERY_AAD))
}

export function unwrapDekWithRecovery(wrapped: string, kek2: Uint8Array): Uint8Array {
  const dek = open(kek2, decodeSealed(wrapped), DEK_RECOVERY_AAD)
  if (dek.length !== DEK_BYTES) {
    throw new CryptoError('bad-key-length', `解出的 DEK 应为 ${DEK_BYTES} 字节，得到 ${dek.length}`)
  }
  return dek
}

export interface RecordMeta {
  id: string
  kind: string
  rev: number
}

export interface SealedRecord extends RecordMeta {
  iv: Uint8Array
  ct: Uint8Array
}

/**
 * 加密一条记录的载荷。载荷是任意 JSON 对象，序列化在这里统一做，避免上层各自
 * `JSON.stringify` 后出现「同一份数据两种字节序」——AAD 里虽然没有载荷，
 * 但 GCM/ChaCha 的密文一旦按不同序列化解出来，去重与比较就全乱了。
 */
export function sealRecord(dek: Uint8Array, meta: RecordMeta, payload: unknown): SealedRecord {
  const plaintext = utf8(JSON.stringify(payload))
  const { iv, ct } = seal(dek, plaintext, recordAad(meta))
  return { ...meta, iv, ct }
}

/**
 * 解开一条记录。任何一侧不匹配（id / kind / rev / 密钥）都会抛 `auth-failed`：
 * 这正是「服务端把 A 的密文挪到 B 的 id 下」被挡住的地方。
 */
export function openRecord(dek: Uint8Array, record: SealedRecord): unknown {
  const signature: RecordMeta = { id: record.id, kind: record.kind, rev: record.rev }
  const plaintext = open(dek, { iv: record.iv, ct: record.ct }, recordAad(signature))
  return JSON.parse(new TextDecoder().decode(plaintext))
}

/** 存储形态：把二进制段换成 `iv|ct` 两段 base64，与 `users` 表里的包裹对象同一种写法。 */
export function encodeRecord(record: SealedRecord): { iv: string; ct: string } {
  const encoded = encodeSealed({ iv: record.iv, ct: record.ct }).split('|')
  const [iv, ct] = encoded as [string, string]
  return { iv, ct }
}

export function decodeRecord(meta: RecordMeta, fields: { iv: string; ct: string }): SealedRecord {
  const { iv, ct } = decodeSealed(`${fields.iv}|${fields.ct}`)
  return { ...meta, iv, ct }
}

export interface UnlockedKeys {
  dek: Uint8Array
  kekSalt: Uint8Array
  recoverySalt: Uint8Array
  kdfParams: KdfParams
}

/**
 * 注册时的「一次成型」：生成 DEK、两段盐、用密码与恢复短语各包一份。
 *
 * 返回短语**只此一次**——调用方负责把它显示出来并让用户抄下；这里不存、不缓存、不重试。
 */
export async function createKeys(
  password: string,
  kdfParams: KdfParams = KDF_PARAMS,
): Promise<{
  keys: UnlockedKeys
  dekWrappedByKek: string
  dekWrappedByRecovery: string
  recoveryPhrase: string
}> {
  const dek = newDek()
  const kekSalt = newSalt()
  const recoverySalt = newSalt()
  const kek = await deriveKek(password, kekSalt, kdfParams)
  const recoveryPhrase = generateRecoveryPhrase()
  const kek2 = await recoveryToKek(recoveryPhrase, recoverySalt, kdfParams)
  return {
    keys: { dek, kekSalt, recoverySalt, kdfParams },
    dekWrappedByKek: wrapDekWithKek(dek, kek),
    dekWrappedByRecovery: wrapDekWithRecovery(dek, kek2),
    recoveryPhrase,
  }
}
