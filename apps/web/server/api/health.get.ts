import { CATALOG_SOURCE, simulate, TRANSMTF_SOURCE } from '@hrt/pk-core'
import { PROTOCOL_VERSION } from '@hrt/protocol'

/**
 * workspace 包内联的探针：
 * 这个 handler 同时 import 两个 packages/* 且真的跑一次两个引擎，是双目标构建
 * （node-server / cloudflare_module）能否正确打包 TS-only workspace 包与 JSON 目录的最小验证点。
 * 只返回波形的标量摘要（峰值/ AUC），不返回整条曲线。
 */
export default defineEventHandler(() => {
  const doses = [{ takenAt: 0, compound: 'E2' as const, route: 'gel' as const, doseEquivMG: 1.5 }]
  const range = {
    hormone: 'estradiol' as const,
    weightKG: 62,
    startMS: 0,
    endMS: 168 * 3_600_000,
    stepMin: 60,
  }
  const builtin = simulate(doses, { ...range, engine: 'builtin' })
  const transmtf = simulate(doses, { ...range, engine: 'transmtf' })
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    catalog: CATALOG_SOURCE.name,
    catalogTransmtf: TRANSMTF_SOURCE.name,
    gelPeak: {
      builtin: Math.round(builtin.peak.conc * 10) / 10,
      transmtf: Math.round(transmtf.peak.conc * 10) / 10,
    },
  }
})
