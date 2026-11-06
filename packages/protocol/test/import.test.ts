import { describe, expect, test } from 'bun:test'
import kiraBasic from '../fixtures/kira/basic.json'
import kiraEdge from '../fixtures/kira/edge.json'
import transmtfBasic from '../fixtures/transmtf/basic.json'
import {
  type ActiveFactorOf,
  type Compound,
  exportKiraHrt,
  type ImportOptions,
  importKiraHrt,
  importTransmtf,
  msToTimeH,
  timeHToMS,
} from '../src/index'

const FACTORS: Partial<Record<Compound, number>> = {
  E2: 1,
  EB: 272.38 / 376.5,
  EV: 272.38 / 356.5,
  EC: 272.38 / 396.58,
  EN: 272.38 / 384.56,
  T: 1,
  TC: 288.42 / 412.61,
  TE: 288.42 / 400.59,
  TU: 288.42 / 456.7,
}

const factorOf: ActiveFactorOf = (compound) => FACTORS[compound]
const opts = (extra: Partial<ImportOptions> = {}): ImportOptions => ({
  factorOf,
  now: () => 1_700_000_000_000,
  ...extra,
})

describe('kira-hrt 导入', () => {
  test('事件与化验按条数落库，时间按小时换算成毫秒', () => {
    const result = importKiraHrt(kiraBasic, opts())

    expect(result.doses).toHaveLength(4)
    expect(result.labs).toHaveLength(2)
    expect(result.report.skipped).toHaveLength(0)
    expect(result.doses[0]?.takenAt).toBe(timeHToMS(490000))
    expect(result.doses[0]?.payload.route).toBe('injection')
    expect(result.doses[0]?.payload.compound).toBe('EV')
  })

  test('doseMG 原样保留，当量按 compound 换算', () => {
    const ev = importKiraHrt(kiraBasic, opts()).doses[0]
    expect(ev?.payload.doseMG).toBe(5)
    expect(ev?.payload.doseEquivMG).toBeCloseTo(3.8202, 3)
  })

  test('rate 模式的贴片允许 doseMG = 0（释放速率在 extras 里）', () => {
    const patch = importKiraHrt(kiraBasic, opts()).doses.find(
      (d) => d.payload.route === 'patchApply',
    )
    expect(patch?.payload.doseMG).toBe(0)
    expect(patch?.payload.extras?.releaseRateUgPerDay).toBe(100)
  })

  test('化验的 analyte 是权威字段，监测项单独保留', () => {
    const { labs } = importKiraHrt(kiraBasic, opts())
    expect(labs[0]?.payload.analyte).toBe('E2')
    expect(labs[0]?.payload.monitoring?.prolactin).toBe(12.3)
    expect(labs[1]?.payload.analyte).toBe('T')
  })

  test('缺 format 与 meta.version 的载荷被拒绝，而不是猜成 kira', () => {
    expect(() => importKiraHrt({ events: [] }, opts())).toThrow('missing')
  })

  test('损坏行只跳过自己，并留下可读原因', () => {
    const { doses, report } = importKiraHrt(kiraEdge, opts())
    const reasons = report.skipped.map((s) => s.reason)

    expect(doses).toHaveLength(3)
    expect(reasons).toContain('unknown route: intramuscular')
    expect(reasons.some((r) => r.startsWith('invalid time'))).toBe(true)
    expect(reasons.some((r) => r.startsWith('invalid dose'))).toBe(true)
    // 0 mg 的普通给药不合法，但 patchRemove 才允许 —— 这里必须是拒绝。
    expect(reasons.some((r) => r === 'invalid dose: 0')).toBe(true)
  })

  test('未知酯降级为 E2 并留痕，不静默', () => {
    const { report, doses } = importKiraHrt(kiraEdge, opts())
    expect(report.warnings.some((w) => w.includes('unknown ester "EU"'))).toBe(true)
    expect(doses.some((d) => d.payload.compound === 'E2' && d.id === 'unknown-ester')).toBe(true)
  })

  test('缺 analyte 的旧化验默认为 unknown，绝不按单位猜', () => {
    const { labs } = importKiraHrt(kiraEdge, opts())
    const legacy = labs.find((l) => l.id === 'legacy-e2')
    expect(legacy?.payload.analyte).toBe('unknown')
    expect(legacy?.payload.concValue).toBe(120)
  })

  test('显式 unknown 永不被单位推断覆盖，即使开关打开', () => {
    const { labs } = importKiraHrt(kiraEdge, opts({ inferAnalyteFromUnit: true }))
    expect(labs.find((l) => l.id === 'legacy-e2')?.payload.analyte).toBe('E2')
    expect(labs.find((l) => l.id === 'legacy-t')?.payload.analyte).toBe('T')
    expect(labs.find((l) => l.id === 'explicit-unknown')?.payload.analyte).toBe('unknown')
  })

  test('既无浓度又无监测项的化验被丢弃并计入报告', () => {
    const { report } = importKiraHrt(kiraEdge, opts())
    expect(report.skipped.some((s) => s.reason === 'no measurable value')).toBe(true)
  })

  test('只有监测项的记录仍然保留', () => {
    const { labs } = importKiraHrt(kiraEdge, opts())
    const monitoringOnly = labs.find((l) => l.id === 'monitoring-only')
    expect(monitoringOnly?.payload.concValue).toBeUndefined()
    expect(monitoringOnly?.payload.monitoring?.alt).toBe(22)
  })

  test('缺体重的旧数据回落到备份级 bodyWeightKg', () => {
    const { doses } = importKiraHrt(kiraBasic, opts())
    expect(doses[0]?.payload.weightKG).toBe(62)
  })
})

