import type { Compound, Route } from '@hrt/protocol'

/**
 * 界面用的中文标签。
 *
 * 放在 UI 侧而不是 protocol 里：`compound` / `route` 是**协议值**（写进备份、
 * 传给引擎），标签只是显示层的东西。以后加 en 时，换的是这个文件，不是数据。
 */
export const COMPOUND_LABELS: Record<Compound, string> = {
  E2: '雌二醇',
  EB: '苯甲酸雌二醇',
  EV: '戊酸雌二醇',
  EC: '环戊丙酸雌二醇',
  EN: '庚酸雌二醇',
  T: '睾酮',
  TC: '环戊丙酸睾酮',
  TE: '庚酸睾酮',
  TU: '十一酸睾酮',
  CPA: '醋酸环丙孕酮',
  CMA: '醋酸氯地孕酮',
  SPL: '螺内酯',
  BIC: '比卡鲁胺',
}

export const ROUTE_LABELS: Record<Route, string> = {
  injection: '注射',
  oral: '口服',
  sublingual: '含服',
  gel: '凝胶',
  patchApply: '贴片（贴上）',
  patchRemove: '贴片（拆除）',
}
