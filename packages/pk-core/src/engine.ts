/**
 * `builtin` 药代引擎：一室分布容积 + 线性多级链。
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
 * ## 两条表观清除率（v0.1 最大的经验假设）
 *
 * catalog 给每个激素两条清除率：`kClear` 与 `kClearInjection`（E2：0.41 / 0.041，
 * T：0.6 / 0.03）。同一分子不可能有两个真实清除率，所以这不是药理学表述，而是
 * 上游的**表观**拟合值。按途径分开用（注射 → `kClearInjection`，其余 → `kClear`）
 * 之后，两种激素的注射曲线同时落进已发表的实测区间；只用 `kClear` 则注射低 10–20 倍。
 *
 * 因此活性物质分成两个池，浓度是两池质量之和除以同一个分布容积。
 * 这是经验修正，不是机制模型 —— 见 DESIGN §18 的已知缺口。
 *
 * ## 单位
 *
 * 状态里是质量（mg），只在输出时换成浓度：
 * `Vd_ml = vdPerKG × kg × 1000`，`pg/mL = mg × 1e9 / Vd_ml`，`ng/dL = mg × 1e8 / Vd_ml`。
 * 用哪个由 catalog 的 `concentrationUnit` 决定（E2 → pg/mL，T → ng/dL）。
 *
 * ## 数值方法
 *
 * 速率全是常数 ⇒ 线性时不变。定步长 RK4，内部步长默认 1 分钟，并在
 * 「输出采样点」「通量窗口边界」「延迟给药时刻」三处强制截断，避免跨过不连续点。
 * 误差只来自步长，因此可以直接对照解析解验证（见 `test/engine.test.ts`）。
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

export const ENGINE_ID = 'builtin' as const
export const MODEL_VERSION = 1

const HOUR_MS = 3_600_000
const DEFAULT_STEP_MIN = 15
const DEFAULT_INTERNAL_STEP_MIN = 1
/** 输出采样上限，防止有人把 range 设成 100 年。 */
const MAX_SAMPLES = 200_000

/** 注射用池（kClearInjection）。 */
const POOL_INJECTION = 0
/** 其余途径用池（kClear）。 */
const POOL_OTHER = 1

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
  engine: typeof ENGINE_ID
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

interface Reservoir {
  /** 一阶流失速率（h⁻¹）。 */
  rate: number
  /** 流入哪个隔室；-1 表示离开系统。 */
  target: number
}

interface ScheduledInjection {
  atH: number
  comp: number
  amount: number
}

interface FluxWindow {
  /** constant：贴片恒速；exponential：凝胶饱和吸收的闭式解。 */
  kind: 'constant' | 'exponential'
  startH: number
  endH: number
  /** 起始通量（mg/h）。 */
  rate: number
  /** exponential 的衰减率（h⁻¹）。 */
  decay?: number
}

/** 各途径的翻译器共用的系统构造器。 */
interface Builder {
  addReservoir: (rate: number, target: number) => number
  addShared: (key: string, rate: number, target: number) => number
  injectAt: (atMS: number, comp: number, amount: number) => void
  warnings: string[]
}

