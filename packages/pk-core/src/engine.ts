/**
 * `builtin` 药代引擎：一室分布容积 + 线性储库链。
 *
 * ## 模型
 *
 * 每个给药事件被拆成若干条链。质量单位 mg，速率单位 h⁻¹：
 *
 * ```
 * 储库 ──k──▶ 储库 ──k──▶ 活性池 ──kClear──▶ 清除
 * ```
 *
 * 每个隔室都是「一阶流失 + 流入下一个隔室」，没有别的种类：
 * - 注射的两段释放 = 两个储库（fast / slow）汇入同一个血浆储库；
 * - 血浆里酯的水解、肠道吸收，在数学上是同一件事（一阶流）；
 * - 活性池是终点，流失率就是清除率。
 *
 * 生物利用度 / formation fraction **在剂量时刻乘到初始质量上**，不在流上乘。
 * 这样「这一剂最终能贡献多少活性物质」在状态里守恒，于是可以写成硬断言：
 * `AUC == F × doseEquiv / (Vd × kClear*)`，不需要信任实现本身。
 *
 * ## 两条表观清除率
 *
 * catalog 给每个激素两条清除率：`kClear` 与 `kClearInjection`（E2：0.41 / 0.041，
 * T：0.6 / 0.03）。同一分子不可能有两个真实清除率，这是上游的表观拟合值，
 * 且上游明确按途径区分（Transmtf 的 `resolveParams`：`route === injection &&
 * ester !== EU ? kClearInjection : kClear`）。分池之后两种激素的注射曲线同时落进
 * 已发表区间；只用 `kClear` 则注射低 10–20 倍（ADR 31）。
 *
 * ## 单位
 *
 * 状态里是质量（mg），只在输出时换成浓度：
 * `Vd_ml = vdPerKG × kg × 1000`，`pg/mL = mg × 1e9 / Vd_ml`，`ng/dL = mg × 1e8 / Vd_ml`。
 *
 * ## 不做什么
 *
 * 不读取 `doseMG`（原始药物质量），只读 `doseEquivMG`。分子量换算在 protocol 层
 * 已经做完，引擎看到的永远是"相当于多少活性激素"（见 §4.2）。
 */
import type { Compound, DoseExtras, Route } from '@hrt/protocol'
import {
  catalog,
  compoundParams,
  type HormoneKey,
  type HormoneParams,
  hormoneParams,
} from './catalog'
import {
  type FluxWindow,
  type LinearSystem,
  type Schedule,
  type Series,
  solve,
  trapezoidAUC,
} from './solver'

export const ENGINE_ID = 'builtin' as const
export const MODEL_VERSION = 1

const HOUR_MS = 3_600_000
const DEFAULT_STEP_MIN = 15
const DEFAULT_INTERNAL_STEP_MIN = 1

/** 注射用池（kClearInjection）。 */
export const POOL_INJECTION = 0
/** 其余途径用池（kClear）。 */
export const POOL_OTHER = 1

export interface SimDose {
  takenAt: number
  compound: Compound
  route: Route
  /** 活性当量（mg）。引擎只吃这个。 */
  doseEquivMG: number
  weightKG?: number | undefined
  extras?: DoseExtras | undefined
  id?: string | undefined
}

export interface SimulateRequest {
  hormone: HormoneKey
  /** 分布容积用的体重（kg）。 */
  weightKG: number
  startMS: number
  endMS: number
  /** 输出采样间隔（分钟），默认 15。 */
  stepMin?: number | undefined
  /** 内部积分步长上限（分钟），默认 1。只为测试收敛性而暴露。 */
  internalStepMin?: number | undefined
}

export interface SimulateResult {
  engine: string
  modelVersion: number
  hormone: HormoneKey
  unit: 'pg/ml' | 'ng/dl'
  /** 采样时刻（epoch ms），与 `conc` 等长。 */
  tMS: number[]
  conc: number[]
  /** 曲线下面积，单位 = conc 单位 × 小时。 */
  auc: number
  peak: { conc: number; tMS: number }
  warnings: string[]
}

/** 各途径翻译器共用的系统构造器。 */
export interface Builder {
  reservoirs: { rate: number; target: number }[]
  schedules: Schedule[]
  fluxes: FluxWindow[]
  /** 去重表：同一化合物同一途径的隔室只建一次（线性系统允许叠加）。 */
  shared: Map<string, number>
  addReservoir: (rate: number, target: number) => number
  addShared: (key: string, rate: number, target: number) => number
  injectAt: (atMS: number, comp: number, amount: number) => void
  warnings: string[]
}

