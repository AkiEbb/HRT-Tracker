/**
 * 导入 / 导出：Kira HRT 与 Transmtf 的备份格式。
 *
 * 两种工具的备份同源（同名 `timeH` / `route` / `ester` / `doseMG` / `extras`），
 * 所以共用一套行级消毒器，只有"外壳"与容错策略不同。
 *
 * 三条铁律（§8.3）：
 *  1. `null` / 布尔 / 空串**绝不**被隐式转成数字（`Number(true) === 1` 会把脏数据变成剂量）。
 *  2. 缺 `analyte` 时默认 `unknown`；"按单位猜"是显式选项、默认关闭。
 *  3. 不认识的东西进 `skipped` 或 `preserved`，**不静默丢弃**。
 */
import { DoseError, makeDose } from './dose'
import {
  type ActiveFactorOf,
  type Analyte,
  type DoseExtras,
  type DosePayload,
  isAnalyte,
  isCompound,
  isLabUnit,
  isRoute,
  type LabMonitoring,
  type LabPayload,
  type LabUnit,
  PROTOCOL_VERSION,
  type Route,
} from './types'

export interface RejectedRow {
  index: number
  reason: string
}

export interface ImportOptions {
  /** 当量因子查询（来自 @hrt/pk-core 的 catalog）。 */
  factorOf: ActiveFactorOf
  /** 缺失时的默认体重；上游两种工具都是按事件存体重。 */
  defaultWeightKG?: number
  /** 旧备份兼容：缺 analyte 时按单位推断。默认关闭。 */
  inferAnalyteFromUnit?: boolean
  /** 客户端时钟注入，便于测试确定性。 */
  now?: () => number
}

export interface ImportedDose {
  id: string
  takenAt: number
  payload: DosePayload
}

export interface ImportedLab {
  id: string
  takenAt: number
  payload: LabPayload
}

export interface ImportReport {
  source: 'kira-hrt' | 'transmtf'
  skipped: RejectedRow[]
  warnings: string[]
  /** 未建模的顶层字段，原样保留，防止静默丢数据。 */
  preserved: Record<string, unknown>
}

export interface ImportResult {
  doses: ImportedDose[]
  labs: ImportedLab[]
  report: ImportReport
}

const HOUR_MS = 3_600_000

export const timeHToMS = (timeH: number): number => Math.round(timeH * HOUR_MS)
export const msToTimeH = (ms: number): number => ms / HOUR_MS

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 严格数字：只接受有限数字或非空数字字符串；布尔/空串/`null` 一律拒绝。 */
const strictNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 严格时间：损坏的 `timeH: null` 绝不能变成 1970 并污染整条时间轴。 */
const strictTimeH = (value: unknown): number | null => strictNumber(value)

const pickExtras = (value: unknown): DoseExtras | undefined =>
  isRecord(value) ? (value as DoseExtras) : undefined

/** 只保留有限数字的监测项，其余丢弃（不观测到的项不该以 NaN 存在）。 */
const pickMonitoring = (row: JsonRecord): LabMonitoring | undefined => {
  const monitoring: LabMonitoring = {}
  let filled = false
  for (const key of ['prolactin', 'prolactinUln', 'alt', 'altUln', 'ast', 'potassium'] as const) {
    const value = strictNumber(row[key])
    if (value !== null) {
      monitoring[key] = value
      filled = true
    }
  }
  return filled ? monitoring : undefined
}

/** 已被建模的顶层字段：其余一切（包括 Transmtf 的 `gelProducts`）都进 `preserved`。 */
const MODELLED_TOP_LEVEL = new Set([
  'format',
  'version',
  'meta',
  'events',
  'labResults',
  'bodyWeightKg',
])

const collectPreserved = (raw: JsonRecord): JsonRecord => {
  const preserved: JsonRecord = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!MODELLED_TOP_LEVEL.has(key)) preserved[key] = value
  }
  return preserved
}

// ---------------------------------------------------------------------------
// 行级消毒
// ---------------------------------------------------------------------------

