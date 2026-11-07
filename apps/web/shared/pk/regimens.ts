import { factorOf } from '@hrt/pk-core'
import { type Compound, type Dose, type DoseExtras, makeDose, type Route } from '@hrt/protocol'

/**
 * 示例方案：用来在没有账号、没有记录库的 v0.1 里把图表跑起来。
 *
 * 这些是**演示数据**，不是建议剂量；页面必须把这句话显示出来。
 * 方案的形状刻意覆盖三类差异：注射（两引擎几乎相同）、口服（首过）、
 * 凝胶（两引擎差最多的一条）。
 */
export interface Regimen {
  id: string
  label: string
  note: string
  build: (startMS: number, weightKG: number) => Dose[]
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const dose = (
  index: number,
  takenAt: number,
  weightKG: number,
  compound: Compound,
  route: Route,
  doseMG: number,
  extras?: DoseExtras,
): Dose => ({
  id: `demo-${index}`,
  takenAt,
  payload: makeDose(
    {
      compound,
      route,
      doseMG,
      clientUpdatedAt: takenAt,
      weightKG,
      ...(extras === undefined ? {} : { extras }),
    },
    factorOf,
  ),
})

const repeat = (
  count: number,
  everyH: number,
  startMS: number,
  make: (index: number, takenAt: number) => Dose | Dose[],
): Dose[] =>
  Array.from({ length: count }, (_, index) => make(index, startMS + index * everyH)).flat()

export const REGIMENS: Regimen[] = [
  {
    id: 'gel',
    label: '凝胶 1.5mg / 日',
    note: '两个引擎差最多的一条：吸收分数 0.06（常数）vs kPen/(kPen+kLoss)≈0.10',
    build: (startMS, weightKG) =>
      repeat(14, DAY, startMS, (i, at) => dose(i, at, weightKG, 'E2', 'gel', 1.5)),
  },
  {
    id: 'injection',
    label: '戊酸雌二醇 5mg / 7 日',
    note: '两引擎共用同一组清除常数，曲线几乎重合',
    build: (startMS, weightKG) =>
      repeat(4, 7 * DAY, startMS, (i, at) => dose(i, at, weightKG, 'EV', 'injection', 5)),
  },
  {
    id: 'oral',
    label: '口服 E2 2mg / 日',
    note: '首过代谢 3%，峰值低、波动大',
    build: (startMS, weightKG) =>
      repeat(14, DAY, startMS, (i, at) => dose(i, at, weightKG, 'E2', 'oral', 2)),
  },
  {
    id: 'sublingual',
    label: '含服 E2 2mg / 日（theta 0.11）',
    note: '绕过部分首过：吸收更快、峰值更高',
    build: (startMS, weightKG) =>
      repeat(14, DAY, startMS, (i, at) =>
        dose(i, at, weightKG, 'E2', 'sublingual', 2, { theta: 0.11 }),
      ),
  },
  {
    id: 'patch',
    label: '贴片 100µg/日（72 小时）',
    note: '恒速通量；拆除时按 patchRemove 记账',
    build: (startMS, weightKG) =>
      repeat(5, 3 * DAY, startMS, (i, at) => {
        const apply = dose(i * 2, at, weightKG, 'E2', 'patchApply', 0, { releaseRateUgPerDay: 100 })
        const remove = dose(i * 2 + 1, at + 72 * HOUR, weightKG, 'E2', 'patchRemove', 0)
        return [apply, remove]
      }),
  },
]