export function simulate(doses: SimDose[], req: SimulateRequest): SimulateResult {
  const hp = hormoneParams(req.hormone)
  const weightKG = req.weightKG
  if (!Number.isFinite(weightKG) || weightKG <= 0) {
    throw new Error('simulate: weightKG must be a positive number')
  }
  if (!(req.endMS > req.startMS)) {
    throw new Error('simulate: endMS must be greater than startMS')
  }

  const stepMin = req.stepMin ?? DEFAULT_STEP_MIN
  const internalStepMin = req.internalStepMin ?? DEFAULT_INTERNAL_STEP_MIN
  if (!(stepMin > 0) || !(internalStepMin > 0)) {
    throw new Error('simulate: step sizes must be positive')
  }
  const samples = Math.floor((req.endMS - req.startMS) / (stepMin * 60_000)) + 1
  if (samples > MAX_SAMPLES) {
    throw new Error(`simulate: too many samples (${samples} > ${MAX_SAMPLES})`)
  }

  const vdML = hp.vdPerKG * weightKG * 1000
  const scale = hp.concentrationUnit === 'pgPerML' ? 1e9 / vdML : 1e8 / vdML
  const unit: SimulateResult['unit'] = hp.concentrationUnit === 'pgPerML' ? 'pg/ml' : 'ng/dl'

  const warnings: string[] = []
  // 两个活性池必须先建，因为它们是被指向的目标。
  const comps: Reservoir[] = [
    { rate: hp.kClearInjection, target: -1 },
    { rate: hp.kClear, target: -1 },
  ]
  const shared = new Map<string, number>()
  const injections: ScheduledInjection[] = []
  const fluxes: FluxWindow[] = []

  const builder: Builder = {
    addReservoir: (rate, target) => {
      comps.push({ rate, target })
      return comps.length - 1
    },
    addShared: (key, rate, target) => {
      const existing = shared.get(key)
      if (existing !== undefined) return existing
      comps.push({ rate, target })
      const index = comps.length - 1
      shared.set(key, index)
      return index
    },
    injectAt: (atMS, comp, amount) => {
      if (amount === 0) return
      injections.push({ atH: (atMS - req.startMS) / HOUR_MS, comp, amount })
    },
    warnings,
  }

  // ---- 逐条把剂量翻译成初始质量 / 通量窗口 -------------------------------
  const ordered = [...doses].sort((a, b) => a.takenAt - b.takenAt)
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
        translateInjection(dose, hp, builder)
        break
      case 'oral':
        translateOral(dose, builder)
        break
      case 'sublingual':
        translateSublingual(dose, builder)
        break
      case 'gel':
        translateGel(dose, hp, req.startMS, fluxes, warnings)
        break
      case 'patchApply': {
        const previous = openPatches.get(dose.compound)
        if (previous !== undefined) {
          warnings.push(`贴片 ${dose.compound} 未记录拆除就有新的贴片，前一片按新贴片时刻结束`)
          closePatch(previous, dose.takenAt, hp, req.startMS, fluxes, warnings)
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
        closePatch(previous, dose.takenAt, hp, req.startMS, fluxes, warnings)
        break
      }
    }
  }

  for (const [compound, dose] of openPatches) {
    warnings.push(`贴片 ${compound} 没有拆除记录，按 24 小时计`)
    closePatch(dose, dose.takenAt + 24 * HOUR_MS, hp, req.startMS, fluxes, warnings)
  }

  // 体重：v0.1 用全局体重算 Vd，逐事件体重只用于提示差异（§18 已知缺口）。
  for (const [w, count] of usedWeights) {
    if (Math.abs(w - weightKG) / weightKG > 0.01) {
      warnings.push(
        `有 ${count} 条记录的事件体重 ${w}kg 与本次模拟用的 ${weightKG}kg 不同，v0.1 只用全局体重计算分布容积`,
      )
      break
    }
  }

  // ---- 积分 -------------------------------------------------------------
  const n = comps.length
  injections.sort((a, b) => a.atH - b.atH)

  const fluxEdges: number[] = []
  for (const window of fluxes) {
    fluxEdges.push(window.startH)
    if (Number.isFinite(window.endH)) fluxEdges.push(window.endH)
  }
  fluxEdges.sort((a, b) => a - b)

  const fluxAt = (t: number): number => {
    let sum = 0
    for (const window of fluxes) {
      if (t < window.startH || t >= window.endH) continue
      if (window.kind === 'constant') {
        sum += window.rate
      } else {
        sum += window.rate * Math.exp(-(window.decay ?? 0) * (t - window.startH))
      }
    }
    return sum
  }

  const y = new Float64Array(n)
  const k1 = new Float64Array(n)
  const k2 = new Float64Array(n)
  const k3 = new Float64Array(n)
  const k4 = new Float64Array(n)
  const tmp = new Float64Array(n)

  const deriv = (t: number, src: Float64Array, out: Float64Array): void => {
    out.fill(0)
    for (let i = 0; i < n; i += 1) {
      const comp = comps[i]
      if (comp === undefined) continue
      const flow = comp.rate * (src[i] ?? 0)
      out[i] = (out[i] ?? 0) - flow
      if (comp.target >= 0) out[comp.target] = (out[comp.target] ?? 0) + flow
    }
    // 透皮通量直接进非注射池。
    out[POOL_OTHER] = (out[POOL_OTHER] ?? 0) + fluxAt(t)
  }

  const rk4 = (t: number, h: number): void => {
    deriv(t, y, k1)
    for (let i = 0; i < n; i += 1) tmp[i] = (y[i] ?? 0) + (h / 2) * (k1[i] ?? 0)
    deriv(t + h / 2, tmp, k2)
    for (let i = 0; i < n; i += 1) tmp[i] = (y[i] ?? 0) + (h / 2) * (k2[i] ?? 0)
    deriv(t + h / 2, tmp, k3)
    for (let i = 0; i < n; i += 1) tmp[i] = (y[i] ?? 0) + h * (k3[i] ?? 0)
    deriv(t + h, tmp, k4)
    for (let i = 0; i < n; i += 1) {
      y[i] =
        (y[i] ?? 0) + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0))
    }
  }

  const tMS: number[] = []
  const conc: number[] = []
  const internalStepH = internalStepMin / 60
  const outStepMS = stepMin * 60_000

  let injCursor = 0
  const applyInjectionsUpTo = (tH: number): void => {
    while (injCursor < injections.length) {
      const next = injections[injCursor]
      if (next === undefined || next.atH > tH + 1e-9) break
      y[next.comp] = (y[next.comp] ?? 0) + next.amount
      injCursor += 1
    }
  }

  let edgeCursor = 0
  let tH = 0
  applyInjectionsUpTo(0)

  for (let sample = 0; sample < samples; sample += 1) {
    const targetMS = req.startMS + sample * outStepMS
    const targetH = (targetMS - req.startMS) / HOUR_MS
    while (tH < targetH - 1e-12) {
      let h = targetH - tH
      if (h > internalStepH) h = internalStepH
      const nextInjection = injections[injCursor]
      if (nextInjection !== undefined && nextInjection.atH > tH) {
        h = Math.min(h, nextInjection.atH - tH)
      }
      while (edgeCursor < fluxEdges.length) {
        const edge = fluxEdges[edgeCursor] ?? Number.POSITIVE_INFINITY
        if (edge > tH + 1e-12) {
          h = Math.min(h, edge - tH)
          break
        }
        edgeCursor += 1
      }
      rk4(tH, h)
      tH += h
      applyInjectionsUpTo(tH)
      if (h < 1e-12) break
    }
    applyInjectionsUpTo(tH)
    tMS.push(targetMS)
    const mass = Math.max(0, (y[POOL_INJECTION] ?? 0) + (y[POOL_OTHER] ?? 0))
    conc.push(mass * scale)
  }

  let auc = 0
  let peakConc = conc[0] ?? 0
  let peakMS = tMS[0] ?? req.startMS
  for (let i = 1; i < conc.length; i += 1) {
    const prev = conc[i - 1] ?? 0
    const cur = conc[i] ?? 0
    auc += (((prev + cur) / 2) * ((tMS[i] ?? 0) - (tMS[i - 1] ?? 0))) / HOUR_MS
    if (cur > peakConc) {
      peakConc = cur
      peakMS = tMS[i] ?? peakMS
    }
  }

  return {
    engine: ENGINE_ID,
    modelVersion: MODEL_VERSION,
    hormone: req.hormone,
    unit,
    tMS,
    conc,
    auc,
    peak: { conc: peakConc, tMS: peakMS },
    warnings,
  }
}

// ---- 各途径的翻译 --------------------------------------------------------

function translateInjection(dose: SimDose, hp: HormoneParams, b: Builder): void {
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
function translateGel(
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
  const rateUgPerDay = asNumber(applied.extras?.releaseRateUgPerDay)
  let rate: number
  if (rateUgPerDay !== undefined && rateUgPerDay > 0) {
    rate = (rateUgPerDay * 1e-3) / 24
  } else {
    const fallback = hp.patchFallbackK1
    if (!(applied.doseEquivMG > 0)) {
      warnings.push(`贴片 ${applied.compound} 既没有释放速率也没有标称当量，已忽略`)
      return
    }
    rate = applied.doseEquivMG * fallback
    warnings.push(
      `贴片 ${applied.compound} 没有 releaseRateUgPerDay，按 fallback k1=${fallback} 估算`,
    )
  }
  fluxes.push({ kind: 'constant', startH, endH, rate })
}

function pickTheta(extras: DoseExtras | undefined): { theta: number; source: string } {
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
