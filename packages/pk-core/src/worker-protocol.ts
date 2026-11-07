import type { Dose } from '@hrt/protocol'
import type { HormoneKey } from './catalog'
import { ENGINE_IDS, type EngineId, type SimulateOptions } from './simulate'

/**
 * Worker 协议（§9.4）。
 *
 * 主线程不做任何 PK 计算：它只发送「用哪个引擎、哪些记录、看哪一段」，
 * 收回来的是已经算好的数组。协议定义在这里而不是在 app 里，这样 Worker
 * 与调用方之间的形状只有一个定义，也能在 pk-core 的测试里直接验证。
 *
 * 名字带 `PkWorker` 前缀是必须的：`SimulateRequest` 已经是引擎层的类型，
 * 同名会逼迫调用方去猜「这是带 id 的那层还是不带 id 的那层」。
 */
export interface PkWorkerRequest {
  id: string
  type: 'simulate'
  engine: EngineId
  doses: Dose[]
  /** 视窗区间 [startMS, endMS]。缩放只重算可见窗口。 */
  range: [number, number]
  stepMin: number
  pkParams: {
    hormone: HormoneKey
    weightKG: number
    internalStepMin?: number
  }
}

export type PkWorkerResponse =
  | {
      id: string
      type: 'result'
      engine: EngineId
      unit: 'pg/ml' | 'ng/dl'
      /** 与 `t` 等长；`Float64Array` 走结构化克隆，不经过 JSON。 */
      series: { t: Float64Array; conc: Float64Array }
      auc: number
      peak: { conc: number; tMS: number }
      warnings: string[]
    }
  | { id: string; type: 'error'; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 消息来自主线程，必须当作**不可信输入**处理：不是合法形状就拒绝，
 * 一次都不把 `undefined` 或字符串喂进引擎（引擎里的 `asNumber` 只兜底数值域）。
 */
export function parsePkWorkerRequest(raw: unknown): PkWorkerRequest {
  if (!isRecord(raw)) throw new Error('simulate: 消息不是对象')
  if (raw.type !== 'simulate') throw new Error(`simulate: 未知消息类型 ${String(raw.type)}`)
  const id = raw.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('simulate: 缺少 id')

  const engine = raw.engine
  if (typeof engine !== 'string' || !(ENGINE_IDS as readonly string[]).includes(engine)) {
    throw new Error(`simulate: 未知引擎 ${String(engine)}`)
  }

  const doses = raw.doses
  if (!Array.isArray(doses)) throw new Error('simulate: doses 必须是数组')

  const range = raw.range
  if (!Array.isArray(range) || range.length !== 2)
    throw new Error('simulate: range 必须是 [start, end]')
  const [startMS, endMS] = range as unknown[]
  if (
    typeof startMS !== 'number' ||
    typeof endMS !== 'number' ||
    !Number.isFinite(startMS) ||
    !Number.isFinite(endMS)
  ) {
    throw new Error('simulate: range 必须是两个有限数')
  }
  if (!(endMS > startMS)) throw new Error('simulate: range 必须递增')

  const stepMin = raw.stepMin
  if (typeof stepMin !== 'number' || !(stepMin > 0)) throw new Error('simulate: stepMin 必须为正数')

  const pkParams = raw.pkParams
  if (!isRecord(pkParams)) throw new Error('simulate: 缺少 pkParams')
  const hormone = pkParams.hormone
  if (hormone !== 'estradiol' && hormone !== 'testosterone') {
    throw new Error(`simulate: 未知激素 ${String(hormone)}`)
  }
  const weightKG = pkParams.weightKG
  if (typeof weightKG !== 'number' || !(weightKG > 0))
    throw new Error('simulate: weightKG 必须为正数')
  const internalStepMin = pkParams.internalStepMin
  if (
    internalStepMin !== undefined &&
    (typeof internalStepMin !== 'number' || !(internalStepMin > 0))
  ) {
    throw new Error('simulate: internalStepMin 必须为正数')
  }

  return {
    id,
    type: 'simulate',
    engine: engine as EngineId,
    doses: doses as Dose[],
    range: [startMS, endMS],
    stepMin,
    pkParams: {
      hormone,
      weightKG,
      ...(internalStepMin === undefined ? {} : { internalStepMin: internalStepMin as number }),
    },
  }
}

/** 把协议消息翻译成引擎参数。`parsePkWorkerRequest` 已经保证字段都在。 */
export function toSimulateOptions(request: PkWorkerRequest): SimulateOptions {
  const { hormone, weightKG, internalStepMin } = request.pkParams
  const [startMS, endMS] = request.range
  return {
    engine: request.engine,
    hormone,
    weightKG,
    startMS,
    endMS,
    stepMin: request.stepMin,
    ...(internalStepMin === undefined ? {} : { internalStepMin }),
  }
}
