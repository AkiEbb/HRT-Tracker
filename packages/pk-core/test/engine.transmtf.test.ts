import { describe, expect, test } from 'bun:test'
import {
  gelProductById,
  resolveGelKinetics,
  type SimDose,
  type SimulateOptions,
  simulate,
  transmtfCatalog,
} from '../src/index'

const H = 3_600_000
const T0 = 1_764_000_000_000
const VD = transmtfCatalog.core.vdPerKG
const KE = transmtfCatalog.core.kClear
const KE_INJ = transmtfCatalog.core.kClearInjection

const weightKG = 62
const vdML = VD * weightKG * 1000
/** mg → pg/mL。 */
const toPGML = (mg: number): number => (mg * 1e9) / vdML

const req = (over: Partial<SimulateOptions> = {}): SimulateOptions => ({
  engine: 'transmtf',
  hormone: 'estradiol',
  weightKG,
  startMS: T0,
  endMS: T0 + 240 * H,
  stepMin: 15,
  ...over,
})

const gelDose = (doseMG: number, extras?: Record<string, unknown>): SimDose =>
  ({
    takenAt: T0,
    compound: 'E2',
    route: 'gel',
    doseEquivMG: doseMG,
    ...(extras === undefined ? {} : { extras }),
  }) as SimDose

/**
 * 三室级联的闭式解（外部预言机）。
 *
 * 与引擎里「把损失那份提前扣掉」的写法是同一个线性方程组的两种写法：这里直接
 * 按上游的方程写
 *   M_s' = -(kPen+kLoss)M_s, M_skin' = kPen·M_s - kRel·M_skin, M_c' = kRel·M_skin - ke·M_c
 * 的部分分式解，用来验证引擎的等价改写没有走样。
 */
function gelCentralAmount(
  doseMG: number,
  t: number,
  kPen: number,
  kLoss: number,
  kRel: number,
  ke: number,
  washAfterH?: number,
): number {
  const l1 = kPen + kLoss
  const central = (tau: number): number => {
    const [a, b, c] = [l1, kRel, ke]
    const e1 = Math.exp(-a * tau) / ((b - a) * (c - a))
    const e2 = Math.exp(-b * tau) / ((a - b) * (c - b))
    const e3 = Math.exp(-c * tau) / ((a - c) * (b - c))
    return doseMG * kPen * kRel * (e1 + e2 + e3)
  }
  const skin = (tau: number): number =>
    (doseMG * kPen * (Math.exp(-l1 * tau) - Math.exp(-kRel * tau))) / (kRel - l1)

  const wash = washAfterH !== undefined && washAfterH > 0 ? washAfterH : Number.POSITIVE_INFINITY
  if (t <= wash) return Math.max(0, central(t))
  const s = t - wash
  const mcWash = central(wash)
  const mSkinWash = skin(wash)
  const b = kRel
  const c = ke
  const mc =
    mcWash * Math.exp(-c * s) + (kRel * mSkinWash * (Math.exp(-b * s) - Math.exp(-c * s))) / (c - b)
  return Math.max(0, mc)
}

describe('transmtf 引擎：凝胶三室级联与闭式解逐点一致', () => {
  const product = gelProductById(1) // Oestrogel
  const k = resolveGelKinetics(product, 'arm', 1.5, product.defaultAreaCM2)
  const doseMG = 1.5

  test('与上游方程的部分分式解一致（相对误差 < 1e-6）', () => {
    const result = simulate([gelDose(doseMG)], req({ stepMin: 1 }))
    for (const hours of [1, 3, 8, 24, 48, 96, 168]) {
      const index = result.tMS.findIndex((ms) => Math.abs(ms - (T0 + hours * H)) < 1)
      expect(index).toBeGreaterThanOrEqual(0)
      const expected = toPGML(gelCentralAmount(doseMG, hours, k.kPen, k.kLoss, k.kRel, KE))
      const actual = result.conc[index] ?? Number.NaN
      expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6)
    }
  })

  test('洗掉时刻之后仍与分段闭式解一致', () => {
    const wash = 1
    const result = simulate([gelDose(doseMG, { gelWashAfterH: wash })], req({ stepMin: 1 }))
    for (const hours of [0.5, 1, 2, 6, 24, 72]) {
      const index = result.tMS.findIndex((ms) => Math.abs(ms - (T0 + hours * H)) < 1)
      const expected = toPGML(gelCentralAmount(doseMG, hours, k.kPen, k.kLoss, k.kRel, KE, wash))
      const actual = result.conc[index] ?? Number.NaN
      expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-6)
    }
  })

  test('1 小时后洗掉，暴露保留率约为 1 − exp(-(kPen+kLoss)·1) ≈ 0.75', () => {
    const clean = simulate([gelDose(doseMG)], req())
    const washed = simulate([gelDose(doseMG, { gelWashAfterH: 1 })], req())
    // 洗掉只删掉「还没穿过角质层的药」，已经进入皮肤储库的部分照样贡献暴露，
    // 所以保留率是已渗透量 1 − e^{-l1·wash}，而不是剩余量 e^{-l1·wash}。
    const expected = 1 - Math.exp(-(k.kPen + k.kLoss) * 1)
    expect(washed.auc / clean.auc).toBeCloseTo(expected, 3)
    // 产品标签：EstroGel 1 小时洗掉暴露 -22%，Divigel -30%。
    expect(washed.auc / clean.auc).toBeGreaterThan(0.6)
    expect(washed.auc / clean.auc).toBeLessThan(0.85)
  })
})

