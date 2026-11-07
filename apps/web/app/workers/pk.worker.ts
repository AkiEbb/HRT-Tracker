/// <reference lib="webworker" />
import {
  type PkWorkerResponse,
  parsePkWorkerRequest,
  simulate,
  toSimDoses,
  toSimulateOptions,
} from '@hrt/pk-core'

/**
 * PK 计算 Worker。
 *
 * 主线程只负责画图：一次 60 天 × 1 分钟步长的求解放在主线程上足以让拖动变卡，
 * 而这里全是纯计算、没有任何 DOM 依赖，正好适合搬走。
 */
const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<unknown>) => {
  let id = ''
  try {
    const request = parsePkWorkerRequest(event.data)
    id = request.id
    const options = toSimulateOptions(request)
    const result = simulate(toSimDoses(request.doses, options.hormone), options)
    const response: PkWorkerResponse = {
      id,
      type: 'result',
      engine: request.engine,
      unit: result.unit,
      series: { t: Float64Array.from(result.tMS), conc: Float64Array.from(result.conc) },
      auc: result.auc,
      peak: result.peak,
      warnings: result.warnings,
    }
    scope.postMessage(response)
  } catch (error) {
    const response: PkWorkerResponse = {
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
    scope.postMessage(response)
  }
}
