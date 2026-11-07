<script setup lang="ts">
/**
 * 应用外壳。页面自己负责内容，这里只提供全局 Provider 与背景。
 *
 * 深色是钉死的（`ui.colorMode: false`）：`class="dark"` 由服务端直出，
 * 不经过任何“跟随系统”的判断，所以首屏不会闪一下白底。
 */
useHead({
  title: 'HRT Tracker',
  htmlAttrs: { lang: 'zh-Hans', class: 'dark' },
  bodyAttrs: { class: 'bg-default text-default antialiased' },
})
</script>

<template>
  <UApp>
    <nav class="mx-auto flex max-w-5xl items-center gap-4 px-4 pt-4 text-sm sm:px-6">
      <span class="font-semibold">HRT Tracker</span>
      <NuxtLink to="/" class="opacity-60 transition hover:opacity-100">PK 对比</NuxtLink>
      <NuxtLink to="/records" class="opacity-60 transition hover:opacity-100">我的记录</NuxtLink>
      <NuxtLink to="/backup" class="opacity-60 transition hover:opacity-100">导入 / 导出</NuxtLink>
    </nav>
    <NuxtPage />
  </UApp>
</template>