describe('transmtf 引擎：结构不变量', () => {
  test('AUC 恒等于 吸收总量 / 清除率（与级联形状无关）', () => {
    const product = gelProductById(1)
    const k = resolveGelKinetics(product, 'arm', 1.5, product.defaultAreaCM2)
    const absorbed = 1.5 * (k.kPen / (k.kPen + k.kLoss))
    const result = simulate([gelDose(1.5)], req({ endMS: T0 + 600 * H }))
    const expected = toPGML(absorbed) / KE
    expect(Math.abs(result.auc - expected) / expected).toBeLessThan(5e-3)
  })

  test('线性叠加：两剂凝胶 == 两次单独跑之和', () => {
    const both = simulate([gelDose(1.5), { ...gelDose(1), takenAt: T0 + 12 * H }], req())
    const a = simulate([gelDose(1.5)], req())
    const b = simulate([{ ...gelDose(1), takenAt: T0 + 12 * H }], req())
    for (let i = 0; i < both.conc.length; i += 1) {
      const sum = (a.conc[i] ?? 0) + (b.conc[i] ?? 0)
      expect(Math.abs((both.conc[i] ?? 0) - sum)).toBeLessThan(1e-9 * Math.max(1, sum))
    }
  })

  test('步长收敛：1 分钟与 0.25 分钟相差 < 1e-6', () => {
    const coarse = simulate([gelDose(1.5)], req({ internalStepMin: 1 }))
    const fine = simulate([gelDose(1.5)], req({ internalStepMin: 0.25 }))
    expect(Math.abs(coarse.peak.conc - fine.peak.conc) / fine.peak.conc).toBeLessThan(1e-6)
  })

  test('浓度非负且只有一个峰', () => {
    const result = simulate([gelDose(1.5)], req())
    let peaks = 0
    for (let i = 1; i < result.conc.length - 1; i += 1) {
      const prev = result.conc[i - 1] ?? 0
      const cur = result.conc[i] ?? 0
      const next = result.conc[i + 1] ?? 0
      expect(cur).toBeGreaterThanOrEqual(0)
      if (cur > prev && cur > next) peaks += 1
    }
    expect(peaks).toBe(1)
  })

  test('生殖器部位通透性更高，但没有 8 倍那么夸张（吸收分数上限压住了）', () => {
    const arm = simulate([gelDose(1.5)], req())
    const scrotal = simulate([gelDose(1.5, { site: 'scrotal' })], req())
    const factor = (8 * 0.14) / (8 * 0.14 + 1.26) / (0.14 / (0.14 + 1.26))
    expect(scrotal.auc / arm.auc).toBeCloseTo(factor, 2)
    expect(scrotal.auc / arm.auc).toBeLessThan(8)
  })

  test('叠加润肤霜 +38%，叠加防晒霜 -16%', () => {
    const base = simulate([gelDose(1.5)], req())
    const moisturizer = simulate([gelDose(1.5, { coApplied: 'moisturizer' })], req())
    const sunscreen = simulate([gelDose(1.5, { coApplied: 'sunscreen' })], req())
    expect(moisturizer.auc / base.auc).toBeCloseTo(1.38, 3)
    expect(sunscreen.auc / base.auc).toBeCloseTo(0.84, 3)
  })

  test('未知外用品是中性 1.0，不会被悄悄当成润肤霜', () => {
    const base = simulate([gelDose(1.5)], req())
    const unknown = simulate([gelDose(1.5, { coApplied: 'laser' })], req())
    expect(unknown.auc / base.auc).toBeCloseTo(1, 6)
  })

  test('面积越大吸收越好（面密度下降，角质层不饱和）', () => {
    const narrow = simulate([gelDose(1.5, { areaCm2: 200 })], req())
    const wide = simulate([gelDose(1.5, { coverageTemplate: 'arms2' })], req())
    expect(wide.auc).toBeGreaterThan(narrow.auc)
    expect(wide.auc / narrow.auc).toBeLessThan(2.01)
  })
})

