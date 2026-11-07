<script setup lang="ts">
import { factorOf } from '@hrt/pk-core'
import type { Dose, ImportResult, Lab } from '@hrt/protocol'
import { exportKiraHrt } from '@hrt/protocol'
import type { ImportFormat } from '#shared/pk/backup'
import { parseBackup, preservedKeys, summarize } from '#shared/pk/backup'

/**
 * 导入 / 导出。
 *
 * 两条铁律落在界面上：
 *  - 导入**先预览后写入**，跳过项与警告必须看得见（§8.3-3：不静默丢弃）；
 *  - 导出是**明文健康数据**，没有勾选确认就不给下载（§8.2）。
 */
const { store, error: storeError } = useRecordStore()

const formatChoice = ref<'auto' | ImportFormat>('auto')
const inferAnalyte = ref(false)
const preview = shallowRef<{ format: ImportFormat; result: ImportResult } | null>(null)
const fileName = ref('')
const busy = ref(false)
const message = ref<string | null>(null)
const importedAt = ref<number | null>(null)

const doses = shallowRef<Dose[]>([])
const labs = shallowRef<Lab[]>([])

const refresh = async (): Promise<void> => {
  const target = store.value
  if (target === null) return
  const [d, l] = await Promise.all([target.list('dose'), target.list('lab')])
  doses.value = d
  labs.value = l
}

onMounted(refresh)
watch(store, refresh)

const onFile = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file === undefined) return
  fileName.value = file.name
  preview.value = null
  message.value = null
  busy.value = true
  try {
    const text = await file.text()
    const parsed = parseBackup(text, {
      factorOf,
      ...(formatChoice.value === 'auto' ? {} : { format: formatChoice.value }),
      ...(inferAnalyte.value ? { inferAnalyteFromUnit: true } : {}),
    })
    preview.value = { format: parsed.format, result: parsed.result }
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
    // 允许重复选同一个文件触发 change
    input.value = ''
  }
}

