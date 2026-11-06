/**
 * `@hrt/pk-core` 的公共门面。
 *
 * - `catalog` 是 `builtin` 引擎参数的唯一真源（分子量、清除率、吸收分数）
 * - `transmtfCatalog` 是 `transmtf` 引擎的对应目录
 * - `simulate` 按 `engine` 字段选择引擎，默认 `builtin`
 * - `solve` 是两个引擎共用的线性系统数值内核
 */
export * from './catalog'
export * from './catalog.transmtf'
export * from './engine'
export * from './engine.transmtf'
export * from './simulate'
export * from './solver'
