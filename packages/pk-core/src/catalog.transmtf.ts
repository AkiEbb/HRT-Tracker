/**
 * `transmtf` 引擎的参数目录。
 *
 * 与 `builtin` 的分工（DESIGN §9.1）：两套模型共用同一族速率常数传统（`vdPerKG 2.0`、
 * `kClear 0.41`、`kClearInjection 0.041`），差异体现在**透皮凝胶的形状**上——上游用
 * 「表面 → 皮肤储库 → 中央」三室级联，且吸收分数来自 `kPen/(kPen+kLoss)` 而不是一个
 * `Fmax` 常数，并额外考虑涂抹部位、涂抹面积、洗掉时刻与叠加防晒霜/润肤霜。
 *
 * 这里不引入新目录结构：仍然按 hormone / compound / route 三层，差异是**字段**。
 * 只覆盖雌二醇 —— 上游的抗雄（CPA 二室、比卡鲁胺单室）与 EU 长效 depot 留给 v0.3。
 */
import transmtfJson from './catalog.transmtf.json' with { type: 'json' }

export interface TransmtfProduct {
  id: number
  name: string
  concentrationMGmL: number
  defaultAreaCM2: number
  refDoseMG: number
  kPenBase: number
  kLoss: number
  kRel: number
}

export interface GelCoverageTemplate {
  key: string
  kind: 'product' | 'fixed' | 'manual'
  areaCM2?: number
}

export interface TransmtfCatalog {
  core: {
    vdPerKG: number
    kClear: number
    kClearInjection: number
    depotK1Corr: number
  }
  molecularWeight: Record<string, number>
  injection: {
    twoPartDepot: Record<string, { fracFast: number; k1Fast: number; k1Slow: number }>
    formationFraction: Record<string, number>
    k2: Record<string, number>
  }
  oral: {
    kAbsE2: number
    kAbsEV: number
    bioavailability: number
    kAbsSL: number
  }
  sublingual: {
    tierOrder: string[]
    tiers: Record<string, { theta: number; holdMinutes: number }>
  }
  gel: {
    _model: string
    siteOrder: string[]
    siteFactors: Record<string, number>
    sigmaSat: number
    concRef: number
    densityFactorClamp: { min: number; max: number }
    coApplicationOrder: string[]
    coApplicationFactors: Record<string, number>
    defaultProductId: number
    products: TransmtfProduct[]
    palmAreaCM2: number
    coverageTemplates: GelCoverageTemplate[]
  }
  patch: { fallbackK1: number; formationFraction: number }
}

export const transmtfCatalog = transmtfJson as TransmtfCatalog

export const TRANSMTF_SOURCE = transmtfJson._source

/** 预设凝胶产品，缺失时退回第一个（与上游 `getGelProductById` 同语义）。 */
export function gelProductById(id: number | undefined): TransmtfProduct {
  const products = transmtfCatalog.gel.products
  const hit = products.find((p) => p.id === id)
  const first = products[0]
  if (first === undefined) throw new Error('transmtf catalog: no gel products')
  return hit ?? first
}

/** 涂抹部位相对通透系数；未知部位退化为 1，不猜更高值。 */
export function gelSiteFactor(site: string | undefined): number {
  if (site === undefined) return 1
  const factor = transmtfCatalog.gel.siteFactors[site]
  return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1
}

/** 叠加外用品对总暴露的乘性因子；只认表里列出的 key。 */
export function gelCoApplicationFactor(key: string | undefined): number {
  if (key === undefined) return 1
  if (!transmtfCatalog.gel.coApplicationOrder.includes(key)) return 1
  const factor = transmtfCatalog.gel.coApplicationFactors[key]
  return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1
}

export interface GelKinetics {
  kPen: number
  kLoss: number
  kRel: number
}

/**
 * 把「产品 + 部位 + 剂量 + 面积」解成生效的三室速率常数。
 *
 * 面密度 σ = 剂量/面积 越集中，角质层趋于饱和、吸收分数越低；因子在每个产品自己的
 * 参考面密度处归一到 1，所以默认剂量下的预测不随浓度漂移。生殖器皮肤（scrotal）
 * 不施加面密度校正：该部位面积不可测量，硬套只会制造虚假的面积依赖。
 */
export function resolveGelKinetics(
  product: TransmtfProduct,
  site: string | undefined,
  doseMG: number,
  areaCM2: number | undefined,
): GelKinetics {
  const gel = transmtfCatalog.gel
  const rSite = gelSiteFactor(site)
  const area = areaCM2 !== undefined && areaCM2 > 0 ? areaCM2 : product.defaultAreaCM2
  const sigma = doseMG > 0 && area > 0 ? doseMG / area : 0
  const sigmaRef = product.defaultAreaCM2 > 0 ? product.refDoseMG / product.defaultAreaCM2 : 0
  const concRel = product.concentrationMGmL > 0 ? product.concentrationMGmL / gel.concRef : 1
  const sigmaSat = gel.sigmaSat * concRel

  let densityFactor = 1
  if (sigma > 0 && sigmaSat > 0) {
    densityFactor = (1 + sigmaRef / sigmaSat) / (1 + sigma / sigmaSat)
  }
  densityFactor = Math.min(
    gel.densityFactorClamp.max,
    Math.max(gel.densityFactorClamp.min, densityFactor),
  )
  if (site === 'scrotal') densityFactor = 1

  return {
    kPen: product.kPenBase * rSite * densityFactor,
    kLoss: product.kLoss,
    kRel: product.kRel,
  }
}

/** 覆盖面积模板 → cm²；`manual` 用用户自填，越界退回产品默认面积。 */
export function resolveGelCoverageArea(
  templateKey: string | undefined,
  product: TransmtfProduct,
  manualAreaCM2: number | undefined,
): number {
  const template = transmtfCatalog.gel.coverageTemplates.find((t) => t.key === templateKey)
  if (template === undefined || template.kind === 'manual') {
    return manualAreaCM2 !== undefined && manualAreaCM2 > 0 ? manualAreaCM2 : product.defaultAreaCM2
  }
  if (template.kind === 'product') return product.defaultAreaCM2
  return template.areaCM2 !== undefined && template.areaCM2 > 0
    ? template.areaCM2
    : product.defaultAreaCM2
}

/** 含服档位 → theta；未知档位退回 standard。 */
export function sublingualTheta(tierKey: string | undefined): { theta: number; tier: string } {
  const tiers = transmtfCatalog.sublingual.tiers
  const key = tierKey !== undefined && tiers[tierKey] !== undefined ? tierKey : 'standard'
  return { theta: tiers[key]?.theta ?? 0.11, tier: key }
}

/** 活性当量因子：分子量之比。未知药物返回 undefined，绝不猜 1。 */
export function transmtfActiveFactor(compound: string): number | undefined {
  const mw = transmtfCatalog.molecularWeight[compound]
  const active = transmtfCatalog.molecularWeight.E2
  if (mw === undefined || active === undefined || !(mw > 0)) return undefined
  return active / mw
}

/** 口服吸收速率：上游只区分 EV 与其余（视为 E2）。 */
export function oralKAbs(compound: string): number {
  return compound === 'EV' ? transmtfCatalog.oral.kAbsEV : transmtfCatalog.oral.kAbsE2
}

/** 酯在吸收后的水解速率；E2 自身为 0（恒等下游直接进活性池）。 */
export function injectionK2(compound: string): number {
  return transmtfCatalog.injection.k2[compound] ?? 0
}
