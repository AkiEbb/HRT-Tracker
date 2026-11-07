# 部署

两个目标共用一份代码、同一个 `.output/` 目录，**先选 preset 再构建**，不要混着用。

| 目标    | preset              | 谁在跑               |
| ------- | ------------------- | -------------------- |
| VPS     | `node-server`       | node ≥ 22 + 反代     |
| Workers | `cloudflare_module` | workerd / Cloudflare |

## VPS（node-server）

```bash
bun install
bun run build:node
PORT=3210 node apps/web/.output/server/index.mjs
```

生产上跑的是 `deploy/systemd/hrt-tracker.service` 的形状：`EnvironmentFile` 放密钥（`0600`），
静态资源由反代直接从 `apps/web/.output/public` 提供，或让 Nitro 自己发。

## Cloudflare Workers

```bash
bun install
bun run build:cf
npx wrangler dev apps/web/.output/server/index.mjs --assets apps/web/.output/public --port 3212  # 本地
npx wrangler deploy apps/web/.output/server/index.mjs --assets apps/web/.output/public            # 上线
```

**wrangler 4 必须给显式入口**：只写 `wrangler dev --local` 会报
`Missing entry-point to Worker script or to assets directory`。
D1 / KV / Cron 的绑定在 v0.2 接入后再补 `wrangler` 配置，现在还没有要绑的东西。

## 冒烟（两条目标同一套）

```bash
deploy/smoke.sh 3210   # node
deploy/smoke.sh 3212   # workerd
```

断言的是：`/api/health` 返回 `{"ok":true,...}`，`/`、`/records`、`/backup` 都是 200。
node 与 workerd 的 health JSON 必须**逐字节一致**——它把 catalog 的来源和两个引擎的凝胶峰值
一起报出来，是「两个目标跑的是同一份计算」的唯一外部证据。

## 已知坑

- **两个 preset 覆盖同一个 `.output/`。** 本地验收必须两轮：`build:node` → 起 node → 冒烟；
  再 `build:cf` → 起 wrangler → 冒烟。CI 里同理，`node` 与 `cf-local` 是两个独立 job。
- **包不能被 externals 到运行时去解析。** `@hrt/protocol` / `@hrt/pk-core` 是 workspace TS 包，
  需要 `nitro.externals.inline` **和** `vite.ssr.noExternal` 同时设置（见 `docs/DESIGN.md` §3）。
- **`wrangler dev` 端口占用不友好**：上一次没退干净会直接抢不到端口，先 `pgrep -af workerd`。