describe('transmtf 引擎：五条途径的量级', () => {
  const run = (doses: SimDose[], days = 30) =>
    simulate(doses, req({ endMS: T0 + days * 24 * H, stepMin: 30 }))

  test('注射与 builtin 完全一致（同一组常数）', () => {
    const ev = (mg: number): SimDose => ({
      takenAt: T0,
      compound: 'EV',
      route: 'injection',
      doseEquivMG: mg * (272.38 / 356.5),
    })
    const a = simulate([ev(5)], req({ engine: 'builtin', endMS: T0 + 600 * H }))
    const b = simulate([ev(5)], req({ endMS: T0 + 600 * H }))
    expect(Math.abs(b.peak.conc - a.peak.conc) / a.peak.conc).toBeLessThan(0.02)
    expect(Math.abs(b.auc - a.auc) / a.auc).toBeLessThan(0.02)
  })

  test('口服：生物利用度 3%，峰值远低于同剂量注射', () => {
    const oral = run([{ takenAt: T0, compound: 'E2', route: 'oral', doseEquivMG: 2 }])
    const inj = run([{ takenAt: T0, compound: 'E2', route: 'injection', doseEquivMG: 2 }])
    expect(oral.auc).toBeLessThan(inj.auc)
    expect(oral.peak.conc).toBeGreaterThan(20)
    expect(oral.peak.conc).toBeLessThan(400)
  })

  test('口服 EV 多一级血浆水解，峰值比 E2 晚', () => {
    const e2 = run([{ takenAt: T0, compound: 'E2', route: 'oral', doseEquivMG: 2 }])
    const ev = run([{ takenAt: T0, compound: 'EV', route: 'oral', doseEquivMG: 2 }])
    expect((ev.peak.tMS - T0) / H).toBeGreaterThan((e2.peak.tMS - T0) / H)
  })

  test('含服 theta 越高绕过首过越多', () => {
    const low = run([
      { takenAt: T0, compound: 'E2', route: 'sublingual', doseEquivMG: 2, extras: { theta: 0.01 } },
    ])
    const high = run([
      { takenAt: T0, compound: 'E2', route: 'sublingual', doseEquivMG: 2, extras: { theta: 0.18 } },
    ])
    expect(high.auc / low.auc).toBeGreaterThan(3)
    expect(high.auc).toBeGreaterThan(low.auc)
  })

  test('贴片：恒速释放时 AUC = 通量 × 时长 / 清除率', () => {
    const rateUgPerDay = 100
    const wearH = 72
    const result = run([
      {
        takenAt: T0,
        compound: 'E2',
        route: 'patchApply',
        doseEquivMG: 0.3,
        extras: { releaseRateUgPerDay: rateUgPerDay },
      },
      { takenAt: T0 + wearH * H, compound: 'E2', route: 'patchRemove', doseEquivMG: 0 },
    ])
    const totalMG = ((rateUgPerDay * 1e-3) / 24) * wearH
    const expected = toPGML(totalMG) / KE
    expect(Math.abs(result.auc - expected) / expected).toBeLessThan(5e-3)
  })

  test('贴片没有释放速率时按指数释放（与 builtin 的恒速 fallback 形状不同）', () => {
    const doses: SimDose[] = [
      {
        takenAt: T0,
        compound: 'E2',
        route: 'patchApply',
        doseEquivMG: 0.3,
        extras: {},
      },
      { takenAt: T0 + 72 * H, compound: 'E2', route: 'patchRemove', doseEquivMG: 0 },
    ]
    const trans = simulate(doses, req({ endMS: T0 + 200 * H }))
    const builtin = simulate(doses, req({ engine: 'builtin', endMS: T0 + 200 * H }))
    expect(trans.warnings.some((w) => w.includes('指数释放'))).toBe(true)
    expect(builtin.warnings.some((w) => w.includes('fallback'))).toBe(true)
    // 指数释放的峰值更早、尾部更长；恒速的峰值出现在拆除时刻附近。
    expect((trans.peak.tMS - T0) / H).toBeLessThan((builtin.peak.tMS - T0) / H)
  })
})

