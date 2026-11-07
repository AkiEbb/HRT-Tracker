# HRT Tracker

端到端加密的 HRT 用药与化验记录器。双药代动力学模型估算曲线，可校准、可分享、可自托管。

同一份代码，两种部署：**Cloudflare Workers（KV + D1）** 或 **自建 VPS（SQLite / PostgreSQL）**。

> ⚠️ 曲线来自**群体药代动力学模型**，不是化验结果，**不能作为用药依据**。要知道真实血药浓度只能抽血。

---

## 状态

v0.1「能算」已收尾：不登录、不联网，本机就能记录、看曲线、导入导出。

- 记录存在浏览器 IndexedDB（`docs/DESIGN.md` §4.6），刷新/重开仍在
- 两个 PK 引擎（`builtin` = HRT-Recorder 参数，`transmtf` = Transmtf 参数）在 Web Worker 里跑，同屏叠加对比
- 能从 Kira HRT Tracker / Transmtf HRT Tracker 的备份导入，导出 `kira-hrt` 明文
- 账号、同步、分享、PWA 还没做，按 [`docs/ROADMAP.md`](docs/ROADMAP.md) 推进

设计契约在 [`docs/DESIGN.md`](docs/DESIGN.md)：数据模型、密钥层级、同步协议、信任边界、已知缺口。

## 本地跑

```bash
bun install
bun run dev          # http://localhost:3100
```

```bash
bun test             # 单元测试（引擎、协议、导入、Worker 协议）
bun run typecheck    # 三个包各一次
bunx biome check .   # 格式 + lint
```

两种目标的构建与冒烟见 [`deploy/README.md`](deploy/README.md)：

```bash
bun run build:node && (cd apps/web && PORT=3210 node .output/server/index.mjs) & deploy/smoke.sh 3210
```

## 目录

| 路径                | 内容                                                     |
| ------------------- | -------------------------------------------------------- |
| `apps/web`          | Nuxt 4 应用（页面、Worker、IndexedDB、图表）             |
| `packages/protocol` | 记录类型、双剂量字段换算、导入导出                       |
| `packages/pk-core`  | 两份 catalog + 两个 PK 引擎 + 共享数值内核 + Worker 协议 |
| `deploy`            | 两种目标的启动方式、systemd 样例、冒烟脚本               |
| `docs`              | 设计契约与路线图                                         |

## 技术栈

Nuxt 4 · Tailwind CSS v4 · `@nuxt/ui` v4 · uPlot · Drizzle ORM（D1 / better-sqlite3 / node-postgres）· WebCrypto + Argon2id · bun + Biome

## 许可

[MIT](LICENSE) © AkiEbb
