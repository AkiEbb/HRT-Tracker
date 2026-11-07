import { categoryOf, type Dose } from '@hrt/protocol'
import type { HormoneKey } from './catalog'
import type { SimDose } from './engine'

/**
 * 记录层 → 引擎层。
 *
 * 这一层之所以必须存在：记录里同时有 `doseMG` 与 `doseEquivMG`（§4.2），而
 * 引擎只吃后者（ADR 32）。转换点只有这里一处，引擎里连 `doseMG` 这个名字都不出现。
 */
export function toSimDose(dose: Dose): SimDose {
  const { payload } = dose
  return {
    takenAt: dose.takenAt,
    compound: payload.compound,
    route: payload.route,
    doseEquivMG: payload.doseEquivMG,
    weightKG: payload.weightKG,
    extras: payload.extras,
    id: dose.id,
  }
}

/** 给药记录属于哪种激素；抗雄返回 `undefined`（有记录、无曲线）。 */
export function hormoneOfDose(dose: Dose): HormoneKey | undefined {
  const category = categoryOf(dose.payload.compound)
  return category === 'antiAndrogen' ? undefined : category
}

/**
 * 挑出某条曲线的输入。
 *
 * 抗雄记录仍然传下去：引擎会给出「不在目录里」的警告，而不是假装它们不存在。
 * 这样图表的说明文字与警告列表来自同一份事实。
 */
export function toSimDoses(doses: readonly Dose[], hormone: HormoneKey): SimDose[] {
  const selected: SimDose[] = []
  for (const dose of doses) {
    const kind = hormoneOfDose(dose)
    if (kind !== undefined && kind !== hormone) continue
    selected.push(toSimDose(dose))
  }
  return selected
}
