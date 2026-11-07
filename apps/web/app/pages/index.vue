<script setup lang="ts">
import { categoryToHormone } from '@hrt/pk-core'
import type { Dose } from '@hrt/protocol'
import { REGIMENS } from '#shared/pk/regimens'
import type { Curve } from '#shared/types/curve'

/**
 * v0.1 的计算页：同一批记录，两个引擎各算一次，画在同一张图上。
 *
 * 数据来源有两种：内置示例方案（可以立刻看到引擎差异）与本地真实记录。
 * 主线程只接收数组并交给 uPlot；所有求解在 Worker 里完成（§9.4）。
 */
const HOUR = 3_600_000
const DAY = 24 * HOUR
const DEFAULT_WEIGHT = 62
const days = ref(14)
const regimenId = ref('gel')
const source = ref<'demo' | 'mine'>('demo')
const { run } = usePkWorker()
const { store } = useRecordStore()

const myDoses = shallowRef<Dose[]>([])

const loadMine = async (): Promise<void> => {
  if (store.value === null) return
  try {
    myDoses.value = await store.value.list('dose')
  } catch {
    myDoses.value = []
  }
}

onMounted(loadMine)
watch(store, loadMine)

/** 示例方案的起点取整到当天 0 点，避免每次刷新横轴都不同。 */
const demoStartMS = ref(Math.floor(Date.now() / DAY) * DAY)

const usingMine = computed(() => source.value === 'mine' && myDoses.value.length > 0)

const doses = computed<Dose[]>(() => {
  if (usingMine.value) return myDoses.value
  const regimen = REGIMENS.find((item) => item.id === regimenId.value) ?? REGIMENS[0]
  return regimen?.build(demoStartMS.value, DEFAULT_WEIGHT) ?? []
})

/** 真实记录：区间从第一条到最后一条之后 7 天，至少 7 天能看到给药节奏。 */
const startMS = computed(() => {
  const first = doses.value[0]
  return usingMine.value && first !== undefined ? first.takenAt : demoStartMS.value
})
const endMS = computed(() => {
  if (!usingMine.value) return startMS.value + days.value * DAY
  const last = doses.value[doses.value.length - 1]
  const tail = (last?.takenAt ?? startMS.value) + 7 * DAY
  return Math.max(tail, startMS.value + 7 * DAY)
})
const spanDays = computed(() => Math.round((endMS.value - startMS.value) / DAY))

const weightKG = computed(() => {
  const latest = doses.value[doses.value.length - 1]
  return latest?.payload.weightKG ?? DEFAULT_WEIGHT
})

/** transmtf 只覆盖雌二醇：睾酮记录会让它如实报错，这里不替它假装能算。 */
const hormone = computed<'estradiol' | 'testosterone'>(() => {
  for (const dose of doses.value) {
    const key = categoryToHormone(dose.payload.category)
    if (key !== undefined) return key
  }
  return 'estradiol'
})

type Outcome = Awaited<ReturnType<typeof run>>
const builtin = shallowRef<Outcome>(null)
const transmtf = shallowRef<Outcome>(null)
const busy = ref(false)
let generation = 0

const curves = computed<Curve[]>(() => {
  const list: Curve[] = []
  const add = (outcome: Outcome, label: string, color: string): void => {
    if (outcome === null || 'error' in outcome) return
    list.push({ label, color, tMS: outcome.series.t, conc: outcome.series.conc })
  }
  add(builtin.value, 'builtin', '#60a5fa')
  add(transmtf.value, 'transmtf', '#f472b6')
  return list
})

const unit = computed<'pg/ml' | 'ng/dl'>(() => {
  const outcome = builtin.value ?? transmtf.value
  return outcome !== null && !('error' in outcome) ? outcome.unit : 'pg/ml'
})

