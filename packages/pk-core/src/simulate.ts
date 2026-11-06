/**
 * 引擎选择器。
 *
 * 产品里同时存在两种药代模型（DESIGN §9.1）：`builtin`（HRT-Recorder 传统，覆盖 E2 与 T）
 * 与 `transmtf`（Transmtf 传统，v0.1 只覆盖 E2）。双曲线对比就是在同一批记录上跑两次
 * 这里，把两条曲线叠在一张图上。
 *
 * 默认 `builtin`：它是唯一同时支持两种激素的引擎，选它不会因为记录里有睾酮而报错。
 */
import { type SimDose, type SimulateRequest, type SimulateResult, simulateBuiltin } from './engine'
import { simulateTransmtf } from './engine.transmtf'

export type EngineId = 'builtin' | 'transmtf'

export const ENGINE_IDS: readonly EngineId[] = ['builtin', 'transmtf']

export interface SimulateOptions extends SimulateRequest {
  /** 默认 `builtin`。 */
  engine?: EngineId | undefined
}

export function simulate(doses: SimDose[], req: SimulateOptions): SimulateResult {
  switch (req.engine ?? 'builtin') {
    case 'builtin':
      return simulateBuiltin(doses, req)
    case 'transmtf':
      return simulateTransmtf(doses, req)
    default:
      throw new Error(`simulate: 未知引擎 ${String(req.engine)}`)
  }
}
