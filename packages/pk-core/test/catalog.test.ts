import { describe, expect, test } from 'bun:test'
import { ESTER_COMPOUNDS, TESTOSTERONE_COMPOUNDS } from '@hrt/protocol'
import {
  CATALOG_SOURCE,
  catalog,
  factorOf,
  hormoneOf,
  isModeledCompound,
  toActiveFactor,
} from '../src/index'

describe('catalog 是唯一真源', () => {
  test('标注了上游来源与取用日期', () => {
    expect(CATALOG_SOURCE.upstream).toContain('HRT-Recorder')
    expect(CATALOG_SOURCE.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('目录里的化合物与内部词汇表一一对应（防漂移）', () => {
    const catalogCompounds = Object.keys(catalog.compounds).sort()
    const vocabulary = [...ESTER_COMPOUNDS, ...TESTOSTERONE_COMPOUNDS].sort()
    expect(catalogCompounds).toEqual(vocabulary)
  })
})

describe('活性当量因子由分子量推导', () => {
  test('非前药为 1', () => {
    expect(toActiveFactor('E2')).toBe(1)
    expect(toActiveFactor('T')).toBe(1)
  })

  test('酯类 = activeMW / MW', () => {
    expect(toActiveFactor('EV')).toBeCloseTo(272.38 / 356.5, 12)
    expect(toActiveFactor('EB')).toBeCloseTo(272.38 / 376.5, 12)
    expect(toActiveFactor('TU')).toBeCloseTo(288.42 / 456.7, 12)
  })

  test('目录外的药物返回 undefined，绝不猜 1', () => {
    expect(toActiveFactor('EU')).toBeUndefined()
    expect(factorOf('EU' as never)).toBeUndefined()
  })

  test('抗雄不建模：没有 PK 参数', () => {
    expect(isModeledCompound('CPA')).toBe(false)
    expect(hormoneOf('CPA')).toBeUndefined()
    expect(hormoneOf('EV')).toBe('estradiol')
    expect(hormoneOf('TU')).toBe('testosterone')
  })
})

describe('关键参数取值（与上游规格一致）', () => {
  test('雌二醇与睾酮的分布容积、清除率', () => {
    expect(catalog.hormones.estradiol?.vdPerKG).toBe(2)
    expect(catalog.hormones.estradiol?.kClear).toBe(0.41)
    expect(catalog.hormones.estradiol?.kClearInjection).toBe(0.041)
    expect(catalog.hormones.testosterone?.kClear).toBe(0.6)
  })

  test('E2 的单次注射 depot 参数齐全', () => {
    expect(catalog.twoPartDepot.EV?.fracFast).toBeCloseTo(0.4, 12)
    expect(catalog.formationFraction.EV).toBeCloseTo(0.062258288229969413, 15)
    expect(catalog.hydrolysisK2.EV).toBe(0.07)
  })

  test('含服途径的四档 theta 都存在', () => {
    for (const key of ['quick', 'casual', 'standard', 'strict'] as const) {
      expect(catalog.sublingual.recommendedTheta[key]).toBeGreaterThan(0)
      expect(catalog.sublingual.holdMinutes[key]).toBeGreaterThan(0)
    }
  })
})