const rows = computed(() =>
  [
    { key: 'builtin', outcome: builtin.value, label: 'builtin' },
    { key: 'transmtf', outcome: transmtf.value, label: 'transmtf' },
  ].map(({ key, outcome, label }) => {
    const failed = outcome !== null && 'error' in outcome
    const ok = outcome !== null && !failed ? outcome : null
    return {
      key,
      label,
      error: failed ? (outcome as { error: string }).error : null,
      peak: ok?.peak.conc ?? null,
      tMaxH: ok === null ? null : (ok.peak.tMS - startMS.value) / HOUR,
      auc: ok?.auc ?? null,
    }
  }),
)

const warnings = computed(() => {
  const collected: string[] = []
  for (const outcome of [builtin.value, transmtf.value]) {
    if (outcome !== null && !('error' in outcome)) collected.push(...outcome.warnings)
  }
  return [...new Set(collected)]
})

const note = computed(() => {
  if (usingMine.value) return `用本地记录算的：${doses.value.length} 条。`
  return REGIMENS.find((item) => item.id === regimenId.value)?.note ?? ''
})

const recompute = async (): Promise<void> => {
  busy.value = true
  // 选择变化很快时，旧请求可能晚回：只有最后一次选择有资格写状态。
  generation += 1
  const mine = generation
  const input = {
    doses: doses.value,
    hormone: hormone.value,
    weightKG: weightKG.value,
    startMS: startMS.value,
    endMS: endMS.value,
    stepMin: 30,
  }
  const [a, b] = await Promise.all([
    run({ ...input, engine: 'builtin' }),
    run({ ...input, engine: 'transmtf' }),
  ])
  if (mine !== generation) return
  builtin.value = a
  transmtf.value = b
  busy.value = false
}

onMounted(recompute)
watch([doses, hormone, weightKG, startMS, endMS], recompute)

const fmt = (value: number | null, digits = 1): string =>
  value === null ? '—' : value.toFixed(digits)
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">PK 对比</h1>
        <p class="mt-1 text-sm opacity-60">
          同一批记录，两个模型各算一遍。曲线来自群体模型，不是用药建议。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <USelect
          v-model="source"
          :items="[
            { label: '示例方案', value: 'demo' },
            { label: `我的记录（${myDoses.length}）`, value: 'mine' },
          ]"
          class="w-40"
        />
        <USelect
          v-if="!usingMine"
          v-model="regimenId"
          :items="REGIMENS.map((item) => ({ label: item.label, value: item.id }))"
          class="w-56"
        />
        <template v-if="!usingMine">
          <UInput v-model.number="days" type="number" min="3" max="60" class="w-20" />
          <span class="opacity-60">天</span>
        </template>
      </div>
    </header>

    <UAlert
      v-if="source === 'mine' && myDoses.length === 0"
      color="neutral"
      variant="subtle"
      title="还没有记录"
      description="先去「我的记录」加一条，再回来看曲线。"
    />

    <PkChart :curves="curves" :unit="unit" :height="360" />

    <p v-if="note" class="text-sm opacity-70">{{ note }}</p>

    <div class="grid gap-3 sm:grid-cols-2">
      <UCard v-for="row in rows" :key="row.key">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="font-mono text-sm">{{ row.label }}</span>
            <span v-if="busy" class="text-xs opacity-50">计算中…</span>
          </div>
        </template>
        <p v-if="row.error" class="text-sm text-red-400">{{ row.error }}</p>
        <dl v-else class="space-y-1 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="opacity-60">区间最高</dt>
            <dd class="font-mono">{{ fmt(row.peak) }} <span class="opacity-50">{{ unit }}</span></dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="opacity-60">出现在</dt>
            <dd class="font-mono">{{ fmt(row.tMaxH, 0) }} h</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="opacity-60">AUC</dt>
            <dd class="font-mono">{{ fmt(row.auc, 0) }}</dd>
          </div>
        </dl>
      </UCard>
    </div>

    <UAlert
      v-if="warnings.length > 0"
      color="warning"
      variant="subtle"
      title="求解时的说明"
      :description="warnings.join('；')"
    />

    <footer class="mt-auto text-xs opacity-50">
      {{ doses.length }} 条记录 · {{ weightKG }} kg · 步长 30 分钟 · 区间 {{ spanDays }} 天。
      曲线来自群体模型，不能作为用药依据。
    </footer>
  </main>
</template>
