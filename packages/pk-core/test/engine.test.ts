import { describe, expect, test } from 'bun:test'
import { catalog, type SimDose, simulate } from '../src/index'

const H = 3_600_000
const T0 = 1_764_000_000_000

const E2_VD = catalog.hormones.estradiol?.vdPerKG ?? Number.NaN
/** 非注射途径的表观清除率。 */
const E2_K = catalog.hormones.estradiol?.kClear ?? Number.NaN
/** 注射途径的表观清除率（catalog 的 kClearInjection）。 */
const E2_K_INJ = catalog.hormones.estradiol?.kClearInjection ?? Number.NaN

/** 单链解析解：depot(A0) --a--> plasma --b--> active --c--> 清除。 */
function chain(tH: number, a: number, b: number, c: number, a0: number): number {
  const term = (r: number, d1: number, d2: number): number => Math.exp(-r * tH) / (d1 * d2)
  return a0 * a * b * (term(a, b - a, c - a) + term(b, a - b, c - b) + term(c, a - c, b - c))
}

const concScale = (weightKG: number, unitFactor: number): number =>
  unitFactor / (E2_VD * weightKG * 1000)

const evInjection = (doseMG: number, atMS = T0): SimDose => ({
  takenAt: atMS,
  compound: 'EV',
  route: 'injection',
  doseEquivMG: doseMG * (272.38 / 356.5),
})

describe('builtin 引擎：与解析解对齐', () => {
  test('单次注射在多个时刻与闭式解一致（相对误差 < 1e-6）', () => {
    const weightKG = 62
    const dose = evInjection(5)
    const depot = catalog.twoPartDepot.EV
    const formation = catalog.formationFraction.EV ?? Number.NaN
    const hydrolysis = catalog.hydrolysisK2.EV ?? Number.NaN

    const result = simulate([dose], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 200 * H,
      stepMin: 60,
    })

    const total = dose.doseEquivMG * formation
    const scale = concScale(weightKG, 1e9)

    for (const tH of [1, 12, 48, 120, 199]) {
      const expected =
        (chain(tH, (depot?.k1Fast ?? 0) * 1, hydrolysis, E2_K_INJ, total * (depot?.fracFast ?? 0)) +
          chain(
            tH,
            (depot?.k1Slow ?? 0) * 1,
            hydrolysis,
            E2_K_INJ,
            total * (1 - (depot?.fracFast ?? 0)),
          )) *
        scale
      const index = Math.round(tH / 1)
      const actual = result.conc[index] ?? Number.NaN
      expect(Math.abs(actual - expected) / Math.max(expected, 1e-12)).toBeLessThan(1e-6)
    }
  })

  test('AUC 恒等式：面积 = 活性物质总量 / 清除率', () => {
    const weightKG = 62
    const dose = evInjection(5)
    const result = simulate([dose], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 3000 * H,
      stepMin: 60,
    })

    const formation = catalog.formationFraction.EV ?? Number.NaN
    const expected = (dose.doseEquivMG * formation * 1e9) / (E2_VD * weightKG * 1000 * E2_K_INJ)

    expect(Math.abs(result.auc - expected) / expected).toBeLessThan(2e-3)
  })

  test('线性叠加：两剂分别算再相加 == 一次算两剂', () => {
    const weightKG = 55
    const single = evInjection(5)
    const second = evInjection(3, T0 + 100 * H)

    const both = simulate([single, second], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 400 * H,
      stepMin: 60,
    })
    const onlyFirst = simulate([single], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 400 * H,
      stepMin: 60,
    })
    const onlySecond = simulate([second], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 400 * H,
      stepMin: 60,
    })

    for (let i = 0; i < both.conc.length; i += 1) {
      const summed = (onlyFirst.conc[i] ?? 0) + (onlySecond.conc[i] ?? 0)
      expect(Math.abs((both.conc[i] ?? 0) - summed)).toBeLessThan(1e-9)
    }
  })

  test('步长收敛：内部步长 1 分钟 vs 0.25 分钟结果一致', () => {
    const coarse = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 200 * H,
      stepMin: 60,
      internalStepMin: 1,
    })
    const fine = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 200 * H,
      stepMin: 60,
      internalStepMin: 0.25,
    })

    for (let i = 0; i < coarse.conc.length; i += 1) {
      const a = coarse.conc[i] ?? 0
      const b = fine.conc[i] ?? 0
      expect(Math.abs(a - b) / Math.max(b, 1e-12)).toBeLessThan(1e-6)
    }
  })
})