const commit = async (): Promise<void> => {
  const target = store.value
  const pending = preview.value
  if (target === null || pending === null) return
  busy.value = true
  message.value = null
  try {
    // 逐条 put：导入的记录带原 id，同一份文件再导一次只会覆盖，不会翻倍。
    for (const dose of pending.result.doses) await target.put('dose', dose)
    for (const lab of pending.result.labs) await target.put('lab', lab)
    importedAt.value = pending.result.doses.length + pending.result.labs.length
    await refresh()
    preview.value = null
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

const exportConfirmed = ref(false)
const exportWarnings = shallowRef<string[]>([])

const download = (): void => {
  const { data, warnings } = exportKiraHrt(doses.value, labs.value)
  exportWarnings.value = warnings
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  link.href = url
  link.download = `hrt-tracker-kira-hrt-${stamp}.json`
  link.click()
  URL.revokeObjectURL(url)
}

const skipList = computed(() => preview.value?.result.report.skipped.slice(0, 10) ?? [])
const warnings = computed(() => preview.value?.result.report.warnings ?? [])
const preserved = computed(() =>
  preview.value === null ? [] : preservedKeys(preview.value.result.report),
)
const skippedCount = computed(() => preview.value?.result.report.skipped.length ?? 0)
</script>

<template>
  <main class="mx-auto flex min-h-dvh max-w-5xl flex-col gap-5 p-4 sm:p-6">
    <header>
      <h1 class="text-xl font-semibold">导入 / 导出</h1>
      <p class="mt-1 text-sm opacity-60">
        可以从 Kira HRT Tracker 或 Transmtf HRT Tracker 的备份搬数据过来，导出用 Kira 的明文格式。
      </p>
    </header>

    <UAlert
      v-if="storeError"
      color="error"
      variant="subtle"
      title="无法访问本地存储"
      :description="storeError"
    />

    <UCard>
      <template #header>
        <span class="text-sm font-medium">导入</span>
      </template>
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-end gap-3">
          <UFormField label="文件格式">
            <USelect
              v-model="formatChoice"
              :items="[
                { label: '自动识别', value: 'auto' },
                { label: 'Kira HRT', value: 'kira-hrt' },
                { label: 'Transmtf', value: 'transmtf' },
              ]"
              class="w-40"
            />
          </UFormField>
          <label class="inline-flex cursor-pointer items-center rounded-lg bg-elevated px-3 py-2 text-sm">
            <input type="file" accept=".json,application/json" class="hidden" @change="onFile" />
            选择备份文件
          </label>
          <span v-if="fileName" class="text-xs opacity-60">{{ fileName }}</span>
        </div>

        <UCheckbox
          v-model="inferAnalyte"
          label="缺 analyte 时按单位推断（旧备份兼容，默认关闭）"
          description="按单位猜分析物会把 ng/dl 的睾酮化验误记成 E2 的可能性降为零——但也就不会补任何信息。"
        />

        <p v-if="busy" class="text-xs opacity-60">处理中…</p>
        <p v-if="message" class="text-sm text-red-400">{{ message }}</p>
        <p v-if="importedAt !== null" class="text-sm text-green-400">
          已写入 {{ importedAt }} 条记录。
          <NuxtLink to="/records" class="underline">去看看</NuxtLink>
        </p>

        <div v-if="preview" class="rounded-lg border border-white/10 p-3 text-sm">
          <p class="font-medium">
            读出来：{{ summarize(preview.result) }}
            <span class="ml-2 text-xs opacity-60">
              （判定为 {{ preview.format === 'kira-hrt' ? 'Kira HRT' : 'Transmtf' }}）
            </span>
          </p>

          <div v-if="skippedCount > 0" class="mt-2">
            <p class="text-xs text-amber-400">跳过 {{ skippedCount }} 条：</p>
            <ul class="mt-1 list-inside list-disc text-xs opacity-70">
              <li v-for="row in skipList" :key="row.index">
                第 {{ row.index }} 条 — {{ row.reason }}
              </li>
            </ul>
            <p v-if="skippedCount > skipList.length" class="mt-1 text-xs opacity-50">
              还有 {{ skippedCount - skipList.length }} 条未显示
            </p>
          </div>

          <div v-if="warnings.length > 0" class="mt-2">
            <p class="text-xs text-amber-400">需要注意：</p>
            <ul class="mt-1 list-inside list-disc text-xs opacity-70">
              <li v-for="line in warnings" :key="line">{{ line }}</li>
            </ul>
          </div>

          <p v-if="preserved.length > 0" class="mt-2 text-xs opacity-60">
            未建模但已保留的顶层字段：{{ preserved.join('、') }}
          </p>

          <div class="mt-3 flex items-center gap-3">
            <UButton :disabled="busy || store === null" @click="commit">确认写入</UButton>
            <UButton color="neutral" variant="ghost" @click="preview = null">取消</UButton>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <span class="text-sm font-medium">导出</span>
      </template>
      <div class="flex flex-col gap-3 text-sm">
        <p class="opacity-70">
          当前共 {{ doses.length }} 条给药、{{ labs.length }} 条化验，将导出为
          <code class="text-xs">kira-hrt</code> 格式。
        </p>
        <UAlert
          color="warning"
          variant="subtle"
          title="导出的是明文健康数据"
          description="文件里没有任何加密。分享、上传、放进网盘前请自己确认风险。"
        />
        <UCheckbox v-model="exportConfirmed" label="我知道这是明文，仍然导出" />
        <div class="flex items-center gap-3">
          <UButton :disabled="!exportConfirmed || doses.length + labs.length === 0" @click="download">
            下载备份
          </UButton>
          <span v-if="doses.length + labs.length === 0" class="text-xs opacity-50">还没有可导出的记录</span>
        </div>
        <ul v-if="exportWarnings.length > 0" class="list-inside list-disc text-xs opacity-60">
          <li v-for="line in exportWarnings" :key="line">{{ line }}</li>
        </ul>
      </div>
    </UCard>
  </main>
</template>
