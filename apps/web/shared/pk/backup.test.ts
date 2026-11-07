import { describe, expect, test } from 'bun:test'
import { type ActiveFactorOf, timeHToMS } from '@hrt/protocol'
import { detectFormat, parseBackup, preservedKeys, summarize } from './backup'

/**
 * 导入判定与落库前的准备。
 *
 * 用独立判据：当量的期望值按分子量手算写死在这里，不调用 `factorOf` 的返回值反推；
 * 时间期望值来自 `timeHToMS`（协议层已单测）乘以小时数，而不是读回来再比。
 */

const FACTORS: Record<string, number> = { E2: 1, EV: 272.38 / 356.5 }
const factorOf: ActiveFactorOf = (compound) => FACTORS[compound]

const kiraBackup = {
  format: 'kira-hrt',
  version: 1,
  bodyWeightKg: 58,
  events: [
    { id: 'e1', timeH: 490000, route: 'injection', ester: 'EV', doseMG: 5 },
    {
      id: 'e2',
      timeH: 490168,
      route: 'patchApply',
      ester: 'E2',
      doseMG: 0,
      extras: { releaseRateUgPerDay: 100 },
    },
    { id: 'bad', timeH: 490200, route: 'warp', ester: 'E2', doseMG: 2 },
  ],
  labResults: [{ id: 'l1', timeH: 490500, analyte: 'E2', concValue: 120, unit: 'pg/ml' }],
}

const transmtfBackup = {
  events: [{ id: 't1', timeH: 490000, route: 'gel', ester: 'E2', doseMG: 1.5 }],
  gelProducts: [{ name: '某凝胶', strengthMGPerG: 1 }],
}

const opts = () => ({ factorOf, now: () => 1_700_000_000_000 })

describe('detectFormat：靠标记，不靠字段猜', () => {
  test('format: "kira-hrt" 是确定判定', () => {
    expect(detectFormat({ format: 'kira-hrt' })).toEqual({ format: 'kira-hrt', certain: true })
  })

  test('meta.version 也是 Kira 的标记', () => {
    expect(detectFormat({ meta: { version: 1 } })).toEqual({ format: 'kira-hrt', certain: true })
  })

  test('只有 events 时判为 Transmtf，并标明"不确定"', () => {
    expect(detectFormat({ events: [] })).toEqual({ format: 'transmtf', certain: false })
  })

  test('数组与非对象不抛错，一律按 Transmtf', () => {
    expect(detectFormat([1, 2]).format).toBe('transmtf')
    expect(detectFormat(null).format).toBe('transmtf')
  })

  test('meta.version 不是数字时不认', () => {
    expect(detectFormat({ meta: { version: '1' } }).format).toBe('transmtf')
  })
})

describe('parseBackup：一条坏行不拖垮整个文件', () => {
  test('Kira 备份：两条有效、一条跳过、一条化验', () => {
    const parsed = parseBackup(JSON.stringify(kiraBackup), opts())
    expect(parsed.format).toBe('kira-hrt')
    expect(parsed.result.doses).toHaveLength(2)
    expect(parsed.result.labs).toHaveLength(1)
    expect(parsed.result.report.skipped).toEqual([{ index: 2, reason: 'unknown route: warp' }])
  })

  test('当量按分子量换算，时间按小时换算', () => {
    const dose = parseBackup(JSON.stringify(kiraBackup), opts()).result.doses[0]
    expect(dose?.payload.doseMG).toBe(5)
    expect(dose?.payload.doseEquivMG).toBeCloseTo((5 * 272.38) / 356.5, 4)
    expect(dose?.takenAt).toBe(timeHToMS(490000))
  })

  test('外层 bodyWeightKg 成为缺失体重时的兜底', () => {
    const dose = parseBackup(JSON.stringify(kiraBackup), opts()).result.doses[0]
    expect(dose?.payload.weightKG).toBe(58)
  })

  test('坏 JSON 直接抛错，报错信息说人话', () => {
    expect(() => parseBackup('{oops', opts())).toThrow(/不是合法的 JSON/)
  })

  test('强制指定格式时，判定结果标记为不确定', () => {
    const parsed = parseBackup(JSON.stringify(kiraBackup), { ...opts(), format: 'transmtf' })
    expect(parsed.format).toBe('transmtf')
    expect(parsed.certain).toBe(false)
    // 字段同源，换个壳照样能读
    expect(parsed.result.doses).toHaveLength(2)
  })

  test('缺 analyte 时不猜；显式开启才按单位推断', () => {
    const raw = JSON.stringify({
      events: [],
      labResults: [{ timeH: 1, concValue: 3, unit: 'ng/dl' }],
    })
    expect(parseBackup(raw, opts()).result.labs[0]?.payload.analyte).toBe('unknown')
    expect(
      parseBackup(raw, { ...opts(), inferAnalyteFromUnit: true }).result.labs[0]?.payload.analyte,
    ).toBe('T')
  })

  test('未建模的顶层字段被保留而不是丢掉', () => {
    const parsed = parseBackup(JSON.stringify(transmtfBackup), opts())
    expect(preservedKeys(parsed.result.report)).toContain('gelProducts')
    expect(parsed.result.doses).toHaveLength(1)
  })
})

describe('summarize：界面那句话与报告出自同一份事实', () => {
  test('有跳过时把跳过数也算进去', () => {
    const parsed = parseBackup(JSON.stringify(kiraBackup), opts())
    expect(summarize(parsed.result)).toBe('2 条给药，1 条化验，跳过 1 条')
  })

  test('全部成功时不提跳过', () => {
    const parsed = parseBackup(JSON.stringify(transmtfBackup), opts())
    expect(summarize(parsed.result)).toBe('1 条给药，0 条化验')
  })
})
