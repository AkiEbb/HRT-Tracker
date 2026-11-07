<script setup lang="ts">
import { REGIMENS } from '#shared/pk/regimens'
import type { Curve } from '#shared/types/curve'

/**
 * v0.1 的计算页：选一个示例方案，两个引擎各算一次，画在同一张图上。
 *
 * 主线程只接收数组并交给 uPlot；所有求解在 Worker 里完成（§9.4）。
 */
const HOUR = 3_600_000
const DAY = 24 * HOUR
const weightKG = 62
const days = ref(14)
const regimenId = ref('gel')
const { run } = usePkWorker()

const regimen = computed(() => REGIMENS.find((item) => item.id === regimenId.value) ?? REGIMENS[0])

/** 起点取整到当天 0 点，避免每次刷新横轴都不同。 */
const startMS = ref(Math.floor(Date.now() / DAY) * DAY)
const endMS = computed(() => startMS.value + days.value * DAY)
const doses = computed(() => regimen.value?.build(startMS.value, weightKG) ?? [])

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

const recompute = async (): Promise<void> => {
  busy.value = true
  // 选择变化很快时，旧请求可能晚回：只有最后一次选择有资格写状态。
  generation += 1
  const mine = generation
  const input = {
    doses: doses.value,
    hormone: 'estradiol' as const,
    weightKG,
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
watch([regimenId, days], recompute)

const fmt = (value: number | null, digits = 1): string =>
  value === null ? '—' : value.toFixed(digits)
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">HRT Tracker · PK 对比</h1>
        <p class="mt-1 text-sm opacity-60">同一个方案，两个模型各算一遍。示例数据，不是用药建议。</p>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <USelect
          v-model="regimenId"
          :items="REGIMENS.map((item) => ({ label: item.label, value: item.id }))"
          class="w-56"
        />
        <UInput v-model.number="days" type="number" min="3" max="60" class="w-20" />
        <span class="opacity-60">天</span>
      </div>
    </header>

    <PkChart :curves="curves" :unit="unit" :height="360" />

    <p v-if="regimen" class="text-sm opacity-70">{{ regimen.note }}</p>

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
      {{ doses.length }} 条示例记录 · {{ weightKG }} kg · 步长 30 分钟 · 区间 {{ days }} 天。
      曲线来自群体模型，不能作为用药依据。
    </footer>
  </main>
</template>
