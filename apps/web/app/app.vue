<script setup lang="ts">
const { data: health } = await useFetch('/api/health')
</script>

<template>
  <UApp>
    <main class="grid min-h-dvh place-items-center p-6">
      <UCard class="w-full max-w-md">
        <template #header>
          <h1 class="text-lg font-semibold">HRT Tracker</h1>
        </template>
        <dl class="space-y-1 text-sm">
          <div class="flex justify-between gap-4">
            <dt class="opacity-70">protocol</dt>
            <dd class="font-mono">{{ health?.protocol ?? '—' }}</dd>
          </div>
          <div class="flex justify-between gap-4">
            <dt class="opacity-70">catalog</dt>
            <dd class="truncate font-mono">{{ health?.catalog ?? '—' }}</dd>
          </div>
        </dl>
        <template #footer>
          <p class="text-xs opacity-60">
            v0.1 骨架。曲线来自群体模型，不能作为用药依据。
          </p>
        </template>
      </UCard>
    </main>
  </UApp>
</template>
