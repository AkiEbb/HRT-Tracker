<script setup lang="ts">
import { factorOf } from '@hrt/pk-core'
import type { Dose } from '@hrt/protocol'
import {
  ALL_COMPOUNDS,
  type Compound,
  categoryOf,
  type DoseExtras,
  makeDose,
  type Route,
} from '@hrt/protocol'
import { COMPOUND_LABELS, ROUTE_LABELS } from '#shared/pk/labels'

/**
 * 记录页：本地增删（v0.1 只做 dose；lab 的数据模型已在 protocol 里，界面留到 v0.3）。
 *
 * 写入走 `makeDose`，所以 `doseEquivMG` 一定由 catalog 换算得出，
 * 界面永远不会自己写"当量"这个字段（§4.2 的双字段陷阱）。
 */
const { store, error: storeError } = useRecordStore()

const rows = shallowRef<Dose[]>([])
const busy = ref(false)
const message = ref<string | null>(null)

const form = reactive({
  compound: 'EV' as Compound,
  route: 'injection' as Route,
  doseMG: 5,
  takenAtLocal: toLocalInput(Date.now()),
  note: '',
})

const isAntiAndrogen = computed(() => categoryOf(form.compound) === 'antiAndrogen')
const compoundItems = ALL_COMPOUNDS.map((value) => ({
  value,
  label: COMPOUND_LABELS[value] ?? value,
}))
const routeItems = (Object.keys(ROUTE_LABELS) as Route[]).map((value) => ({
  value,
  label: ROUTE_LABELS[value],
}))

function toLocalInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}

const refresh = async (): Promise<void> => {
  if (store.value === null) return
  busy.value = true
  try {
    rows.value = await store.value.list('dose')
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

const add = async (): Promise<void> => {
  const target = store.value
  if (target === null) return
  message.value = null
  try {
    const takenAt = new Date(form.takenAtLocal).getTime()
    if (!Number.isFinite(takenAt)) throw new Error('时间填得不对')
    const payload = makeDose(
      {
        compound: form.compound,
        route: form.route,
        doseMG: form.doseMG,
        clientUpdatedAt: Date.now(),
        ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
      },
      factorOf,
    )
    await target.put('dose', { id: crypto.randomUUID(), takenAt, payload })
    await refresh()
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : String(cause)
  }
}

const remove = async (id: string): Promise<void> => {
  await store.value?.delete('dose', id)
  await refresh()
}

const clearAll = async (): Promise<void> => {
  await store.value?.clear()
  await refresh()
}

/** 仅用于展示与导出：原始剂量与当量并排，两者语义不同（§4.2）。 */
const describe = (dose: Dose): string => {
  const { compound, route, doseMG, doseEquivMG } = dose.payload
  const extras = dose.payload.extras
  const detail = describeExtras(extras)
  return `${COMPOUND_LABELS[compound] ?? compound} · ${ROUTE_LABELS[route]} · ${doseMG} mg → 当量 ${doseEquivMG.toFixed(3)} mg${detail === '' ? '' : ` · ${detail}`}`
}

function describeExtras(extras: DoseExtras | undefined): string {
  if (extras === undefined) return ''
  const parts: string[] = []
  if (extras.areaCm2 !== undefined) parts.push(`${extras.areaCm2} cm²`)
  if (extras.releaseRateUgPerDay !== undefined) parts.push(`${extras.releaseRateUgPerDay} µg/日`)
  if (extras.holdMinutes !== undefined) parts.push(`含服 ${extras.holdMinutes} 分钟`)
  return parts.join('，')
}

const formatTime = (ms: number): string => new Date(ms).toLocaleString('zh-CN', { hour12: false })

onMounted(refresh)
watch(store, refresh)
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">我的记录</h1>
        <p class="mt-1 text-sm opacity-60">
          记录只存在这台设备的浏览器里。v0.1 还没有账号，也没有上传。
        </p>
      </div>
      <NuxtLink to="/" class="text-sm text-primary underline-offset-4 hover:underline">
        看曲线 →
      </NuxtLink>
    </header>

    <UAlert v-if="storeError" color="error" variant="subtle" title="无法访问本地存储" :description="storeError" />

    <UCard>
      <template #header>
        <span class="text-sm font-medium">新增一条</span>
      </template>
      <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="add">
        <UFormField label="药物">
          <USelect v-model="form.compound" :items="compoundItems" class="w-full" />
        </UFormField>
        <UFormField label="途径">
          <USelect v-model="form.route" :items="routeItems" class="w-full" />
        </UFormField>
        <UFormField label="剂量 (mg)" hint="药物本身的质量，不是当量">
          <UInput v-model.number="form.doseMG" type="number" step="0.01" min="0" class="w-full" />
        </UFormField>
        <UFormField label="时间">
          <UInput v-model="form.takenAtLocal" type="datetime-local" class="w-full" />
        </UFormField>
        <UFormField label="备注（可选）" class="sm:col-span-2">
          <UInput v-model="form.note" class="w-full" />
        </UFormField>
        <p v-if="isAntiAndrogen" class="text-xs opacity-60 sm:col-span-2">
          抗雄只记录、不建模：它的活性当量恒为 0，不会出现在 E2 / T 曲线上。
        </p>
        <div class="flex items-center gap-3 sm:col-span-2">
          <UButton type="submit" :disabled="store === null">保存</UButton>
          <span v-if="message" class="text-sm text-red-400">{{ message }}</span>
        </div>
      </form>
    </UCard>

    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium">已保存 {{ rows.length }} 条</h2>
        <span v-if="busy" class="text-xs opacity-50">读取中…</span>
        <UButton
          v-if="rows.length > 0"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="clearAll"
        >
          全部删除
        </UButton>
      </div>

      <p v-if="store !== null && rows.length === 0" class="py-10 text-center text-sm opacity-50">
        还没有记录
      </p>

      <ul
        v-if="rows.length > 0"
        class="divide-y divide-white/10 rounded-xl border border-white/10"
      >
        <li
          v-for="dose in rows"
          :key="dose.id"
          class="flex items-start justify-between gap-4 p-3 text-sm"
        >
          <div class="min-w-0">
            <p class="font-mono text-xs opacity-60">{{ formatTime(dose.takenAt) }}</p>
            <p class="mt-1">{{ describe(dose) }}</p>
            <p v-if="dose.payload.note" class="mt-1 text-xs opacity-60">{{ dose.payload.note }}</p>
          </div>
          <UButton color="neutral" variant="ghost" size="xs" @click="remove(dose.id)">删除</UButton>
        </li>
      </ul>
    </section>
  </main>
</template>
