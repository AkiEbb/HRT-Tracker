/**
 * 图表用的曲线：已经算好的采样点 + 显示信息。
 *
 * 故意不携带引擎类型或剂量，这样「双模型叠加」只是把两条 `Curve` 传进同一个图，
 * 而不是图表内部要认识两个引擎。
 */
export interface Curve {
  label: string
  /** CSS 颜色。 */
  color: string
  /** 采样时刻（epoch ms）；同一张图里所有曲线必须共用同一组。 */
  tMS: Float64Array
  conc: Float64Array
}