export function makeBuilder(
  startMS: number,
  pools: { rate: number }[],
  warnings: string[],
): Builder {
  const reservoirs = pools.map((p) => ({ rate: p.rate, target: -1 }))
  const schedules: Schedule[] = []
  const fluxes: FluxWindow[] = []
  const shared = new Map<string, number>()
  return {
    reservoirs,
    schedules,
    fluxes,
    shared,
    addReservoir: (rate, target) => {
      reservoirs.push({ rate, target })
      return reservoirs.length - 1
    },
    addShared: (key, rate, target) => {
      const existing = shared.get(key)
      if (existing !== undefined) return existing
      reservoirs.push({ rate, target })
      const index = reservoirs.length - 1
      shared.set(key, index)
      return index
    },
    injectAt: (atMS, comp, amount) => {
      if (amount === 0) return
      schedules.push({ atH: (atMS - startMS) / HOUR_MS, comp, action: 'add', amount })
    },
    warnings,
  }
}

/** 由采样结果组装对外结果，AUC 与峰值都在这里算。 */
export function finalize(
  engine: string,
  unit: SimulateResult['unit'],
  hormone: HormoneKey,
  series: Series,
  startMS: number,
  warnings: string[],
): SimulateResult {
  const tMS = series.tH.map((h) => startMS + h * HOUR_MS)
  let peakConc = series.conc[0] ?? 0
  let peakMS = tMS[0] ?? startMS
  for (let i = 1; i < series.conc.length; i += 1) {
    const cur = series.conc[i] ?? 0
    if (cur > peakConc) {
      peakConc = cur
      peakMS = tMS[i] ?? peakMS
    }
  }
  return {
    engine,
    modelVersion: MODEL_VERSION,
    hormone,
    unit,
    tMS,
    conc: series.conc,
    auc: trapezoidAUC(series),
    peak: { conc: peakConc, tMS: peakMS },
    warnings,
  }
}

/** 由激素参数得到浓度换算系数与单位。 */
export function concentrationScale(
  hp: HormoneParams,
  weightKG: number,
): { scale: number; unit: SimulateResult['unit'] } {
  const vdML = hp.vdPerKG * weightKG * 1000
  return hp.concentrationUnit === 'pgPerML'
    ? { scale: 1e9 / vdML, unit: 'pg/ml' }
    : { scale: 1e8 / vdML, unit: 'ng/dl' }
}

export function checkRequest(weightKG: number, startMS: number, endMS: number): void {
  if (!Number.isFinite(weightKG) || weightKG <= 0) {
    throw new Error('simulate: weightKG must be a positive number')
  }
  if (!(endMS > startMS)) {
    throw new Error('simulate: endMS must be greater than startMS')
  }
}

