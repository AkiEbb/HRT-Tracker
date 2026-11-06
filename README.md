# HRT Tracker

端到端加密的 HRT 用药与化验记录器。双药代动力学模型估算曲线，可校准、可分享、可自托管。

同一份代码，两种部署：**Cloudflare Workers（KV + D1）** 或 **自建 VPS（SQLite / PostgreSQL）**。

> ⚠️ 曲线来自**群体药代动力学模型**，不是化验结果，**不能作为用药依据**。要知道真实血药浓度只能抽血。

---

## 状态

**设计已定稿，未写业务代码。** 评审产物：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计契约：数据模型、密钥层级、同步协议、信任边界
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — 四阶段执行顺序与验收标准

## 技术栈

Nuxt 4 · Tailwind CSS v4 · `@nuxt/ui` v3 · uPlot · Drizzle ORM（D1 / better-sqlite3 / node-postgres）· WebCrypto + Argon2id · bun + Biome

## 许可

[MIT](LICENSE) © AkiEbb
