/**
 * 内部数据模型的词汇表与信封类型。
 *
 * 这里是"唯一真源"：任何把 `compound` / `route` / `analyte` 写成裸字符串的地方都是 bug。
 * 语义约定见 docs/DESIGN.md §4。
 */

export const PROTOCOL_VERSION = 1 as const

/** 激素类别。上游模型的 E2 / T 两条曲线 + 只记录不建模的抗雄。 */
export type Category = 'estradiol' | 'testosterone' | 'antiAndrogen'

/** 雌二醇及其酯（上游 catalog 的 compounds，一一对应，不多不少）。 */
export const ESTER_COMPOUNDS = ['E2', 'EB', 'EV', 'EC', 'EN'] as const
/** 睾酮及其酯。 */
export const TESTOSTERONE_COMPOUNDS = ['T', 'TC', 'TE', 'TU'] as const
/** 抗雄：只记录、不参与 PK 建模。 */
export const ANTI_ANDROGEN_COMPOUNDS = ['CPA', 'CMA', 'SPL', 'BIC'] as const

export type EsterCompound = (typeof ESTER_COMPOUNDS)[number]
export type TestosteroneCompound = (typeof TESTOSTERONE_COMPOUNDS)[number]
export type AntiAndrogenCompound = (typeof ANTI_ANDROGEN_COMPOUNDS)[number]
export type Compound = EsterCompound | TestosteroneCompound | AntiAndrogenCompound

export const ALL_COMPOUNDS = [
  ...ESTER_COMPOUNDS,
  ...TESTOSTERONE_COMPOUNDS,
  ...ANTI_ANDROGEN_COMPOUNDS,
] as const

/**
 * 活性当量因子查询：药物质量 → 活性激素质量，取值 (0, 1]。
 * 真源在 @hrt/pk-core 的 catalog（由分子量推导），由调用方注入。
 */
export type ActiveFactorOf = (compound: Compound) => number | undefined

/** 给药途径。与上游协议完全一致，多一个都不加。 */
export const ROUTES = [
  'injection',
  'oral',
  'sublingual',
  'gel',
  'patchApply',
  'patchRemove',
] as const
export type Route = (typeof ROUTES)[number]

/** 化验分析物。`unknown` 是一等公民：保留、可导出，但永不进入任何拟合。 */
export const ANALYTES = ['E2', 'T', 'unknown'] as const
export type Analyte = (typeof ANALYTES)[number]

export const LAB_UNITS = ['pg/ml', 'pmol/l', 'ng/dl', 'nmol/l'] as const
export type LabUnit = (typeof LAB_UNITS)[number]

/** 便于提示的单位集合 —— **不是**用来猜 analyte 的依据（见 §8.3）。 */
export const TYPICAL_UNITS: Record<Analyte, readonly LabUnit[]> = {
  E2: ['pg/ml', 'pmol/l'],
  T: ['ng/dl', 'nmol/l'],
  unknown: LAB_UNITS,
}

export type RecordKind = 'dose' | 'lab' | 'scalar' | 'tombstone'

/** 途径相关的附加信息，原样保留，不做建模。 */
export interface DoseExtras {
  areaCm2?: number
  releaseRateUgPerDay?: number
  holdMinutes?: number
  theta?: number
  site?: string
  batchNo?: string
  /** 凝胶产品 id（Transmtf 的 gelProducts 引用），保留以便无损往返。 */
  gelProductId?: string
  [key: string]: unknown
}

export interface DosePayload {
  category: Category
  compound: Compound
  route: Route
  /** 原始药物质量（药物本身，不是当量）。 */
  doseMG: number
  /** 活性当量 = doseMG × toActiveFactor(compound)。PK 引擎只吃这个。 */
  doseEquivMG: number
  /** 用户手工改过当量 → 禁止自动重算。 */
  equivOverridden?: boolean
  extras?: DoseExtras
  note?: string
  /** 给药当时的体重（上游两种工具都是按事件存体重，不是全局标量）。 */
  weightKG?: number
  /** 记录时刻的本地时区偏移，仅用于显示与提醒。 */
  tzOffsetMin?: number
  /** 客户端时钟，冲突裁决用这个（不是服务端的 updatedAt）。 */
  clientUpdatedAt: number
}

export interface LabMonitoring {
  prolactin?: number
  prolactinUln?: number
  alt?: number
  altUln?: number
  ast?: number
  potassium?: number
}

export interface LabPayload {
  /** 权威字段：不按单位推断。 */
  analyte: Analyte
  concValue?: number
  unit?: LabUnit
  monitoring?: LabMonitoring
  labNote?: string
  clientUpdatedAt: number
}

/** 合并/同步层看到的信封。服务端可见的字段集合就是这些（§4.3）。 */
export interface Envelope {
  id: string
  userId: string
  kind: RecordKind
  takenAt: number | null
  rev: number
  deviceId: string
  updatedAt: number
  iv: string
  ct: string
}

export function categoryOf(compound: Compound): Category {
  if ((ESTER_COMPOUNDS as readonly string[]).includes(compound)) return 'estradiol'
  if ((TESTOSTERONE_COMPOUNDS as readonly string[]).includes(compound)) return 'testosterone'
  return 'antiAndrogen'
}

/** 抗雄等"不建模"的类别：有记录、无曲线。 */
export function isModeled(category: Category): boolean {
  return category !== 'antiAndrogen'
}

export function isCompound(value: unknown): value is Compound {
  return typeof value === 'string' && (ALL_COMPOUNDS as readonly string[]).includes(value)
}

export function isRoute(value: unknown): value is Route {
  return typeof value === 'string' && (ROUTES as readonly string[]).includes(value)
}

export function isAnalyte(value: unknown): value is Analyte {
  return typeof value === 'string' && (ANALYTES as readonly string[]).includes(value)
}

export function isLabUnit(value: unknown): value is LabUnit {
  return typeof value === 'string' && (LAB_UNITS as readonly string[]).includes(value)
}