describe('builtin 引擎：结构不变量', () => {
  test('浓度永不为负，且单次注射只有一个峰', () => {
    const result = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 1500 * H,
      stepMin: 60,
    })
    expect(result.conc.every((c) => c >= 0)).toBe(true)

    const peakIndex = result.conc.indexOf(result.peak.conc)
    const before = result.conc.slice(0, peakIndex)
    const after = result.conc.slice(peakIndex)
    expect(before.every((c, i) => i === 0 || c >= (before[i - 1] ?? 0))).toBe(true)
    expect(after.every((c, i) => i === 0 || c <= (after[i - 1] ?? 0))).toBe(true)
  })

  test('剂量翻倍，曲线整体翻倍', () => {
    const one = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 200 * H,
      stepMin: 60,
    })
    const two = simulate([evInjection(10)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 200 * H,
      stepMin: 60,
    })
    for (let i = 0; i < one.conc.length; i += 1) {
      expect(two.conc[i] ?? 0).toBeCloseTo((one.conc[i] ?? 0) * 2, 9)
    }
  })

  test('体重越大峰值越低（分布容积随体重线性增长）', () => {
    const light = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 45,
      startMS: T0,
      endMS: T0 + 500 * H,
      stepMin: 60,
    })
    const heavy = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 90,
      startMS: T0,
      endMS: T0 + 500 * H,
      stepMin: 60,
    })
    expect(light.peak.conc).toBeCloseTo(heavy.peak.conc * 2, 6)
  })

  test('睾酮用 ng/dL，雌二醇用 pg/mL', () => {
    const t = simulate(
      [{ takenAt: T0, compound: 'TC', route: 'injection', doseEquivMG: 100 * (288.42 / 412.61) }],
      { hormone: 'testosterone', weightKG: 70, startMS: T0, endMS: T0 + 500 * H, stepMin: 60 },
    )
    const e = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 70,
      startMS: T0,
      endMS: T0 + 500 * H,
      stepMin: 60,
    })
    expect(t.unit).toBe('ng/dl')
    expect(e.unit).toBe('pg/ml')
  })

  test('数量级哨兵：单位换算写错 1e3 会立刻被抓到', () => {
    const e = simulate([evInjection(5)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 1500 * H,
      stepMin: 60,
    })
    const t = simulate(
      [{ takenAt: T0, compound: 'TC', route: 'injection', doseEquivMG: 100 * (288.42 / 412.61) }],
      { hormone: 'testosterone', weightKG: 70, startMS: T0, endMS: T0 + 1500 * H, stepMin: 60 },
    )
    // 宽区间只为抓单位错误：真实峰值应落在两位到三位数区间。
    expect(e.peak.conc).toBeGreaterThan(1)
    expect(e.peak.conc).toBeLessThan(2000)
    expect(t.peak.conc).toBeGreaterThan(1)
    expect(t.peak.conc).toBeLessThan(5000)
  })
})

