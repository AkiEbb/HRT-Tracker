export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // v0.1 只有深色一种配色。关掉 color-mode 模块而不是“默认深色”：
  // 只要模块还在，用户存过一次 light（或跟随系统得到 light）就会把图表的
  // 对比度拖进没设计过的浅色主题。`app.vue` 直接在 <html> 上钉上 class="dark"。
  ui: { colorMode: false },

  // workspace 里的 TS-only 包：Nitro 默认把 node_modules 当外部依赖，
  // 不显式内联的话，Cloudflare 构建会把它们当成运行时要解析的包而失败。
  // 这是 v0.1 的第一个技术风险点（docs/DESIGN.md §3）。
  nitro: {
    preset: process.env.NITRO_PRESET,
    externals: { inline: ['@hrt/protocol', '@hrt/pk-core'] },
  },
  vite: {
    ssr: { noExternal: ['@hrt/protocol', '@hrt/pk-core'] },
    optimizeDeps: { include: ['uplot'] },
  },
})