const convertDoseRow = (
  row: unknown,
  index: number,
  opts: ImportOptions,
  report: ImportReport,
): ImportedDose | null => {
  if (!isRecord(row)) {
    report.skipped.push({ index, reason: 'not an object' })
    return null
  }

  const route = row.route
  if (!isRoute(route)) {
    report.skipped.push({ index, reason: `unknown route: ${String(route)}` })
    return null
  }

  const timeH = strictTimeH(row.timeH)
  if (timeH === null) {
    report.skipped.push({ index, reason: `invalid time: ${String(row.timeH)}` })
    return null
  }

  const rawDose = strictNumber(row.doseMG)
  const extras = pickExtras(row.extras)
  const rate = strictNumber(extras?.releaseRateUgPerDay)
  const patchRateZero = route === 'patchApply' && rawDose === 0 && rate !== null && rate > 0
  if (
    rawDose === null ||
    rawDose < 0 ||
    (rawDose === 0 && route !== 'patchRemove' && !patchRateZero)
  ) {
    report.skipped.push({ index, reason: `invalid dose: ${String(row.doseMG)}` })
    return null
  }

  // ester（旧字段名）与 compound（我们的内部名）都接受；未知值按上游规则降级到 E2 并留痕。
  const rawCompound = row.compound ?? row.ester
  let compound = isCompound(rawCompound) ? rawCompound : undefined
  if (compound === undefined) {
    report.warnings.push(
      `event[${index}]: unknown ester ${JSON.stringify(rawCompound)} → treated as E2`,
    )
    compound = 'E2'
  }

  const weightKG = strictNumber(row.weightKG) ?? opts.defaultWeightKG
  const note = typeof row.note === 'string' && row.note !== '' ? row.note : undefined
  const tzOffsetMin = strictNumber(row.tzOffsetMin)
  const takenAt = timeHToMS(timeH)

  try {
    const payload = makeDose(
      {
        compound,
        route: route satisfies Route,
        doseMG: rawDose,
        clientUpdatedAt: opts.now?.() ?? Date.now(),
        ...(extras !== undefined ? { extras } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(weightKG !== null ? { weightKG } : {}),
        ...(tzOffsetMin !== null ? { tzOffsetMin } : {}),
      },
      opts.factorOf,
    )
    return {
      id: typeof row.id === 'string' && row.id !== '' ? row.id : makeId('dose', index),
      takenAt,
      payload,
    }
  } catch (error) {
    const reason = error instanceof DoseError ? error.reason : 'failed to normalize dose'
    report.skipped.push({ index, reason })
    return null
  }
}

/** 单位 → 分析物。**只在 `inferAnalyteFromUnit` 显式开启时使用**。 */
const ANALYTE_BY_UNIT: Record<LabUnit, Analyte> = {
  'pg/ml': 'E2',
  'pmol/l': 'E2',
  'ng/dl': 'T',
  'nmol/l': 'T',
}

const convertLabRow = (
  row: unknown,
  index: number,
  opts: ImportOptions,
  report: ImportReport,
): ImportedLab | null => {
  if (!isRecord(row)) {
    report.skipped.push({ index, reason: 'not an object' })
    return null
  }

  const timeH = strictTimeH(row.timeH)
  if (timeH === null) {
    report.skipped.push({ index, reason: `invalid time: ${String(row.timeH)}` })
    return null
  }

  const unit = isLabUnit(row.unit) ? row.unit : undefined
  if (row.unit !== undefined && unit === undefined) {
    report.warnings.push(`lab[${index}]: unknown unit ${JSON.stringify(row.unit)} kept as-is`)
  }

  let analyte: Analyte
  if (isAnalyte(row.analyte)) {
    analyte = row.analyte
  } else if (row.analyte !== undefined) {
    report.warnings.push(`lab[${index}]: invalid analyte ${JSON.stringify(row.analyte)} → unknown`)
    analyte = 'unknown'
  } else if (opts.inferAnalyteFromUnit === true && unit !== undefined) {
    analyte = ANALYTE_BY_UNIT[unit]
    report.warnings.push(`lab[${index}]: analyte missing → inferred ${analyte} from unit ${unit}`)
  } else {
    analyte = 'unknown'
  }

  const concValue = strictNumber(row.concValue)
  const monitoring = pickMonitoring(row)
  if (concValue === null && monitoring === undefined) {
    report.skipped.push({ index, reason: 'no measurable value' })
    return null
  }

  const labNote = typeof row.labNote === 'string' && row.labNote !== '' ? row.labNote : undefined
  const payload: LabPayload = {
    analyte,
    clientUpdatedAt: opts.now?.() ?? Date.now(),
  }
  if (concValue !== null) payload.concValue = concValue
  if (unit !== undefined) payload.unit = unit
  if (monitoring !== undefined) payload.monitoring = monitoring
  if (labNote !== undefined) payload.labNote = labNote

  return {
    id: typeof row.id === 'string' && row.id !== '' ? row.id : makeId('lab', index),
    takenAt: timeHToMS(timeH),
    payload,
  }
}

/** 没有 id 的旧数据：生成一个稳定的本地 id（导入幂等的前提是不重复导入同一文件）。 */
const makeId = (kind: string, index: number): string =>
  `imported-${kind}-${index}-${randomSuffix()}`

const randomSuffix = (): string => Math.random().toString(36).slice(2, 10)

// ---------------------------------------------------------------------------
// 外壳解析
// ---------------------------------------------------------------------------

interface Shell {
  events: unknown
  labResults: unknown
  defaultWeightKG: number | undefined
  preserved: Record<string, unknown>
}

const parseShell = (raw: unknown, source: ImportReport['source'], allowArray: boolean): Shell => {
  if (Array.isArray(raw)) {
    if (!allowArray) throw new Error(`${source}: expected a backup object, got an array`)
    return { events: raw, labResults: undefined, defaultWeightKG: undefined, preserved: {} }
  }
  if (!isRecord(raw)) throw new Error(`${source}: backup is not an object`)

  const bodyWeight = strictNumber(raw.bodyWeightKg)
  return {
    events: raw.events,
    labResults: raw.labResults,
    defaultWeightKG: bodyWeight ?? undefined,
    preserved: collectPreserved(raw),
  }
}

const runImport = (
  raw: unknown,
  source: ImportReport['source'],
  opts: ImportOptions,
  allowArray: boolean,
): ImportResult => {
  const shell = parseShell(raw, source, allowArray)
  const report: ImportReport = {
    source,
    skipped: [],
    warnings: [],
    preserved: shell.preserved,
  }

  const effective: ImportOptions = {
    ...opts,
    ...(opts.defaultWeightKG === undefined && shell.defaultWeightKG !== undefined
      ? { defaultWeightKG: shell.defaultWeightKG }
      : {}),
  }

  const doses: ImportedDose[] = []
  if (Array.isArray(shell.events)) {
    shell.events.forEach((row, index) => {
      const converted = convertDoseRow(row, index, effective, report)
      if (converted !== null) doses.push(converted)
    })
  } else if (shell.events !== undefined) {
    throw new Error(`${source}: \`events\` is not an array`)
  }

  const labs: ImportedLab[] = []
  if (Array.isArray(shell.labResults)) {
    shell.labResults.forEach((row, index) => {
      const converted = convertLabRow(row, index, effective, report)
      if (converted !== null) labs.push(converted)
    })
  } else if (shell.labResults !== undefined) {
    throw new Error(`${source}: \`labResults\` is not an array`)
  }

  return { doses, labs, report }
}

/** Kira 全量备份或明文协议导出（`format: "kira-hrt"`，或带 `meta.version`）。 */
export function importKiraHrt(raw: unknown, opts: ImportOptions): ImportResult {
  if (!Array.isArray(raw)) {
    if (!isRecord(raw)) throw new Error('kira-hrt: backup is not an object')
    const hasMarker = raw.format === 'kira-hrt'
    const hasMeta = isRecord(raw.meta) && typeof raw.meta.version === 'number'
    if (!hasMarker && !hasMeta) {
      throw new Error('kira-hrt: missing `format: "kira-hrt"` or `meta.version` marker')
    }
  }
  return runImport(raw, 'kira-hrt', opts, true)
}

/** Transmtf 备份：同一套字段，外壳更松（没有 format 标记，可带 gelProducts）。 */
export function importTransmtf(raw: unknown, opts: ImportOptions): ImportResult {
  return runImport(raw, 'transmtf', opts, true)
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface KiraExportEvent {
  id: string
  timeH: number
  route: Route
  ester: string
  doseMG: number
  extras?: DoseExtras
  weightKG?: number
}

export interface KiraExportLab {
  id: string
  timeH: number
  analyte: Analyte
  concValue?: number
  unit?: LabUnit
  labNote?: string
}

export interface KiraExport {
  format: 'kira-hrt'
  version: number
  events: KiraExportEvent[]
  labResults: KiraExportLab[]
}

export interface ExportResult {
  data: KiraExport
  /** 目标格式无法表达而被丢弃的内容 —— 必须告诉用户，不能静默。 */
  warnings: string[]
}

/**
 * 导出为 `kira-hrt` 明文协议。
 *
 * ⚠️ 输出是**未加密的健康数据**，调用方必须先取得用户明确确认（§8.2）。
 * `doseMG` 写原始药物质量；当量是本工具的派生字段，不进协议。
 */
export function exportKiraHrt(
  doses: readonly ImportedDose[],
  labs: readonly ImportedLab[] = [],
): ExportResult {
  const warnings: string[] = []

  const events: KiraExportEvent[] = doses.map(({ id, takenAt, payload }) => {
    const event: KiraExportEvent = {
      id,
      timeH: msToTimeH(takenAt),
      route: payload.route,
      ester: payload.compound,
      doseMG: payload.doseMG,
    }
    if (payload.extras !== undefined) event.extras = payload.extras
    if (payload.weightKG !== undefined) event.weightKG = payload.weightKG
    return event
  })

  const notes = doses.filter((d) => d.payload.note !== undefined).length
  if (notes > 0) {
    warnings.push(`${notes} 条记录的备注无法写入 kira-hrt（协议无对应字段）`)
  }

  const labResults: KiraExportLab[] = labs.map(({ id, takenAt, payload }) => {
    const lab: KiraExportLab = {
      id,
      timeH: msToTimeH(takenAt),
      analyte: payload.analyte,
    }
    if (payload.concValue !== undefined) lab.concValue = payload.concValue
    if (payload.unit !== undefined) lab.unit = payload.unit
    if (payload.labNote !== undefined) lab.labNote = payload.labNote
    return lab
  })

  const monitoringDropped = labs.filter((l) => l.payload.monitoring !== undefined).length
  if (monitoringDropped > 0) {
    warnings.push(`${monitoringDropped} 条化验的监测项在本次导出中被省略`)
  }

  return { data: { format: 'kira-hrt', version: PROTOCOL_VERSION, events, labResults }, warnings }
}
