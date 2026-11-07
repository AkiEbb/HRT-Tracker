import type { ImportReport, ImportResult } from '@hrt/protocol'
import { type ActiveFactorOf, importKiraHrt, importTransmtf } from '@hrt/protocol'

/**
 * 备份文件 → 内部记录。纯函数，不碰 DOM、不碰 IndexedDB，方便单测与 SSR。
 */

export type ImportFormat = 'kira-hrt' | 'transmtf'

export interface DetectResult {
  format: ImportFormat
  /** 依据是否充分：`false` 表示只是猜的（Kira 有 `format` 标记，Transmtf 没有）。 */
  certain: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 判定来源。
 *
 * 两种备份字段同源，真正能区分的是 `format: "kira-hrt"` 与 `meta.version`
 * ——这是 Kira 独有的标记。都没有时按 Transmtf 处理（它是更松的壳，
 * 同一份数据用更松的壳解析不会丢东西）。
 */
export function detectFormat(raw: unknown): DetectResult {
  if (isRecord(raw)) {
    if (raw.format === 'kira-hrt') return { format: 'kira-hrt', certain: true }
    if (isRecord(raw.meta) && typeof raw.meta.version === 'number') {
      return { format: 'kira-hrt', certain: true }
    }
  }
  return { format: 'transmtf', certain: false }
}

export interface ParseOptions {
  factorOf: ActiveFactorOf
  /** 显式指定可以跳过判定；不给就按 `detectFormat` 决定。 */
  format?: ImportFormat
  /** 缺 `analyte` 时按单位推断（§8.3-2：默认关闭）。 */
  inferAnalyteFromUnit?: boolean
  defaultWeightKG?: number
  now?: () => number
}

export interface Parsed {
  format: ImportFormat
  certain: boolean
  result: ImportResult
}

/** 抛错即视为"这个文件读不了"；部分行的失败走 `report.skipped`，不算抛错。 */
export function parseBackup(text: string, options: ParseOptions): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new Error(`不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const detected = detectFormat(raw)
  const format = options.format ?? detected.format
  const importOptions = {
    factorOf: options.factorOf,
    ...(options.inferAnalyteFromUnit === true ? { inferAnalyteFromUnit: true } : {}),
    ...(options.defaultWeightKG !== undefined ? { defaultWeightKG: options.defaultWeightKG } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  }

  const result =
    format === 'kira-hrt' ? importKiraHrt(raw, importOptions) : importTransmtf(raw, importOptions)

  return { format, certain: detected.format === format && detected.certain, result }
}

/** 报告摘要：给界面用的一句话，数字与列表都出自同一份 `report`。 */
export function summarize(result: ImportResult): string {
  const parts = [`${result.doses.length} 条给药`, `${result.labs.length} 条化验`]
  if (result.report.skipped.length > 0) parts.push(`跳过 ${result.report.skipped.length} 条`)
  return parts.join('，')
}

/** 未建模字段的名字，用于提示"这些内容被原样保留了"。 */
export function preservedKeys(report: ImportReport): string[] {
  return Object.keys(report.preserved)
}
