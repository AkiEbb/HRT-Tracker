/**
 * 线性药代系统的数值内核：一组一阶隔室 + 离散给药事件 + 外部通量窗口。
 *
 * 两个 PK 引擎都归约到这个形状，好处是数值行为只有一处、只需验证一次：
 * - `builtin`：注射两段释放、肠道吸收、凝胶/贴片通量；
 * - `transmtf`：多出来的只有「表皮 → 皮肤储库 → 中央」多一级隔室与洗掉事件。
 *
 * 每个隔室都是 `dm/dt = -rate·m + 流入`，`target = -1` 表示离开系统。
 * 速率全是常数 ⇒ 线性时不变 ⇒ 恒等关系（AUC = 总量/清除率、叠加、步长收敛）
 * 可以被断言，而不只是"看起来像"。
 *
 * 离散事件只有两种：`add`（给药投料）与 `clear`（例如凝胶被洗掉，把表皮膜内
 * 剩余质量清零）。两者都在积分边界上精确施加，不会被步长抹平。
 */
export interface Reservoir {
  /** 一阶流失速率（h⁻¹）。 */
  rate: number
  /** 流入哪个隔室；-1 表示离开系统。 */
  target: number
}

export type ScheduleAction = 'add' | 'clear'

export interface Schedule {
  atH: number
  comp: number
  action: ScheduleAction
  /** 仅 `add` 使用。 */
  amount?: number
}

export interface FluxWindow {
  /** constant：恒速（贴片）；exponential：闭式衰减（凝胶饱和吸收）。 */
  kind: 'constant' | 'exponential'
  startH: number
  endH: number
  /** 起始通量（mg/h）。 */
  rate: number
  /** exponential 的衰减率（h⁻¹）。 */
  decay: number
  /** 通量进入哪个隔室。 */
  target: number
}

export interface LinearSystem {
  reservoirs: Reservoir[]
  schedules: Schedule[]
  fluxes: FluxWindow[]
  /** 参与浓度累加的隔室下标（可多个，等于分池叠加）。 */
  outputs: number[]
}

export interface SolveOptions {
  durationH: number
  /** 输出采样间隔（分钟）。 */
  stepMin: number
  /** 内部积分步长上限（分钟）。 */
  internalStepMin: number
  /** 质量（mg）→ 浓度的换算系数。 */
  scale: number
}

export interface Series {
  /** 采样时刻（h，从 0 开始）。 */
  tH: number[]
  conc: number[]
}

/** 输出采样上限，防止有人把区间设成 100 年。 */
export const MAX_SAMPLES = 200_000

const HOUR_MS = 3_600_000

export function solve(system: LinearSystem, opts: SolveOptions): Series {
  const n = system.reservoirs.length
  if (n === 0) return { tH: [], conc: [] }
  if (!(opts.stepMin > 0) || !(opts.internalStepMin > 0)) {
    throw new Error('solve: step sizes must be positive')
  }
  if (!(opts.durationH > 0)) {
    throw new Error('solve: durationH must be positive')
  }

  const outStepH = (opts.stepMin * 60_000) / HOUR_MS
  const internalStepH = (opts.internalStepMin * 60_000) / HOUR_MS
  const samples = Math.floor(opts.durationH / outStepH) + 1
  if (samples > MAX_SAMPLES) {
    throw new Error(`solve: too many samples (${samples} > ${MAX_SAMPLES})`)
  }

  const schedules = [...system.schedules].sort((a, b) => a.atH - b.atH)
  const fluxEdges: number[] = []
  for (const window of system.fluxes) {
    fluxEdges.push(window.startH)
    if (Number.isFinite(window.endH)) fluxEdges.push(window.endH)
  }
  fluxEdges.sort((a, b) => a - b)

  const fluxAt = (t: number): Map<number, number> => {
    const byTarget = new Map<number, number>()
    for (const window of system.fluxes) {
      if (t < window.startH || t >= window.endH) continue
      const value =
        window.kind === 'constant'
          ? window.rate
          : window.rate * Math.exp(-window.decay * (t - window.startH))
      byTarget.set(window.target, (byTarget.get(window.target) ?? 0) + value)
    }
    return byTarget
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
      const res = system.reservoirs[i]
      if (res === undefined) continue
      const flow = res.rate * (src[i] ?? 0)
      out[i] = (out[i] ?? 0) - flow
      if (res.target >= 0) out[res.target] = (out[res.target] ?? 0) + flow
    }
    for (const [target, value] of fluxAt(t)) {
      out[target] = (out[target] ?? 0) + value
    }
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

  let cursor = 0
  const applySchedulesUpTo = (tH: number): void => {
    while (cursor < schedules.length) {
      const next = schedules[cursor]
      if (next === undefined || next.atH > tH + 1e-9) break
      if (next.action === 'clear') {
        y[next.comp] = 0
      } else {
        y[next.comp] = (y[next.comp] ?? 0) + (next.amount ?? 0)
      }
      cursor += 1
    }
  }

  const tH: number[] = []
  const conc: number[] = []
  let edgeCursor = 0
  let now = 0
  applySchedulesUpTo(0)

  for (let sample = 0; sample < samples; sample += 1) {
    const targetH = sample * outStepH
    while (now < targetH - 1e-12) {
      let h = targetH - now
      if (h > internalStepH) h = internalStepH
      const next = schedules[cursor]
      if (next !== undefined && next.atH > now) h = Math.min(h, next.atH - now)
      while (edgeCursor < fluxEdges.length) {
        const edge = fluxEdges[edgeCursor] ?? Number.POSITIVE_INFINITY
        if (edge > now + 1e-12) {
          h = Math.min(h, edge - now)
          break
        }
        edgeCursor += 1
      }
      if (h <= 0) break
      rk4(now, h)
      now += h
      applySchedulesUpTo(now)
    }
    applySchedulesUpTo(now)
    tH.push(targetH)
    let mass = 0
    for (const index of system.outputs) mass += y[index] ?? 0
    conc.push(Math.max(0, mass) * opts.scale)
  }

  return { tH, conc }
}

/** 梯形法算曲线下面积，单位 = conc 单位 × 小时。 */
export function trapezoidAUC(series: Series): number {
  let auc = 0
  for (let i = 1; i < series.conc.length; i += 1) {
    const prev = series.conc[i - 1] ?? 0
    const cur = series.conc[i] ?? 0
    auc += ((prev + cur) / 2) * ((series.tH[i] ?? 0) - (series.tH[i - 1] ?? 0))
  }
  return auc
}
