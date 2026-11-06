/**
 * `transmtf` 药代引擎（v0.1 只覆盖雌二醇）。
 *
 * 与 `builtin` 共享数值内核（`solver.ts`）与「每个隔室 = 一阶流失 + 流入下一站」的
 * 造型，差异全部由参数表达：
 *
 * | 途径      | `builtin`                          | `transmtf`                                    |
 * | --------- | ---------------------------------- | --------------------------------------------- |
 * | 注射      | 两段释放 → 血浆酯 → 活性池         | 同上（同一组常数）                            |
 * | 口服      | 肠道 `kAbs` → 活性池               | 同上，但 EV 多一级血浆水解 `k2`                |
 * | 含服      | theta 绕过首过 + 余量按口服        | 同上（两段质量，同一套 theta 档位）            |
 * | 凝胶      | 通量 `A0·Fmax·k1·e^{-k1t}`         | **三室级联**：表面 → 皮肤储库 → 中央          |
 * | 贴片      | 恒速通量 `ramp`                    | 同上，`F = 1`                                  |
 *
 * 凝胶的差异是两套模型里最明显的：吸收分数从常数 `Fmax`（雌二醇 0.06）换成
 * `kPen/(kPen+kLoss)`（Oestrogel 约 0.10），并且多出「表面溶剂变干 → 皮肤储库缓释」
 * 的延迟，所以起峰更晚、尾部更长。同一个 1.5mg 剂量的 AUC 因此相差约 1.7 倍——
 * 这正是双曲线对比要展示的东西。
 *
 * ## 三室级联如何落进这个求解器
 *
 * 上游写的是
 * `M_s' = -(kPen+kLoss)·M_s`、`M_skin' = kPen·M_s - kRel·M_skin`、`M_c' = kRel·M_skin - ke·M_c`。
 * 表面有两条平行出口（渗透 `kPen`、损失 `kLoss`），而我们的隔室只有一个出口，于是
 * 在剂量时刻把损失那一份直接扣掉：投入 `M0·kPen/(kPen+kLoss)`、表面流失率取
 * `kPen+kLoss`，则进入皮肤的瞬时通量 = `M0·kPen·e^{-(kPen+kLoss)t}`，与上游逐字相同。
 * 这不是近似，是同一个线性方程组的等价改写（测试里用上游的闭式解作为外部预言机验证）。
 *
 * 洗掉（`washAfterH`）等于把表面剩余质量清零 —— 求解器的 `clear` 事件，精确施加在
 * 事件时刻，不受步长影响。
 */
import type { Compound, DoseExtras } from '@hrt/protocol'
import {
  gelCoApplicationFactor,
  gelProductById,
  injectionK2,
  oralKAbs,
  resolveGelCoverageArea,
  resolveGelKinetics,
  sublingualTheta,
  transmtfActiveFactor,
  transmtfCatalog,
} from './catalog.transmtf'
import {
  asNumber,
  type Builder,
  checkRequest,
  finalize,
  makeBuilder,
  type SimDose,
  type SimulateRequest,
  type SimulateResult,
} from './engine'
import { type FluxWindow, type LinearSystem, solve } from './solver'

export const TRANSMTF_ENGINE_ID = 'transmtf' as const

const HOUR_MS = 3_600_000
const DEFAULT_STEP_MIN = 15
const DEFAULT_INTERNAL_STEP_MIN = 1

/** 注射用池（kClearInjection）。 */
const POOL_INJECTION = 0
/** 非注射途径用池（kClear）。 */
const POOL_OTHER = 1