describe('builtin 引擎：注射途径的量级与已发表 PK 一致', () => {
  const run = (
    doses: SimDose[],
    hormone: 'estradiol' | 'testosterone',
    weightKG: number,
  ): ReturnType<typeof simulate> =>
    simulate(doses, { hormone, weightKG, startMS: T0, endMS: T0 + 1500 * H, stepMin: 60 })

  test('注射走 kClearInjection 而不是 kClear（差 10 倍，不能混）', () => {
    const dose = evInjection(5)
    const result = run([dose], 'estradiol', 62)
    const formation = catalog.formationFraction.EV ?? Number.NaN
    const withInjection = (dose.doseEquivMG * formation * 1e9) / (E2_VD * 62 * 1000 * E2_K_INJ)
    const withPlain = (dose.doseEquivMG * formation * 1e9) / (E2_VD * 62 * 1000 * E2_K)
    expect(Math.abs(result.auc - withInjection) / withInjection).toBeLessThan(0.05)
    expect(Math.abs(result.auc - withPlain) / withPlain).toBeGreaterThan(5)
  })

  test('EV 5mg IM：峰值与暴露量落在实测区间', () => {
    const result = run([evInjection(5)], 'estradiol', 62)
    // 文献：Cmax 约 200–400 pg/mL，Tmax 1–3 天，2 周 AUC 约 3–5×10⁴ pg·h/mL。
    expect(result.peak.conc).toBeGreaterThan(150)
    expect(result.peak.conc).toBeLessThan(900)
    expect(result.auc).toBeGreaterThan(25_000)
    expect(result.auc).toBeLessThan(70_000)
    const peakH = (result.peak.tMS - T0) / H
    expect(peakH).toBeGreaterThan(6)
    expect(peakH).toBeLessThan(96)
  })

  test('EN 10mg IM：一周内维持在百位数 pg/mL', () => {
    const result = run(
      [{ takenAt: T0, compound: 'EN', route: 'injection', doseEquivMG: 10 * (272.38 / 384.56) }],
      'estradiol',
      62,
    )
    expect(result.peak.conc).toBeGreaterThan(200)
    expect(result.peak.conc).toBeLessThan(900)
    const week = result.conc[7 * 24] ?? 0
    expect(week).toBeGreaterThan(100)
  })

  test('TC 100mg/周：平均睾酮落在生理替代区间', () => {
    const result = run(
      [{ takenAt: T0, compound: 'TC', route: 'injection', doseEquivMG: 100 * (288.42 / 412.61) }],
      'testosterone',
      70,
    )
    // 文献：100mg/周 Depot 睾酮，峰值 400–700 ng/dL，周均 400–800 ng/dL。
    expect(result.peak.conc).toBeGreaterThan(250)
    expect(result.peak.conc).toBeLessThan(1200)
    const weeklyAverage = result.auc / (7 * 24)
    expect(weeklyAverage).toBeGreaterThan(350)
    expect(weeklyAverage).toBeLessThan(900)
  })
})

describe('builtin 引擎：注射与非注射共用系统时仍是线性叠加', () => {
  test('注射 + 口服 == 分别计算后相加', () => {
    const weightKG = 62
    const injection = evInjection(5)
    const oral: SimDose = { takenAt: T0 + 4 * H, compound: 'E2', route: 'oral', doseEquivMG: 2 }
    const req = {
      hormone: 'estradiol' as const,
      weightKG,
      startMS: T0,
      endMS: T0 + 400 * H,
      stepMin: 60,
    }
    const both = simulate([injection, oral], req)
    const a = simulate([injection], req)
    const b = simulate([oral], req)
    for (let i = 0; i < both.conc.length; i += 1) {
      const summed = (a.conc[i] ?? 0) + (b.conc[i] ?? 0)
      expect(Math.abs((both.conc[i] ?? 0) - summed) / Math.max(summed, 1e-9)).toBeLessThan(1e-6)
    }
  })
})

