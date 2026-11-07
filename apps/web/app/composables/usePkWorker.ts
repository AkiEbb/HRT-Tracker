import type { EngineId, HormoneKey, PkWorkerRequest, PkWorkerResponse } from '@hrt/pk-core'
import type { Dose } from '@hrt/protocol'

/**
 * PK Worker 的唯一入口。
 *
 * 三条约定：
 *  1. Worker 只在浏览器里创建，SSR 阶段 `run` 返回 `null`（页面自然显示空态）。
 *  2. 一个 Worker 对应一个组件作用域，卸载时 `terminate`，HMR 不会漏。
 *  3. 出错也当作一次正常响应返回，让调用方决定怎么显示，不用 try/catch 包住 UI。
 *     “过期响应”**不在这里**丢弃：一次双引擎对比天生就是两个并发请求。
 */

export interface PkResult {
  engine: EngineId
  unit: 'pg/ml' | 'ng/dl'
  series: { t: Float64Array; conc: Float64Array }
  auc: number
  peak: { conc: number; tMS: number }
  warnings: string[]
}
const workerUrl = new URL('../workers/pk.worker.ts', import.meta.url)

export function usePkWorker() {
  let worker: Worker | null = null
  let seq = 0
  const pending = new Map<string, (response: PkWorkerResponse) => void>()

  const ensure = (): Worker | null => {
    if (!import.meta.client) return null
    if (worker !== null) return worker
    worker = new Worker(workerUrl, { type: 'module' })
    worker.onmessage = (event: MessageEvent<PkWorkerResponse>) => {
      const response = event.data
      const resolve = pending.get(response.id)
      if (resolve === undefined) return
      pending.delete(response.id)
      resolve(response)
    }
    return worker
  }

  /** 关掉页面时释放，避免 HMR 反复创建 Worker。 */
  const dispose = (): void => {
    worker?.terminate()
    worker = null
    pending.clear()
  }

  /**
   * 请求一次求解。`transport` 之外的字段由调用方给全，这里不猜默认值：
   * 体重与激素写错会让曲线整体偏移，宁可让调用方显式填。
   */
  const run = async (input: {
    engine: EngineId
    doses: readonly Dose[]
    hormone: HormoneKey
    weightKG: number
    startMS: number
    endMS: number
    stepMin: number
  }): Promise<PkResult | { error: string } | null> => {
    const target = ensure()
    if (target === null) return null

    seq += 1
    const id = `pk-${seq}`
    const request: PkWorkerRequest = {
      id,
      type: 'simulate',
      engine: input.engine,
      doses: [...input.doses],
      range: [input.startMS, input.endMS],
      stepMin: input.stepMin,
      pkParams: { hormone: input.hormone, weightKG: input.weightKG },
    }

    const response = await new Promise<PkWorkerResponse>((resolve) => {
      pending.set(id, resolve)
      target.postMessage(request)
    })

    // 这里**不做**“只认最新一次”的丢弃：一次对比就是两个并发请求，
    // 拿全局序号去卡会把先回来的那条误判成过期（builtin 就这样被吞了）。
    // 过期与否是页面级的事实（它知道这次请求属于哪次选择），由调用方判定。
    if (response.type === 'error') return { error: response.message }
    const { engine, unit, series, auc, peak, warnings } = response
    return { engine, unit, series, auc, peak, warnings }
  }

  if (import.meta.client && getCurrentInstance() !== null) {
    // 组件作用域结束时终止 Worker（含 HMR 反复挂载的情况）。
    onScopeDispose(dispose)
  }

  return { run, dispose }
}
