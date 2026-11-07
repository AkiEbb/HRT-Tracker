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
    <NuxtPage />
  </UApp>
</template>