export function simulateTransmtf(doses: SimDose[], req: SimulateRequest): SimulateResult {
  if (req.hormone !== 'estradiol') {
    throw new Error('simulate: transmtf 引擎只覆盖雌二醇（睾酮请用 builtin）')
  }
  const core = transmtfCatalog.core
  checkRequest(req.weightKG, req.startMS, req.endMS)

  const stepMin = req.stepMin ?? DEFAULT_STEP_MIN
  const internalStepMin = req.internalStepMin ?? DEFAULT_INTERNAL_STEP_MIN
  const vdML = core.vdPerKG * req.weightKG * 1000
  const scale = 1e9 / vdML

  const warnings: string[] = []
  const b = makeBuilder(
    req.startMS,
    [{ rate: core.kClearInjection }, { rate: core.kClear }],
    warnings,
  )

  const ordered = [...doses].sort((x, y) => x.takenAt - y.takenAt)
  const openPatches = new Map<Compound, SimDose>()

  for (const dose of ordered) {
    if (!(dose.doseEquivMG >= 0)) {
      warnings.push(`${dose.compound} 的当量不是有效数字，已跳过`)
      continue
    }
    switch (dose.route) {
      case 'injection':
        translateInjection(dose, core.depotK1Corr, b)
        break
      case 'oral':
        translateOral(dose, b)
        break
      case 'sublingual':
        translateSublingual(dose, b)
        break
      case 'gel':
        translateGel(dose, b, req.startMS)
        break
      case 'patchApply': {
        const previous = openPatches.get(dose.compound)
        if (previous !== undefined) {
          warnings.push(`贴片 ${dose.compound} 未拆除就再次粘贴，前一片按新贴片时刻结束`)
          closePatch(previous, dose.takenAt, b, req.startMS)
        }
        openPatches.set(dose.compound, dose)
        break
      }
      case 'patchRemove': {
        const previous = openPatches.get(dose.compound)
        if (previous === undefined) {
          warnings.push(`贴片拆除 ${dose.compound} 没有对应贴片，已忽略`)
          break
        }
        openPatches.delete(dose.compound)
        closePatch(previous, dose.takenAt, b, req.startMS)
        break
      }
    }
  }

  for (const [compound, dose] of openPatches) {
    warnings.push(`贴片 ${compound} 没有拆除记录，按 24 小时计`)
    closePatch(dose, dose.takenAt + 24 * HOUR_MS, b, req.startMS)
  }

  const system: LinearSystem = {
    reservoirs: b.reservoirs,
    schedules: b.schedules,
    fluxes: b.fluxes,
    outputs: [POOL_INJECTION, POOL_OTHER],
  }
  const series = solve(system, {
    durationH: (req.endMS - req.startMS) / HOUR_MS,
    stepMin,
    internalStepMin,
    scale,
  })

  return finalize(TRANSMTF_ENGINE_ID, 'pg/ml', req.hormone, series, req.startMS, warnings)
}

// ---- 途径翻译 ------------------------------------------------------------

function translateInjection(dose: SimDose, depotK1Corr: number, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`注射 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const depot = transmtfCatalog.injection.twoPartDepot[dose.compound]
  const formation = transmtfCatalog.injection.formationFraction[dose.compound]
  if (depot === undefined || formation === undefined) {
    b.warnings.push(`注射 ${dose.compound} 不在 transmtf 目录里，已跳过`)
    return
  }
  const k2 = injectionK2(dose.compound)
  const available = dose.doseEquivMG * formation
  const plasma =
    k2 > 0 ? b.addShared(`${dose.compound}:plasma`, k2, POOL_INJECTION) : POOL_INJECTION

  if (depot.fracFast > 0) {
    b.injectAt(
      dose.takenAt,
      b.addReservoir(depot.k1Fast * depotK1Corr, plasma),
      available * depot.fracFast,
    )
  }
  if (depot.fracFast < 1) {
    b.injectAt(
      dose.takenAt,
      b.addReservoir(depot.k1Slow * depotK1Corr, plasma),
      available * (1 - depot.fracFast),
    )
  }
}

function translateOral(dose: SimDose, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`口服 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const factor = transmtfActiveFactor(dose.compound)
  if (factor === undefined) {
    b.warnings.push(`口服 ${dose.compound} 不在 transmtf 目录里，已跳过`)
    return
  }
  const target = absorptionTarget(dose.compound, 'oral', POOL_OTHER, b)
  const gut = b.addShared(`${dose.compound}:oral`, oralKAbs(dose.compound), target)
  b.injectAt(dose.takenAt, gut, dose.doseEquivMG * transmtfCatalog.oral.bioavailability)
}

