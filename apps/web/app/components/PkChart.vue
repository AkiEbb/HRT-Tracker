<script setup lang="ts">
import uPlot from 'uplot'
import type { Curve } from '#shared/types/curve'
import 'uplot/dist/uPlot.min.css'

/**
 * 双曲线叠加图。
 *
 * 只做一件事：把 N 条已经算好的曲线画到同一坐标系里。它不知道引擎、不知道剂量，
 * 这样「两条模型曲线同屏」就不是一个特殊功能，而只是把两条曲线传进来。
 *
 * uPlot 的 series 数量建好之后不能改，所以曲线**集合**变化时必须重建实例
 * （只 setData 会让新加的曲线永远不出现——这是第一次跑起来时抓到的真实 bug）。
 */
const props = defineProps<{
  curves: Curve[]
  unit: 'pg/ml' | 'ng/dl'
  height?: number
}>()

const host = useTemplateRef<HTMLDivElement>('host')
let plot: uPlot | null = null
let observer: ResizeObserver | null = null
let builtFor = ''

const plotHeight = computed(() => props.height ?? 320)
const axisLabel = computed(() => (props.unit === 'ng/dl' ? 'ng/dL' : 'pg/mL'))

/** 所有曲线共用同一组采样时刻（同一次求解的时间栅格），取第一条即可。 */
const grid = computed<Float64Array>(() => props.curves[0]?.tMS ?? new Float64Array())

const signature = computed(() =>
  props.curves
    .map((curve) => `${curve.label}:${curve.color}:${curve.dash?.join('-') ?? ''}`)
    .join('|'),
)

const data = computed<uPlot.AlignedData>(() => {
  const t = grid.value
  const origin = t[0] ?? 0
  // 横轴是「距离区间起点的小时数」：同一次求解里所有曲线共用，不需要各自换算。
  const x = Array.from(t, (ms) => (ms - origin) / 3_600_000)
  return [x, ...props.curves.map((curve) => Array.from(curve.conc))]
})

const options = (width: number): uPlot.Options => ({
  width,
  height: plotHeight.value,
  padding: [12, 12, 0, 0],
  cursor: { drag: { x: true, y: false, setScale: true } },
  scales: {
    x: { time: false },
    // 不要自己写 y 范围：一旦把上限算小了，超出部分会被画到 canvas 外面，
    // 看上去就像“高浓度段的数据丢了”。uPlot 默认的 rangeNum 已经留了余量。
  },
  legend: { live: true },
  axes: [
    {
      label: '小时',
      stroke: '#a1a1aa',
      grid: { stroke: 'rgba(148,163,184,0.15)' },
      ticks: { stroke: 'rgba(148,163,184,0.3)' },
    },
    {
      label: axisLabel.value,
      stroke: '#a1a1aa',
      grid: { stroke: 'rgba(148,163,184,0.15)' },
      ticks: { stroke: 'rgba(148,163,184,0.3)' },
      size: 64,
    },
  ],
  series: [
    // 横轴也要占一格图例（显示成 "Value: --"），它下面那行由样式隐藏。
    { label: '小时' },
    ...props.curves.map((curve) => ({
      label: curve.label,
      stroke: curve.color,
      width: 2,
      dash: curve.dash,
      points: { show: false },
    })),
  ],
})

const destroy = (): void => {
  observer?.disconnect()
  observer = null
  plot?.destroy()
  plot = null
  builtFor = ''
}

const render = (attempt = 0): void => {
  const element = host.value
  if (element === null) return
  if (props.curves.length === 0) {
    destroy()
    return
  }
  const width = element.clientWidth
  // 宽度为 0 只可能是“刚变可见、还没布局”，下一帧再试一次（有上限，不会无限自旋）。
  if (width <= 0) {
    if (attempt < 5) requestAnimationFrame(() => render(attempt + 1))
    return
  }

  if (plot !== null && builtFor === signature.value) {
    // `true` = 重新计算 y 范围。传 `false` 时旧的纵向尺度会留下，
    // 于是贴片曲线会被画在“注射量级”的坐标系里，看上去像一条贴底的直线。
    plot.setData(data.value, true)
    plot.setSize({ width, height: plotHeight.value })
    return
  }

  destroy()
  try {
    plot = new uPlot(options(width), data.value, element)
    builtFor = signature.value
    observer = new ResizeObserver(() => {
      if (plot !== null && element.clientWidth > 0) {
        plot.setSize({ width: element.clientWidth, height: plotHeight.value })
      }
    })
    observer.observe(element)
  } catch (error) {
    // uPlot 对输入很挑（NaN、空数组、长度不一致）。出错要留下可读信息，而不是一张空白。
    console.error('[PkChart] uPlot 创建失败', error)
    destroy()
  }
}

// `flush: 'post'` 保证 DOM 已经按新的 curves 更新过；
// 包一层箭头函数是因为 watch 会把 (new, old) 当成参数传进回调。
watch([data, signature, plotHeight], () => render(), { flush: 'post' })
onMounted(() => render())
onBeforeUnmount(destroy)
</script>

<template>
  <div class="rounded-xl border border-white/10 bg-white/[0.02] p-3">
    <div ref="host" class="w-full" :class="curves.length === 0 ? 'hidden' : ''" />
    <p v-if="curves.length === 0" class="py-16 text-center text-sm opacity-50">还没有可画的数据</p>
  </div>
</template>

<style scoped>
/* uPlot 给横轴也建了一格图例（"Value: --"），换成 "小时" 之后仍然是噪声，直接藏掉这一行。 */
:deep(.u-legend tr:first-child) {
  display: none;
}
</style>
