import { describe, expect, test } from 'bun:test'
import {
  type ActiveFactorOf,
  activeEquivalentMG,
  type Compound,
  DoseError,
  makeDose,
} from '../src/index'

/** 分子量比值（与 catalog 同源），测试里内联以免 protocol 依赖 pk-core。 */
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

const base = { clientUpdatedAt: 1_700_000_000_000 } as const

describe('剂量语义：doseMG 与 doseEquivMG 永不合流', () => {
  test('当量 = 原始质量 × 分子量比值', () => {
    expect(activeEquivalentMG('EV', 5, factorOf)).toBeCloseTo(5 * (272.38 / 356.5), 10)
    expect(activeEquivalentMG('E2', 5, factorOf)).toBe(5)
  })

  test('同为 5mg，EV 与 E2 的当量不同 —— 这是整个项目最容易搞错的一处', () => {
    const ev = makeDose({ ...base, compound: 'EV', route: 'injection', doseMG: 5 }, factorOf)
    const e2 = makeDose({ ...base, compound: 'E2', route: 'injection', doseMG: 5 }, factorOf)

    expect(ev.doseMG).toBe(5)
    expect(e2.doseMG).toBe(5)
    expect(ev.doseEquivMG).toBeLessThan(e2.doseEquivMG)
    expect(ev.doseEquivMG).toBeCloseTo(3.8202, 3)
  })

  test('类别由 compound 推导，不需要调用方传', () => {
    expect(
      makeDose({ ...base, compound: 'TC', route: 'injection', doseMG: 50 }, factorOf).category,
    ).toBe('testosterone')
    expect(makeDose({ ...base, compound: 'E2', route: 'gel', doseMG: 1 }, factorOf).category).toBe(
      'estradiol',
    )
    expect(
      makeDose({ ...base, compound: 'CPA', route: 'oral', doseMG: 50 }, factorOf).category,
    ).toBe('antiAndrogen')
  })

  test('抗雄的当量恒为 0，而不是拿自己的毫克数冒充', () => {
    const payload = makeDose({ ...base, compound: 'CPA', route: 'oral', doseMG: 50 }, factorOf)
    expect(payload.doseMG).toBe(50)
    expect(payload.doseEquivMG).toBe(0)
  })

  test('补丁拆除允许 0 mg', () => {
    const payload = makeDose({ ...base, compound: 'E2', route: 'patchRemove', doseMG: 0 }, factorOf)
    expect(payload.doseMG).toBe(0)
    expect(payload.doseEquivMG).toBe(0)
  })

  test('非法剂量拒绝（负数），并且不会被静默转成 0', () => {
    expect(() =>
      makeDose({ ...base, compound: 'E2', route: 'oral', doseMG: -1 }, factorOf),
    ).toThrow(DoseError)
    expect(() =>
      makeDose({ ...base, compound: 'E2', route: 'oral', doseMG: Number.NaN }, factorOf),
    ).toThrow(DoseError)
  })

  test('缺当量因子时明确报错，不猜 1', () => {
    expect(() =>
      makeDose({ ...base, compound: 'EV', route: 'injection', doseMG: 5 }, () => undefined),
    ).toThrow('no active factor for compound EV')
  })

  test('用户手工覆盖的当量被保留，并打上 equivOverridden', () => {
    const payload = makeDose(
      {
        ...base,
        compound: 'EV',
        route: 'injection',
        doseMG: 5,
        doseEquivMG: 9,
        equivOverridden: true,
      },
      factorOf,
    )
    expect(payload.doseEquivMG).toBe(9)
    expect(payload.equivOverridden).toBe(true)
  })

  test('未声明 overridden 时，传入的当量不被采信', () => {
    const payload = makeDose(
      { ...base, compound: 'EV', route: 'injection', doseMG: 5, doseEquivMG: 9 },
      factorOf,
    )
    expect(payload.doseEquivMG).toBeCloseTo(3.8202, 3)
    expect(payload.equivOverridden).toBeUndefined()
  })
})