function translateSublingual(dose: SimDose, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`含服 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const { theta, tier } = pickTheta(dose.extras)
  const bioavailability = transmtfCatalog.oral.bioavailability

  // 含服吸收的部分绕过首过效应（F = 1），咽下去的按口服算。
  const direct = b.addShared(`${dose.compound}:sl`, transmtfCatalog.oral.kAbsSL, POOL_OTHER)
  b.injectAt(dose.takenAt, direct, dose.doseEquivMG * theta)

  if (theta < 1) {
    const target = absorptionTarget(dose.compound, 'swallowed', POOL_OTHER, b)
    const gut = b.addShared(`${dose.compound}:oral`, oralKAbs(dose.compound), target)
    b.injectAt(dose.takenAt, gut, dose.doseEquivMG * (1 - theta) * bioavailability)
  }

  if (dose.extras?.theta === undefined && dose.extras?.holdMinutes === undefined) {
    b.warnings.push(
      `${dose.compound} 含服没有 theta/holdMinutes，按 ${tier} 档 theta=${theta} 计算`,
    )
  }
}

/**
 * 凝胶：三室级联。表面流失率取 `kPen+kLoss`，只投入 `M0·kPen/(kPen+kLoss)`，
 * 等价于上游「渗透与损失并行」的写法（见文件头）。
 */
function translateGel(dose: SimDose, b: Builder, startMS: number): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`凝胶 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  if (dose.compound !== 'E2') {
    b.warnings.push(`凝胶 ${dose.compound} 不是雌二醇本身，transmtf 的凝胶模型只对 E2 标定，已跳过`)
    return
  }
  const extras = dose.extras ?? {}
  const product = gelProductById(asProductId(extras.gelProductId))
  const area = resolveGelCoverageArea(
    asString(extras.coverageTemplate),
    product,
    asNumber(extras.areaCm2) ?? asNumber(extras.areaCM2),
  )
  const kinetics = resolveGelKinetics(product, asString(extras.site), dose.doseEquivMG, area)
  const coFactor = gelCoApplicationFactor(asString(extras.coApplied))

  const percut = kinetics.kPen / (kinetics.kPen + kinetics.kLoss)
  const applied = dose.doseEquivMG * percut * coFactor

  const skin = b.addReservoir(kinetics.kRel, POOL_OTHER)
  const surface = b.addReservoir(kinetics.kPen + kinetics.kLoss, skin)
  b.injectAt(dose.takenAt, surface, applied)

  const wash = asNumber(extras.gelWashAfterH)
  if (wash !== undefined && wash > 0) {
    b.schedules.push({
      atH: (dose.takenAt - startMS) / HOUR_MS + wash,
      comp: surface,
      action: 'clear',
    })
  }
}

function closePatch(applied: SimDose, removedAtMS: number, b: Builder, startMS: number): void {
  const startH = (applied.takenAt - startMS) / HOUR_MS
  const endH = (removedAtMS - startMS) / HOUR_MS
  if (!(endH > startH)) {
    b.warnings.push(`贴片 ${applied.compound} 的佩戴区间非正，已忽略`)
    return
  }
  const rateUgPerDay = asNumber(applied.extras?.releaseRateUgPerDay)
  const formation = transmtfCatalog.patch.formationFraction
  if (rateUgPerDay !== undefined && rateUgPerDay > 0) {
    const flux: FluxWindow = {
      kind: 'constant',
      startH,
      endH,
      rate: ((rateUgPerDay * 1e-3) / 24) * formation,
      decay: 0,
      target: POOL_OTHER,
    }
    b.fluxes.push(flux)
    return
  }
  if (!(applied.doseEquivMG > 0)) {
    b.warnings.push(`贴片 ${applied.compound} 既没有释放速率也没有标称当量，已忽略`)
    return
  }
  // 没有标称释放速率时，上游把它当作一个 k1 = 0.0075 的储库（指数释放），
  // 而不是恒速通量 —— 与 builtin 的 fallback 形状不同，这是两个引擎的真实差异。
  const depot = b.addReservoir(transmtfCatalog.patch.fallbackK1, POOL_OTHER)
  b.injectAt(applied.takenAt, depot, applied.doseEquivMG * formation)
  b.warnings.push(
    `贴片 ${applied.compound} 没有 releaseRateUgPerDay，按 fallback k1=${transmtfCatalog.patch.fallbackK1} 指数释放估算`,
  )
}

/**
 * 吸收后的下一站：有水解常数（酯类）就先过一级血浆储库，雌二醇本身直达活性池。
 * 这是「差异用参数表达」的体现——同一段代码靠 `k2` 是否为 0 决定层数。
 */
function absorptionTarget(compound: Compound, tag: string, fallback: number, b: Builder): number {
  const k2 = injectionK2(compound)
  if (!(k2 > 0)) return fallback
  return b.addShared(`${compound}:${tag}:plasma`, k2, fallback)
}

function pickTheta(extras: DoseExtras | undefined): { theta: number; tier: string } {
  const explicit = asNumber(extras?.theta)
  if (explicit !== undefined && explicit >= 0 && explicit <= 1) {
    return { theta: explicit, tier: 'explicit' }
  }
  const hold = asNumber(extras?.holdMinutes)
  if (hold !== undefined) {
    let best: { theta: number; tier: string } | undefined
    let bestDiff = Number.POSITIVE_INFINITY
    for (const [key, value] of Object.entries(transmtfCatalog.sublingual.tiers)) {
      const diff = Math.abs(value.holdMinutes - hold)
      if (diff < bestDiff) {
        bestDiff = diff
        best = { theta: value.theta, tier: key }
      }
    }
    if (best !== undefined) return best
  }
  return sublingualTheta(asString(extras?.tier))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asProductId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
