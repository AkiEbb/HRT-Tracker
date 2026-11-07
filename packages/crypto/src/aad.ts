import { utf8 } from './aead'
import { CryptoError } from './errors'

/**
 * AAD 是「这条密文属于谁」的唯一声明。这里的取值必须与 DESIGN §5.1 的不变量 4 一致：
 * AAD 绑定 `id | kind | rev`，于是服务端把 A 的密文挪到 B 的 id 下、或者回放旧 rev，
 * 客户端一解就失败。
 *
 * 拼接用**长度前缀**而不是裸分隔符。`'a|b'+'|'+'dose'` 与 `'a'+'|'+'b|dose'` 用裸 `|`
 * 拼出来是同一个字符串，而 id 是客户端生成、将来可能来自导入文件的自由字符串——
 * 这正是一个「看起来安全、实际可撞」的编码。长度前缀把它堵死。
 */
const RECORD_PREFIX = 'hrt:record:v1'

export interface RecordAadInput {
  id: string
  kind: string
  rev: number
}

export function recordAad({ id, kind, rev }: RecordAadInput): Uint8Array {
  if (!Number.isSafeInteger(rev) || rev < 0) {
    throw new RangeError(`rev 必须是非负整数，收到 ${rev}`)
  }
  if (kind === '' || kind.includes('|')) {
    throw new RangeError(`kind 不能为空也不能含 "|"，收到 ${JSON.stringify(kind)}`)
  }
  const idBytes = utf8(id)
  return utf8(`${RECORD_PREFIX}|${idBytes.length}:${id}|${kind}|${rev}`)
}

/**
 * DEK 包裹用的 AAD。域分隔（`dek` / `recovery` / `share`）不是装饰：
 * 少了它，恢复短语包出来的那段密文可以被搬到 `dek_wrapped_kek` 列下，
 * 服务端就能把「用恢复短语解」降级成「用密码解」。
 */
export const DEK_WRAP_AAD = utf8('hrt:dek:v1|wrapped-by:kek')
export const DEK_RECOVERY_AAD = utf8('hrt:dek:v1|wrapped-by:recovery')
export const SHARE_KEY_AAD = utf8('hrt:share:v1|snapshot-key')

/** 解出来的 JSON 不是对象时，报的是加密层的格式错误，而不是让调用方看见 undefined。 */
export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (cause) {
    throw new CryptoError('bad-sealed-format', '解开后的载荷不是 JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CryptoError('bad-sealed-format', '解开后的载荷必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}
