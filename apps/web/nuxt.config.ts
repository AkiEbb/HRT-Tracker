export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // workspace 里的 TS-only 包：Nitro 默认把 node_modules 当外部依赖，
  // 不显式内联的话，Cloudflare 构建会把它们当成运行时要解析的包而失败。
  // 这是 v0.1 的第一个技术风险点（docs/DESIGN.md §3）。
  nitro: {
    preset: process.env.NITRO_PRESET,
    externals: { inline: ['@hrt/protocol', '@hrt/pk-core'] },
  },
  vite: {
    ssr: { noExternal: ['@hrt/protocol', '@hrt/pk-core'] },
  },
})
