import { describe, expect, it } from 'bun:test'
import type { Dose, DosePayload } from '@hrt/protocol'
import { hormoneOfDose, toSimDoses } from '../src/adapter'
import {
  type PkWorkerRequest,
  parsePkWorkerRequest,
  toSimulateOptions,
} from '../src/worker-protocol'

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0)

/** 测试里不跑 catalog 换算：协议层只搬运已算好的记录。 */
const dose = (id: string, payload: Partial<DosePayload>): Dose => ({
  id,
  takenAt: T0,
  payload: {
    category: 'estradiol',
    compound: 'E2',
    route: 'gel',
    doseMG: 1.5,
    doseEquivMG: 1.5,
    clientUpdatedAt: T0,
    ...payload,
  },
})

const gel = dose('d1', {})

const cpa = dose('d2', {
  category: 'antiAndrogen',
  compound: 'CPA',
  route: 'oral',
  doseMG: 12.5,
  doseEquivMG: 0,
})

const request = (over: Partial<Record<string, unknown>> = {}): unknown => ({
  id: 'pk-1',
  type: 'simulate',
  engine: 'builtin',
  doses: [gel],
  range: [T0, T0 + 86_400_000],
  stepMin: 30,
  pkParams: { hormone: 'estradiol', weightKG: 62 },
  ...over,
})

describe('Worker 协议：合法消息', () => {
  it('接受一个完整请求并原样取回字段', () => {
    const parsed = parsePkWorkerRequest(request())
    expect(parsed.id).toBe('pk-1')
    expect(parsed.engine).toBe('builtin')
    expect(parsed.stepMin).toBe(30)
    expect(parsed.range).toEqual([T0, T0 + 86_400_000])
    expect(parsed.pkParams.hormone).toBe('estradiol')
  })

  it('internalStepMin 缺省时不出现在结果里（而不是 undefined 字段）', () => {
    const parsed = parsePkWorkerRequest(request())
    expect('internalStepMin' in parsed.pkParams).toBe(false)
  })

  it('internalStepMin 给定时保留', () => {
    const parsed = parsePkWorkerRequest(
      request({ pkParams: { hormone: 'estradiol', weightKG: 62, internalStepMin: 1 } }),
    )
    expect(parsed.pkParams.internalStepMin).toBe(1)
  })

  it('toSimulateOptions 把 range 拆成 startMS/endMS，并带上 engine', () => {
    const options = toSimulateOptions(parsePkWorkerRequest(request()))
    expect(options).toEqual({
      engine: 'builtin',
      hormone: 'estradiol',
      weightKG: 62,
      startMS: T0,
      endMS: T0 + 86_400_000,
      stepMin: 30,
    })
  })

  it('transmtf 也是合法引擎值', () => {
    expect(parsePkWorkerRequest(request({ engine: 'transmtf' })).engine).toBe('transmtf')
  })
})

describe('Worker 协议：不可信输入一律拒绝', () => {
  const cases: Array<[string, unknown, string]> = [
    ['不是对象', 'simulate', 'simulate: 消息不是对象'],
    ['数组', [], 'simulate: 消息不是对象'],
    ['null', null, 'simulate: 消息不是对象'],
    ['未知类型', request({ type: 'subscribe' }), 'simulate: 未知消息类型 subscribe'],
    ['缺 id', request({ id: undefined }), 'simulate: 缺少 id'],
    ['空 id', request({ id: '' }), 'simulate: 缺少 id'],
    ['未知引擎', request({ engine: 'pksim' }), 'simulate: 未知引擎 pksim'],
    ['doses 不是数组', request({ doses: {} }), 'simulate: doses 必须是数组'],
    ['range 长度错', request({ range: [T0] }), 'simulate: range 必须是 [start, end]'],
    ['range 非数值', request({ range: ['a', 'b'] }), 'simulate: range 必须是两个有限数'],
    ['range NaN', request({ range: [T0, Number.NaN] }), 'simulate: range 必须是两个有限数'],
    ['range 不递增', request({ range: [T0, T0] }), 'simulate: range 必须递增'],
    ['range 反向', request({ range: [T0 + 1, T0] }), 'simulate: range 必须递增'],
    ['stepMin 为 0', request({ stepMin: 0 }), 'simulate: stepMin 必须为正数'],
    ['stepMin 是字符串', request({ stepMin: '30' }), 'simulate: stepMin 必须为正数'],
    ['缺 pkParams', request({ pkParams: undefined }), 'simulate: 缺少 pkParams'],
    [
      '未知激素',
      request({ pkParams: { hormone: 'progesterone', weightKG: 62 } }),
      'simulate: 未知激素 progesterone',
    ],
    [
      'weightKG 为负',
      request({ pkParams: { hormone: 'estradiol', weightKG: -1 } }),
      'simulate: weightKG 必须为正数',
    ],
    [
      'internalStepMin 为 0',
      request({ pkParams: { hormone: 'estradiol', weightKG: 62, internalStepMin: 0 } }),
      'simulate: internalStepMin 必须为正数',
    ],
  ]

  for (const [label, input, message] of cases) {
    it(`拒绝：${label}`, () => {
      expect(() => parsePkWorkerRequest(input)).toThrow(message)
    })
  }

  it('拒绝消息时不会把半成品交给引擎：函数要么返回值要么抛错', () => {
    let parsed: PkWorkerRequest | null = null
    try {
      parsed = parsePkWorkerRequest(request({ stepMin: -5 }))
    } catch {
      parsed = null
    }
    expect(parsed).toBeNull()
  })
})

describe('适配层：Dose → SimDose', () => {
  it('激素记录带上 doseEquivMG 与体重', () => {
    const [sim] = toSimDoses([gel], 'estradiol')
    expect(sim?.compound).toBe('E2')
    expect(sim?.route).toBe('gel')
    expect(sim?.doseEquivMG).toBe(1.5)
    expect(sim?.weightKG).toBeUndefined()
  })

  it('体重透传（per-event weight 优先于全局体重）', () => {
    const heavy = dose('d3', { route: 'oral', doseMG: 2, doseEquivMG: 2, weightKG: 80 })
    const [sim] = toSimDoses([heavy], 'estradiol')
    expect(sim?.weightKG).toBe(80)
  })

  it('抗雄记录不建模，但仍然传给引擎（以便它出声警告而不是装作不存在）', () => {
    const sims = toSimDoses([gel, cpa], 'estradiol')
    expect(sims).toHaveLength(2)
    expect(sims[1]?.compound).toBe('CPA')
    expect(sims[1]?.doseEquivMG).toBe(0)
  })

  it('hormoneOfDose：抗雄没有对应激素', () => {
    expect(hormoneOfDose(gel)).toBe('estradiol')
    expect(hormoneOfDose(cpa)).toBeUndefined()
  })
})