describe('kira-hrt 导出与往返', () => {
  test('往返后 doseMG 与时间逐条等值', () => {
    const first = importKiraHrt(kiraBasic, opts())
    const { data } = exportKiraHrt(first.doses, first.labs)
    const second = importKiraHrt(data, opts())

    expect(second.doses).toHaveLength(first.doses.length)
    second.doses.forEach((dose, index) => {
      const original = first.doses[index]
      if (original === undefined) throw new Error(`missing dose at ${index}`)
      expect(dose.payload.doseMG).toBe(original.payload.doseMG)
      expect(dose.takenAt).toBe(original.takenAt)
    })
    second.labs.forEach((lab, index) => {
      const original = first.labs[index]
      if (original === undefined) throw new Error(`missing lab at ${index}`)
      expect(lab.payload.analyte).toBe(original.payload.analyte)
      expect(lab.takenAt).toBe(original.takenAt)
    })
  })

  test('协议表达不了的内容被明确报告，而不是静默丢弃', () => {
    const first = importKiraHrt(kiraBasic, opts())
    const { warnings } = exportKiraHrt(first.doses, first.labs)
    expect(warnings.some((w) => w.includes('备注'))).toBe(true)
  })

  test('timeH 往返不引入漂移', () => {
    for (const ms of [0, 1, 1_764_000_000_000, 1_764_000_001_234]) {
      expect(timeHToMS(msToTimeH(ms))).toBe(ms)
    }
  })
})

describe('transmtf 导入', () => {
  test('同一套字段，外壳更松；未建模字段进 preserved', () => {
    const { doses, labs, report } = importTransmtf(transmtfBasic, opts())
    expect(doses).toHaveLength(2)
    expect(labs).toHaveLength(1)
    expect(report.preserved.gelProducts).toBeDefined()
    expect(doses[1]?.payload.extras?.gelProductId).toBe('g1')
  })

  test('按事件的体重优先于备份级体重', () => {
    const { doses } = importTransmtf(transmtfBasic, opts())
    expect(doses[0]?.payload.weightKG).toBe(58)
    expect(doses[1]?.payload.weightKG).toBe(59)
  })

  test('备份级体重作为缺失时的回落值', () => {
    const { doses } = importTransmtf(
      { events: [{ id: 'x', timeH: 1, route: 'oral', ester: 'E2', doseMG: 1 }], bodyWeightKg: 71 },
      opts(),
    )
    expect(doses[0]?.payload.weightKG).toBe(71)
  })
})
