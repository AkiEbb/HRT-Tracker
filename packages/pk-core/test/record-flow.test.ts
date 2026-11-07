import { describe, expect, it } from 'bun:test'
import { makeDose } from '@hrt/protocol'
import { toSimDoses } from '../src/adapter'
import { factorOf } from '../src/catalog'
import catalog from '../src/catalog.json'
import { simulate } from '../src/simulate'

/**
 * 记录 → 引擎的整条链：界面里点一次「保存」写出的 Dose，必须能被引擎原样消费。
 *
 * 这条链最容易断在两处，所以两处都钉住：
 * 1. §4.2 的双剂量——`makeDose` 按 catalog 分子量算出当量，引擎只认当量（ADR 32）；
 * 2. 字段名/单位——页面的记录形状与 `SimDose` 不一致时，类型检查看不出来（记录在
 *    IndexedDB 里是 JSON），只有在真跑一次引擎时才会暴露。
 *
 * 当量的期望值在这里**按分子量手算**，不调用 `factorOf`，否则就是拿实现验实现。
 */

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0)
const DAY = 24 * 3_600_000

const mw = (key: string): number => {
  const found = (catalog.compounds as Record<string, { molecularWeight: number }>)[key]
  if (found === undefined) throw new Error(`catalog 里没有 ${key}`)
  return found.molecularWeight
}

/** 当量 = 药物质量 × 活性部分分子量 / 药物分子量。 */
const expectedEquiv = (doseMG: number, compoundKey: string): number =>
  doseMG * (mw('E2') / mw(compoundKey))

describe('记录流：界面写出的一条 dose 一路走到引擎', () => {
  it('戊酸雌二醇 5 mg 的当量按分子量换算，而不是原样传下去', () => {
    const payload = makeDose(
      {
        compound: 'EV',
        route: 'injection',
        doseMG: 5,
        clientUpdatedAt: T0,
      },
      factorOf,
    )
    expect(payload.doseEquivMG).toBeCloseTo(expectedEquiv(5, 'EV'), 10)
    // 两者语义不同：混用会让 5 mg 戊酸雌二醇被当成 5 mg 雌二醇（差 1.31 倍）
    expect(payload.doseEquivMG).toBeLessThan(5)
  })

  it('引擎拿到的正是当量，不是原始剂量', () => {
    const payload = makeDose(
      {
        compound: 'EV',
        route: 'injection',
        doseMG: 5,
        clientUpdatedAt: T0,
      },
      factorOf,
    )
    const dose = { id: 'd1', takenAt: T0, payload }
    const [sim] = toSimDoses([dose], 'estradiol')
    expect(sim?.doseEquivMG).toBe(payload.doseEquivMG)
    expect(sim?.doseEquivMG).not.toBe(5)
  })

  it('一条注射记录算出的区间最高值落在当量对应的合理区间内', () => {
    const payload = makeDose(
      {
        compound: 'EV',
        route: 'injection',
        doseMG: 5,
        clientUpdatedAt: T0,
      },
      factorOf,
    )
    const doses = toSimDoses([{ id: 'd1', takenAt: T0, payload }], 'estradiol')
    const result = simulate(doses, {
      engine: 'builtin',
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 14 * DAY,
      stepMin: 60,
    })
    // 独立判据：单次肌注的峰值必然低于「当量全部瞬时进入 2 L/kg × 62 kg 的分布体积」
    // 这个上界（约 3.82 mg / 124 L ≈ 30 800 pg/mL），同时远高于 0。
    const ceilingPGperML = (payload.doseEquivMG * 1e9) / (2 * 62 * 1000)
    expect(result.peak.conc).toBeGreaterThan(0)
    expect(result.peak.conc).toBeLessThan(ceilingPGperML)
    expect(result.tMS.length).toBe(result.conc.length)
  })
})
