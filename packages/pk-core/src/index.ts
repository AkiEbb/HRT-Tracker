/**
 * PK 参数目录：**唯一真源**。
 *
 * 所有药代参数与分子量都在 `catalog.json` 里，代码中不得出现魔法数字（§4.2 规则 2）。
 * 活性当量因子 = `activeMolecularWeight / molecularWeight`，运行时推导而不预先烘焙，
 * 这样只有一份数需要维护、也只需要一处制造偏差。
 */
import type { ActiveFactorOf, Category, Compound } from '@hrt/protocol'
import catalogJson from './catalog.json' with { type: 'json' }

export type HormoneKey = 'estradiol' | 'testosterone'

export interface HormoneParams {
  displayName: string
  concentrationUnit: 'pgPerML' | 'ngPerDL'
  /** 分布容积，L/kg。 */
  vdPerKG: number
  /** 清除速率常数。 */
  kClear: number
  kClearInjection: number
  depotK1Corr: number
  patchFallbackK1: number
  gelK1: number
  gelFmax?: number
  patchReleaseScale?: number
}

export interface CompoundParams {
  fullName: string
  hormone: HormoneKey
  molecularWeight: number
  activeMolecularWeight: number
  isProdrug: boolean
}

export interface TwoPartDepot {
  fracFast: number
  k1Fast: number
  k1Slow: number
}

export interface DualAbsorption {
  fracFast: number
  kAbsFast: number
  kAbsSlow: number
  bioavailabilityFast: number
  bioavailabilitySlow: number
  kClear: number
  lagHoursFast: number
  lagHoursSlow: number
}

export interface Catalog {
  _source: { name: string; upstream: string; retrieved: string; note: string }
  hormones: Record<string, HormoneParams>
  compounds: Record<string, CompoundParams>
  twoPartDepot: Record<string, TwoPartDepot>
  formationFraction: Record<string, number>
  hydrolysisK2: Record<string, number>
  oral: {
    kAbs: Record<string, number>
    bioavailability: Record<string, number>
    dualAbsorption: Record<string, DualAbsorption>
    kAbsSL: number
  }
  sublingual: {
    recommendedTheta: Record<string, number>
    holdMinutes: Record<string, number>
    thetaRangeLow: Record<string, number>
    thetaRangeHigh: Record<string, number>
  }
}

export const catalog = catalogJson as Catalog

export const CATALOG_SOURCE = catalog._source

/** 该药物在目录里是否有 PK 参数（抗雄没有：只记录、不建模）。 */
export function isModeledCompound(compound: string): boolean {
  return Object.hasOwn(catalog.compounds, compound)
}

/**
 * 活性当量因子：药物质量 → 活性激素质量。
 * 目录外（例如 `EU`）返回 `undefined` —— 由调用方决定是跳过还是报错，**绝不猜 1**。
 */
export function toActiveFactor(compound: string): number | undefined {
  const params = catalog.compounds[compound] as CompoundParams | undefined
  if (params === undefined) return undefined
  const factor = params.activeMolecularWeight / params.molecularWeight
  return Number.isFinite(factor) && factor > 0 ? factor : undefined
}

/** 注入给 `@hrt/protocol` 的适配器（收窄到内部词汇表）。 */
export const factorOf: ActiveFactorOf = (compound: Compound) => toActiveFactor(compound)

export function compoundParams(compound: Compound): CompoundParams | undefined {
  return catalog.compounds[compound] as CompoundParams | undefined
}

export function hormoneParams(hormone: HormoneKey): HormoneParams {
  const params = catalog.hormones[hormone] as HormoneParams | undefined
  if (params === undefined) throw new Error(`catalog: unknown hormone ${hormone}`)
  return params
}

/** 药物 → 激素类别（与 protocol 的 `categoryOf` 对齐，额外提供抗雄的"无参数"事实）。 */
export function hormoneOf(compound: Compound): HormoneKey | undefined {
  return compoundParams(compound)?.hormone
}

export function categoryToHormone(category: Category): HormoneKey | undefined {
  if (category === 'estradiol' || category === 'testosterone') return category
  return undefined
}
