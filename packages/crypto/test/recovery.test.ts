import { describe, expect, test } from 'bun:test'
import { CryptoError } from '../src/errors'
import {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  normalizePhrase,
  phraseToEntropy,
  RECOVERY_WORDS,
  recoveryToKek,
} from '../src/recovery'
import vectors from './fixtures/bip39-24-vectors.json'
import { caught } from './helpers'

/**
 * 预言机：**BIP39 官方测试向量**（trezor/python-mnemonic 的 `vectors.json`，
 * 这里只取 256 bit 熵那一组，即 24 词）。文件原样放在 `test/fixtures/`。
 *
 * 用自己的词表、自己的实现互相验证毫无意义——那样的测试在任何实现下都会绿。
 */
const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const vectors24 = (vectors as [string, string][]).filter(([entropy]) => entropy.length === 64)

describe('BIP39 官方向量：24 词的熵 ↔ 短语必须双向对上', () => {
  test('官方文件里确实有 8 组 24 词向量（少于这个数说明夹具取错了）', () => {
    expect(vectors24.length).toBe(8)
    for (const [, mnemonic] of vectors24) {
      expect(mnemonic.split(' ').length).toBe(RECOVERY_WORDS)
    }
  })

  for (const [entropy, mnemonic] of vectors24) {
    test(`短语 → 熵：${(mnemonic as string).split(' ').slice(0, 2).join(' ')}…`, () => {
      expect(toHex(phraseToEntropy(mnemonic))).toBe(entropy)
      expect(isValidRecoveryPhrase(mnemonic)).toBe(true)
    })
  }
})

describe('抄写噪声：宽松的地方宽松，严格的地方严格', () => {
  const phrase = vectors24[1]?.[1] as string

  test('大小写、多空格、换行、首尾空白都归一化掉（抄回来的短语要能用）', () => {
    const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}\n`
    expect(normalizePhrase(messy)).toBe(phrase)
    expect(isValidRecoveryPhrase(messy)).toBe(true)
    expect(toHex(phraseToEntropy(messy))).toBe(vectors24[1]?.[0] as string)
  })

  test('少一个词、多一个词都不行', () => {
    const words = phrase.split(' ')
    expect(isValidRecoveryPhrase(words.slice(0, 23).join(' '))).toBe(false)
    expect(isValidRecoveryPhrase(`${phrase} abandon`)).toBe(false)
  })

  test('写错一个词时校验和会抓住它（换成词表里另一个词）', () => {
    const words = phrase.split(' ')
    const broken = ['abandon', ...words.slice(1)].join(' ')
    expect(broken).not.toBe(phrase)
    expect(isValidRecoveryPhrase(broken)).toBe(false)
    expect(caught(() => phraseToEntropy(broken))).toMatchObject({ code: 'bad-mnemonic' })
  })
})

describe('generateRecoveryPhrase：24 词、每次不同、自身合法', () => {
  test('生成的短语长度、合法性、熵长度都对', () => {
    const phrase = generateRecoveryPhrase()
    expect(phrase.split(' ').length).toBe(RECOVERY_WORDS)
    expect(isValidRecoveryPhrase(phrase)).toBe(true)
    expect(phraseToEntropy(phrase).length).toBe(32)
  })

  test('两次生成不重复（不是把同一个熵反复输出）', () => {
    expect(generateRecoveryPhrase()).not.toBe(generateRecoveryPhrase())
  })
})

describe('recoveryToKek：短语派生的密钥稳定且互不相同', () => {
  const phrase = vectors24[2]?.[1] as string
  const salt = new Uint8Array(16).fill(3)
  const weak = { memorySizeKiB: 8, iterations: 1, parallelism: 1 }

  test('同一短语 + 同一盐 → 同一密钥（抄写噪声不影响结果）', async () => {
    const a = await recoveryToKek(phrase, salt, weak)
    const b = await recoveryToKek(`  ${phrase.toUpperCase()}  `, salt, weak)
    expect(toHex(a)).toBe(toHex(b))
    expect(a.length).toBe(32)
  })

  test('不同短语 / 不同盐 → 不同密钥', async () => {
    const other = vectors24[3]?.[1] as string
    const a = await recoveryToKek(phrase, salt, weak)
    const b = await recoveryToKek(other, salt, weak)
    const c = await recoveryToKek(phrase, new Uint8Array(16).fill(4), weak)
    expect(toHex(a)).not.toBe(toHex(b))
    expect(toHex(a)).not.toBe(toHex(c))
  })

  test('非法短语在算 argon2 之前就被拒绝（不能让用户等完 64 MiB 才被告知拼错了）', async () => {
    const attempt = recoveryToKek('not a real phrase', salt, weak)
    await expect(attempt).rejects.toBeInstanceOf(CryptoError)
    await expect(recoveryToKek('not a real phrase', salt, weak)).rejects.toMatchObject({
      code: 'bad-mnemonic',
    })
  })
})

describe('短语不能当密码用', () => {
  test('存在性检查：导出面里没有"用短语登录"之类的东西', async () => {
    const api = await import('../src/index')
    expect(Object.keys(api).some((name) => /login|signin|authenticate/iu.test(name))).toBe(false)
  })
})