describe('transmtf 引擎：与 builtin 的差异是被断言的，不是被希望的', () => {
  test('同一剂凝胶：transmtf 的暴露约为 builtin 的 1.67 倍（0.10 vs 0.06）', () => {
    const dose = gelDose(1.5)
    const trans = simulate([dose], req())
    const builtin = simulate([dose], req({ engine: 'builtin' }))
    const absorbedTrans = 1.5 * (0.14 / (0.14 + 1.26))
    const absorbedBuiltin = 1.5 * 0.06
    expect(trans.auc / builtin.auc).toBeCloseTo(absorbedTrans / absorbedBuiltin, 1)
    expect(trans.auc / builtin.auc).toBeGreaterThan(1.5)
    expect(trans.auc / builtin.auc).toBeLessThan(1.8)
  })

  test('凝胶峰值时刻：三室级联比单室更晚（皮肤储库慢释放）', () => {
    const trans = simulate([gelDose(1.5)], req())
    const builtin = simulate([gelDose(1.5)], req({ engine: 'builtin' }))
    expect((trans.peak.tMS - T0) / H).toBeGreaterThan((builtin.peak.tMS - T0) / H)
  })

  test('两个引擎都不许静默吃掉不能建模的输入', () => {
    const transmasc: SimDose[] = [
      { takenAt: T0, compound: 'TC', route: 'injection', doseEquivMG: 70 },
    ]
    expect(() => simulate(transmasc, req({ hormone: 'testosterone' }))).toThrow('只覆盖雌二醇')
    const antiandrogen: SimDose[] = [
      { takenAt: T0, compound: 'CPA', route: 'oral', doseEquivMG: 0 },
    ]
    const result = simulate(antiandrogen, req())
    expect(result.conc.every((c) => c === 0)).toBe(true)
  })

  test('单位恒为 pg/mL（transmtf 不覆盖睾酮）', () => {
    expect(simulate([gelDose(1.5)], req()).unit).toBe('pg/ml')
  })

  test('未知引擎名直接报错', () => {
    expect(() => simulate([gelDose(1.5)], req({ engine: 'nope' as unknown as 'builtin' }))).toThrow(
      '未知引擎',
    )
  })
})

describe('transmtf 引擎：数值内核的边界', () => {
  test('采样过多仍然拒绝', () => {
    expect(() => simulate([gelDose(1.5)], req({ endMS: T0 + 4_000_000 * H, stepMin: 1 }))).toThrow(
      'too many samples',
    )
  })

  test('非法体重与非法区间抛错', () => {
    expect(() => simulate([gelDose(1.5)], req({ weightKG: 0 }))).toThrow('weightKG')
    expect(() => simulate([gelDose(1.5)], req({ endMS: T0 }))).toThrow('endMS')
  })

  test('当量为 0 的凝胶被跳过并留原因', () => {
    const result = simulate([gelDose(0)], req())
    expect(result.warnings.some((w) => w.includes('当量为 0'))).toBe(true)
  })

  test('贴片没拆除按 24 小时计并警告', () => {
    const result = simulate(
      [{ takenAt: T0, compound: 'E2', route: 'patchApply', doseEquivMG: 0.3, extras: {} }],
      req(),
    )
    expect(result.warnings.some((w) => w.includes('24 小时'))).toBe(true)
  })
})

describe('transmtf 引擎：注射清除率也是 kClearInjection', () => {
  test('注射 AUC 用 kClearInjection 而非 kClear（差 10 倍）', () => {
    const dose: SimDose = { takenAt: T0, compound: 'EV', route: 'injection', doseEquivMG: 3.82 }
    const result = simulate([dose], req({ endMS: T0 + 600 * H }))
    const formation = transmtfCatalog.injection.formationFraction.EV ?? Number.NaN
    const withInj = toPGML(3.82 * formation) / KE_INJ
    const withPlain = toPGML(3.82 * formation) / KE
    expect(Math.abs(result.auc - withInj) / withInj).toBeLessThan(0.05)
    expect(Math.abs(result.auc - withPlain) / withPlain).toBeGreaterThan(5)
  })
})