describe('builtin 引擎：非注射途径', () => {
  test('口服雌二醇：生物利用度低，峰值远低于同剂量注射', () => {
    const oral = simulate([{ takenAt: T0, compound: 'E2', route: 'oral', doseEquivMG: 2 }], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 100 * H,
      stepMin: 15,
    })
    const injected = simulate([evInjection(2)], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 100 * H,
      stepMin: 15,
    })
    expect(oral.auc).toBeGreaterThan(0)
    expect(oral.auc).toBeLessThan(injected.auc)
  })

  test('含服 theta 越高，绕过的首过越多', () => {
    const low = simulate(
      [
        {
          takenAt: T0,
          compound: 'E2',
          route: 'sublingual',
          doseEquivMG: 2,
          extras: { theta: 0.01 },
        },
      ],
      { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 + 100 * H, stepMin: 15 },
    )
    const high = simulate(
      [
        {
          takenAt: T0,
          compound: 'E2',
          route: 'sublingual',
          doseEquivMG: 2,
          extras: { theta: 0.18 },
        },
      ],
      { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 + 100 * H, stepMin: 15 },
    )
    expect(high.auc).toBeGreaterThan(low.auc)
  })

  test('凝胶：吸收总量封顶在 Fmax，AUC 因此可预测', () => {
    const weightKG = 62
    const dose = 1.5
    const result = simulate([{ takenAt: T0, compound: 'E2', route: 'gel', doseEquivMG: dose }], {
      hormone: 'estradiol',
      weightKG,
      startMS: T0,
      endMS: T0 + 3000 * H,
      stepMin: 60,
    })
    const fmax = catalog.hormones.estradiol?.gelFmax ?? Number.NaN
    const expected = (dose * fmax * 1e9) / (E2_VD * weightKG * 1000 * E2_K)
    expect(Math.abs(result.auc - expected) / expected).toBeLessThan(5e-3)
  })

  test('贴片：恒速释放，AUC = 通量 × 佩戴时长 / 清除率', () => {
    const weightKG = 62
    const wearHours = 72
    const rateUgPerDay = 100
    const result = simulate(
      [
        {
          takenAt: T0,
          compound: 'E2',
          route: 'patchApply',
          doseEquivMG: 0,
          extras: { releaseRateUgPerDay: rateUgPerDay },
        },
        { takenAt: T0 + wearHours * H, compound: 'E2', route: 'patchRemove', doseEquivMG: 0 },
      ],
      { hormone: 'estradiol', weightKG, startMS: T0, endMS: T0 + 3000 * H, stepMin: 60 },
    )
    const deliveredMG = ((rateUgPerDay * 1e-3) / 24) * wearHours
    const expected = (deliveredMG * 1e9) / (E2_VD * weightKG * 1000 * E2_K)
    expect(Math.abs(result.auc - expected) / expected).toBeLessThan(5e-3)
  })

  test('贴片佩戴期间浓度上升，拆除后下降', () => {
    const wearHours = 48
    const result = simulate(
      [
        {
          takenAt: T0,
          compound: 'E2',
          route: 'patchApply',
          doseEquivMG: 0,
          extras: { releaseRateUgPerDay: 100 },
        },
        { takenAt: T0 + wearHours * H, compound: 'E2', route: 'patchRemove', doseEquivMG: 0 },
      ],
      { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 + 200 * H, stepMin: 60 },
    )
    const atWearEnd = result.conc[wearHours] ?? 0
    const later = result.conc[wearHours + 48] ?? 0
    expect(atWearEnd).toBeGreaterThan(later)
  })
})

describe('builtin 引擎：拒绝坏输入，不静默猜', () => {
  test('抗雄没有 PK 参数 → 跳过并留原因', () => {
    const result = simulate([{ takenAt: T0, compound: 'CPA', route: 'oral', doseEquivMG: 0 }], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 10 * H,
      stepMin: 60,
    })
    expect(result.conc.every((c) => c === 0)).toBe(true)
    expect(result.warnings.some((w) => w.includes('CPA'))).toBe(true)
  })

  test('贴片没拆除 → 按 24 小时计并警告', () => {
    const result = simulate(
      [
        {
          takenAt: T0,
          compound: 'E2',
          route: 'patchApply',
          doseEquivMG: 0,
          extras: { releaseRateUgPerDay: 100 },
        },
      ],
      { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 + 100 * H, stepMin: 60 },
    )
    expect(result.warnings.some((w) => w.includes('24 小时'))).toBe(true)
  })

  test('贴片没释放速率但有标称当量 → 用 fallback 并警告', () => {
    const result = simulate(
      [
        { takenAt: T0, compound: 'E2', route: 'patchApply', doseEquivMG: 0.75 },
        { takenAt: T0 + 72 * H, compound: 'E2', route: 'patchRemove', doseEquivMG: 0 },
      ],
      { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 + 300 * H, stepMin: 60 },
    )
    expect(result.warnings.some((w) => w.includes('fallback'))).toBe(true)
    expect(result.auc).toBeGreaterThan(0)
  })

  test('事件体重与全局体重差得远 → 提示（v0.1 只用全局体重）', () => {
    const result = simulate([{ ...evInjection(5), weightKG: 90 }], {
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 100 * H,
      stepMin: 60,
    })
    expect(result.warnings.some((w) => w.includes('90kg'))).toBe(true)
  })

  test('非法体重与非法区间抛错', () => {
    expect(() =>
      simulate([], { hormone: 'estradiol', weightKG: 0, startMS: T0, endMS: T0 + H }),
    ).toThrow('weightKG')
    expect(() =>
      simulate([], { hormone: 'estradiol', weightKG: 62, startMS: T0, endMS: T0 }),
    ).toThrow('endMS')
  })

  test('采样点数过多时拒绝，而不是把浏览器锁死', () => {
    expect(() =>
      simulate([], {
        hormone: 'estradiol',
        weightKG: 62,
        startMS: T0,
        endMS: T0 + 365 * 24 * H,
        stepMin: 0.1,
      }),
    ).toThrow('too many samples')
  })
})
