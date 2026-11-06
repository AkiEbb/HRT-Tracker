/**
 * 剂量语义：`doseMG`（原始药物）与 `doseEquivMG`（活性当量）永不合流。
 *
 * 这个文件存在的唯一理由，是让"同一名字、两种语义"这个坑在编译期就暴露出来：
 * 换算因子必须由调用方显式注入（来自 @hrt/pk-core 的 catalog），
 * 本包不持有任何魔法数字，也不 import pk-core（避免循环依赖）。
 */
import {
  type ActiveFactorOf,
  type Compound,
  categoryOf,
  type DoseExtras,
  type DosePayload,
  isCompound,
  isRoute,
  type Route,
} from './types'

export class DoseError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'DoseError'
    this.reason = reason
  }
}

export interface DoseInput {
  compound: Compound
  route: Route
  doseMG: number
  clientUpdatedAt: number
  extras?: DoseExtras
  note?: string
  weightKG?: number
  tzOffsetMin?: number
  /** 用户手工覆盖过当量：提供 `doseEquivMG` 且此标志为 true 时不重算。 */
  equivOverridden?: boolean
  doseEquivMG?: number
}

export function activeEquivalentMG(
  compound: Compound,
  doseMG: number,
  factorOf: ActiveFactorOf,
): number {
  const factor = factorOf(compound)
  if (factor === undefined || !Number.isFinite(factor) || factor <= 0) {
    throw new DoseError(`no active factor for compound ${compound}`)
  }
  return doseMG * factor
}

/**
 * 规范化一条剂量记录。失败抛 `DoseError`，
 * 调用方（导入器）负责把它变成一条可读的跳过原因。
 */
export function makeDose(input: DoseInput, factorOf: ActiveFactorOf): DosePayload {
  if (!isCompound(input.compound))
    throw new DoseError(`unknown compound: ${String(input.compound)}`)
  if (!isRoute(input.route)) throw new DoseError(`unknown route: ${String(input.route)}`)
  if (!Number.isFinite(input.doseMG) || input.doseMG < 0) throw new DoseError('invalid dose')

  const overridden = input.equivOverridden === true && input.doseEquivMG !== undefined
  const category = categoryOf(input.compound)
  let doseEquivMG: number
  if (category === 'antiAndrogen') {
    // 抗雄只记录、不建模：对 E2/T 曲线的贡献是 0，而不是"等于它自己的毫克数"。
    // 用 doseMG 冒充当量会污染图表与导出，这是这个项目最贵的一类错误。
    doseEquivMG = 0
  } else if (overridden) {
    doseEquivMG = input.doseEquivMG as number
  } else {
    doseEquivMG = activeEquivalentMG(input.compound, input.doseMG, factorOf)
  }

  if (!Number.isFinite(doseEquivMG) || doseEquivMG < 0) {
    throw new DoseError('invalid equivalent dose')
  }

  const payload: DosePayload = {
    category,
    compound: input.compound,
    route: input.route,
    doseMG: input.doseMG,
    doseEquivMG,
    clientUpdatedAt: input.clientUpdatedAt,
  }
  if (overridden) payload.equivOverridden = true
  if (input.extras !== undefined) payload.extras = input.extras
  if (input.note !== undefined) payload.note = input.note
  if (input.weightKG !== undefined && Number.isFinite(input.weightKG) && input.weightKG > 0) {
    payload.weightKG = input.weightKG
  }
  if (input.tzOffsetMin !== undefined && Number.isFinite(input.tzOffsetMin)) {
    payload.tzOffsetMin = input.tzOffsetMin
  }
  return payload
}
