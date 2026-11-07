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

D1 / KV 的绑定写在 `deploy/workers/wrangler.jsonc`，里面的 id 是**占位符**，需要你自己建：

```bash
npx wrangler d1 create hrt-tracker              # → database_id
npx wrangler kv namespace create KV             # → id / preview_id
npx wrangler d1 migrations apply hrt-tracker --remote   # 首次上线前跑
```

`migrations_dir` 指向 `packages/db/migrations/sqlite`——那就是 drizzle-kit 生成的真迁移，
D1 用的和 VPS SQLite 用的是同一批 `.sql`，没有手抄的第二份。

## 数据库与迁移

schema 在 `packages/db`，一份逻辑模型、两个方言（`schema.sqlite.ts` / `schema.pg.ts`）。
两份一致性由 `packages/db/test/schema-parity.test.ts` 逐表逐列强制，不靠人记住。

```bash
bun run db:generate      # 改完 schema 后重生成两套迁移（migrations/sqlite + migrations/pg）
```

| 目标         | 应用迁移的方式                                                           |
| ------------ | ------------------------------------------------------------------------ |
| Cloudflare   | `wrangler d1 migrations apply <db>`（本地加 `--local`）                  |
| VPS SQLite   | `bunx drizzle-kit migrate --config packages/db/drizzle.sqlite.config.ts` |
| VPS Postgres | `bunx drizzle-kit migrate --config packages/db/drizzle.pg.config.ts`     |

迁移文件进版本库：线上跑的是这些 `.sql`，不是 TS。CI 里 `unit` job 会把两套 `.sql` 灌进
`bun:sqlite` 和 PGlite（真 PostgreSQL 的 wasm 编译），再写入同一份信封数据读回来比对，
所以不存在「迁移写错了到部署那天才发现」。

> Postgres 与 SQLite 用同一份 `DATABASE_URL` 区分不了方言，得在 `nuxt.config` / 运行时里挑驱动；
> v0.2 的存储层落地时补上（那时才会装 `better-sqlite3` / `pg`）。

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
- **`bun add --cwd <workspace>` 会把依赖装到根 `package.json`**（bun 1.4.4）。给 workspace
  加依赖的可靠做法是手写那个包的 `package.json`，再在仓库根跑 `bun install`。