export function simulateBuiltin(doses: SimDose[], req: SimulateRequest): SimulateResult {
  const hp = hormoneParams(req.hormone)
  checkRequest(req.weightKG, req.startMS, req.endMS)

  const stepMin = req.stepMin ?? DEFAULT_STEP_MIN
  const internalStepMin = req.internalStepMin ?? DEFAULT_INTERNAL_STEP_MIN
  const { scale, unit } = concentrationScale(hp, req.weightKG)

  const warnings: string[] = []
  const b = makeBuilder(req.startMS, [{ rate: hp.kClearInjection }, { rate: hp.kClear }], warnings)

  // ---- 逐条把剂量翻译成初始质量 / 通量窗口 -------------------------------
  const ordered = [...doses].sort((x, y) => x.takenAt - y.takenAt)
  const openPatches = new Map<Compound, SimDose>()
  const usedWeights = new Map<number, number>()

  for (const dose of ordered) {
    const params = compoundParams(dose.compound)
    if (params === undefined) {
      warnings.push(`${dose.compound} 没有 PK 参数（抗雄只记录、不建模），已跳过`)
      continue
    }
    if (params.hormone !== req.hormone) continue
    if (dose.weightKG !== undefined && Number.isFinite(dose.weightKG)) {
      usedWeights.set(dose.weightKG, (usedWeights.get(dose.weightKG) ?? 0) + 1)
    }

    switch (dose.route) {
      case 'injection':
        translateInjection(dose, hp, b)
        break
      case 'oral':
        translateOral(dose, b)
        break
      case 'sublingual':
        translateSublingual(dose, b)
        break
      case 'gel':
        translateGel(dose, hp, req.startMS, b.fluxes, warnings)
        break
      case 'patchApply': {
        const previous = openPatches.get(dose.compound)
        if (previous !== undefined) {
          warnings.push(`贴片 ${dose.compound} 未记录拆除就有新的贴片，前一片按新贴片时刻结束`)
          closePatch(previous, dose.takenAt, hp, req.startMS, b.fluxes, warnings)
        }
        openPatches.set(dose.compound, dose)
        break
      }
      case 'patchRemove': {
        const previous = openPatches.get(dose.compound)
        if (previous === undefined) {
          warnings.push(`贴片拆除 ${dose.compound} 没有对应的贴片记录，已忽略`)
          break
        }
        openPatches.delete(dose.compound)
        closePatch(previous, dose.takenAt, hp, req.startMS, b.fluxes, warnings)
        break
      }
    }
  }

  for (const [compound, dose] of openPatches) {
    warnings.push(`贴片 ${compound} 没有拆除记录，按 24 小时计`)
    closePatch(dose, dose.takenAt + 24 * HOUR_MS, hp, req.startMS, b.fluxes, warnings)
  }

  // 体重：v0.1 用全局体重算 Vd，逐事件体重只用于提示差异（§18 已知缺口）。
  for (const [w, count] of usedWeights) {
    if (Math.abs(w - req.weightKG) / req.weightKG > 0.01) {
      warnings.push(
        `有 ${count} 条记录的事件体重 ${w}kg 与本次模拟用的 ${req.weightKG}kg 不同，v0.1 只用全局体重计算分布容积`,
      )
      break
    }
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

  return finalize(ENGINE_ID, unit, req.hormone, series, req.startMS, warnings)
}

// ---- 各途径的翻译 --------------------------------------------------------

export function translateInjection(dose: SimDose, hp: HormoneParams, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`注射 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const depot = catalog.twoPartDepot[dose.compound]
  const formation = catalog.formationFraction[dose.compound]
  const hydrolysis = catalog.hydrolysisK2[dose.compound]
  if (depot === undefined || formation === undefined || hydrolysis === undefined) {
    b.warnings.push(`注射 ${dose.compound} 缺少两段释放/水解参数，已跳过`)
    return
  }

  const corr = hp.depotK1Corr
  const plasma = b.addShared(`${dose.compound}:plasma`, hydrolysis, POOL_INJECTION)
  // 只有 formation fraction 那部分酯最终变成活性激素：在剂量时刻就扣掉。
  const available = dose.doseEquivMG * formation
  const fastRate = depot.k1Fast * corr
  const slowRate = depot.k1Slow * corr

  if (depot.fracFast > 0) {
    b.injectAt(dose.takenAt, b.addReservoir(fastRate, plasma), available * depot.fracFast)
  }
  if (depot.fracFast < 1) {
    b.injectAt(dose.takenAt, b.addReservoir(slowRate, plasma), available * (1 - depot.fracFast))
  }
}

function translateOral(dose: SimDose, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`口服 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const dual = catalog.oral.dualAbsorption[dose.compound]
  if (dual !== undefined) {
    const fast = b.addShared(`${dose.compound}:oral:fast`, dual.kAbsFast, POOL_OTHER)
    const slow = b.addShared(`${dose.compound}:oral:slow`, dual.kAbsSlow, POOL_OTHER)
    b.injectAt(
      dose.takenAt + dual.lagHoursFast * HOUR_MS,
      fast,
      dose.doseEquivMG * dual.fracFast * dual.bioavailabilityFast,
    )
    if (dual.fracFast < 1) {
      b.injectAt(
        dose.takenAt + dual.lagHoursSlow * HOUR_MS,
        slow,
        dose.doseEquivMG * (1 - dual.fracFast) * dual.bioavailabilitySlow,
      )
    }
    return
  }

  const kAbs = catalog.oral.kAbs[dose.compound]
  const bioavailability = catalog.oral.bioavailability[dose.compound]
  if (kAbs === undefined || bioavailability === undefined) {
    b.warnings.push(`口服 ${dose.compound} 缺少吸收/生物利用度参数，已跳过`)
    return
  }
  const gut = b.addShared(`${dose.compound}:oral`, kAbs, POOL_OTHER)
  b.injectAt(dose.takenAt, gut, dose.doseEquivMG * bioavailability)
}

function translateSublingual(dose: SimDose, b: Builder): void {
  if (!(dose.doseEquivMG > 0)) {
    b.warnings.push(`含服 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const { theta, source } = pickTheta(dose.extras)
  const oralF = catalog.oral.bioavailability[dose.compound]
  if (oralF === undefined) {
    b.warnings.push(`含服 ${dose.compound} 缺少口服生物利用度参数，已跳过`)
    return
  }

  // 含服吸收的那部分绕过首过效应（F = 1）；咽下去的部分按口服处理。
  const sublingual = b.addShared(`${dose.compound}:sl`, catalog.oral.kAbsSL, POOL_OTHER)
  b.injectAt(dose.takenAt, sublingual, dose.doseEquivMG * theta)

  if (theta < 1) {
    const kAbs = catalog.oral.kAbs[dose.compound] ?? catalog.oral.kAbsSL
    const swallowed = b.addShared(`${dose.compound}:oral`, kAbs, POOL_OTHER)
    b.injectAt(dose.takenAt, swallowed, dose.doseEquivMG * (1 - theta) * oralF)
  }

  if (source === 'default standard') {
    b.warnings.push(`${dose.compound} 含服没有 theta/holdMinutes，按 standard theta=${theta} 计算`)
  }
}

/**
 * 凝胶：吸收遵循 `dθ/dt = k1(1-θ)`，总量封顶在 `Fmax`。
 * 通量因此是闭式的 `A0·Fmax·k1·e^{-k1(t-t0)}`，不需要额外状态变量。
 */
export function translateGel(
  dose: SimDose,
  hp: HormoneParams,
  startMS: number,
  fluxes: FluxWindow[],
  warnings: string[],
): void {
  if (!(dose.doseEquivMG > 0)) {
    warnings.push(`凝胶 ${dose.compound} 的当量为 0，已跳过`)
    return
  }
  const fmax = hp.gelFmax
  if (fmax === undefined) {
    warnings.push(`凝胶 ${dose.compound} 缺少 Fmax 参数，已跳过`)
    return
  }
  const k1 = hp.gelK1
  fluxes.push({
    kind: 'exponential',
    startH: (dose.takenAt - startMS) / HOUR_MS,
    endH: Number.POSITIVE_INFINITY,
    rate: dose.doseEquivMG * fmax * k1,
    decay: k1,
    target: POOL_OTHER,
  })
}

function closePatch(
  applied: SimDose,
  removedAtMS: number,
  hp: HormoneParams,
  startMS: number,
  fluxes: FluxWindow[],
  warnings: string[],
): void {
  const startH = (applied.takenAt - startMS) / HOUR_MS
  const endH = (removedAtMS - startMS) / HOUR_MS
  if (!(endH > startH)) {
    warnings.push(`贴片 ${applied.compound} 的佩戴区间非正，已忽略`)
    return
  }
  // 睾酮贴片的标称释放量系统性低于实测暴露，上游用 patchReleaseScale 校正；
  // 雌二醇缺这个字段，等价于 1。
  const releaseScale = hp.patchReleaseScale ?? 1
  const rateUgPerDay = asNumber(applied.extras?.releaseRateUgPerDay)
  let rate: number
  if (rateUgPerDay !== undefined && rateUgPerDay > 0) {
    rate = ((rateUgPerDay * 1e-3) / 24) * releaseScale
  } else {
    const fallback = hp.patchFallbackK1
    if (!(applied.doseEquivMG > 0)) {
      warnings.push(`贴片 ${applied.compound} 既没有释放速率也没有标称当量，已忽略`)
      return
    }
    rate = applied.doseEquivMG * fallback * releaseScale
    warnings.push(
      `贴片 ${applied.compound} 没有 releaseRateUgPerDay，按 fallback k1=${fallback} 估算`,
    )
  }
  fluxes.push({ kind: 'constant', startH, endH, rate, decay: 0, target: POOL_OTHER })
}

export function pickTheta(extras: DoseExtras | undefined): { theta: number; source: string } {
  const explicit = asNumber(extras?.theta)
  if (explicit !== undefined && explicit > 0 && explicit < 1) {
    return { theta: explicit, source: 'explicit' }
  }
  const hold = asNumber(extras?.holdMinutes)
  if (hold !== undefined) {
    let bestKey: string | undefined
    let bestDiff = Number.POSITIVE_INFINITY
    for (const [key, minutes] of Object.entries(catalog.sublingual.holdMinutes)) {
      const diff = Math.abs(minutes - hold)
      if (diff < bestDiff) {
        bestDiff = diff
        bestKey = key
      }
    }
    if (bestKey !== undefined) {
      const theta = catalog.sublingual.recommendedTheta[bestKey]
      if (theta !== undefined) return { theta, source: `holdMinutes≈${bestKey}` }
    }
  }
  const fallback = catalog.sublingual.recommendedTheta.standard ?? 0.11
  return { theta: fallback, source: 'default standard' }
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
