# HRT Tracker — 设计文档

> 状态：**待评审**（未写任何业务代码）
> 本文是设计树（28 项决策）的全部结论。评审通过后，`docs/ROADMAP.md` 是执行顺序，本文是实现契约。
> 若本文与代码冲突，**先改代码或先改本文**，不允许两者并存。

- 仓库：`github.com/AkiEbb/HRT-Tracker`
- 许可证：MIT（© AkiEbb）
- 提交身份：`AkiEbb <me@akiebb.dev>`，SSH 签名（见 §13）

---

## 0. 一句话

**一个端到端加密的 HRT 用药/化验记录器**：双药代动力学模型估算曲线、可校准、可分享、可自托管，同一份代码跑在 Cloudflare Workers（KV + D1）与自建 VPS（SQLite / PostgreSQL）上。

---

## 1. 不可协商的铁律

任何 PR 都不得违反这五条；违反不是"权衡"，是缺陷。

1. **服务端永不接触明文。** 服务端只见信封元数据 `(id, kind, takenAt, rev, deviceId, updatedAt)` 与密文。没有"平台密钥"，没有服务端 DEK 副本。
2. **忘记安全密码 = 云端数据永久不可恢复。** 注册强制生成恢复短语并强制抄写确认。
3. **服务端没有"帮用户看一眼数据"的运维手段。** 排障只能依赖：密文长度、错误码、版本号、客户端自愿导出的调试包（用户自己生成并主动发送）。
4. **计算在客户端。** PK 模拟、校准、OCR（v1.0 已砍）、MCP 正文读写全在客户端；服务端职责只有：身份认证、密文存储、CAS 裁决、分享快照分发、提醒调度。
5. **文档与 UI 的承诺必须与实际能力完全对齐** ——既不许夸大（"我们看不到你的数据"在没做到时是事故），也不许自贬（能力已实现却写成"可能不安全"同样是缺陷）。

> 第 3 条的替代方案（已设计，见 §11.3）：客户端埋点只上报**长度 / 版本 / 错误码**；"导出调试包"由用户本地生成、用户自己决定发给谁。

---

## 2. 技术栈

| 层       | 选择                                                                  | 备注                                                                                                               |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 框架     | Nuxt 4（Nitro v2）                                                    | Workers 用 `cloudflare_module` preset，compatibility date ≥ `2024-09-19`                                           |
| 样式     | Tailwind CSS v4（`@tailwindcss/vite`）                                | 无 `postcss.config`，v4 走 Vite 插件                                                                               |
| 组件     | `@nuxt/ui` **v4**                                                     | 建在 reka-ui + Tailwind v4 上，主题走 `app.config.ts` tokens；`tailwindcss` 必须显式装在本包（不能靠传递依赖解析） |
| 图表     | **uPlot**（≈45KB min）                                                | 高密度时间序列 + 双模型叠加对比                                                                                    |
| PK 计算  | **Web Worker**                                                        | 主线程只发消息，避免低端安卓卡输入                                                                                 |
| 数据层   | **Drizzle ORM + drizzle-kit**                                         | 三方言：`d1` / `better-sqlite3` / `node-postgres`                                                                  |
| 口令哈希 | **Argon2id via `hash-wasm`**                                          | Workers 无原生 Argon2；WASM 在两端都能跑                                                                           |
| 加密     | **XChaCha20-Poly1305**（`@noble/ciphers`）+ 恢复短语用 `@scure/bip39` | 24 字节随机 nonce 才敢纯随机（AES-GCM 的 96-bit nonce 一旦复用就是灾难）；纯 JS 无 wasm 加载                       |
| i18n     | `@nuxtjs/i18n`                                                        | v0.1 只 `zh-Hans` + `en`                                                                                           |
| 工具链   | **bun 1.4** + **Biome**                                               | 与 `AkiEbb/blog` 一致                                                                                              |
| 测试     | `bun test`（单元）+ Vitest（组件）+ Playwright（E2E）                 | 金标准夹具见 §8.4                                                                                                  |
| 发布     | `git-cliff`（Conventional Commits）                                   | `cliff.toml` 已就位                                                                                                |

**实际锁定**（2026-11-06 `bun install`）：nuxt 4.6.4 · Nitro 2.13.6 · Vite 8.3.6 · Vue 3.5.45 · vue-router 5.4.0 · `@nuxt/ui` 4.12.0 · tailwindcss 4.3.5 · bun 1.4.2。
版本以 `bun.lock` 为准；本节只记录「当时为什么选它」，不重复记版本号。

---

## 3. 仓库结构

```
HRT-Tracker/
├─ apps/
│  └─ web/                 # Nuxt 应用（唯一可执行入口）
│     ├─ app/              # pages / components / composables
│     ├─ server/           # Nitro: api/auth/sync/share/push
│     └─ nuxt.config.ts
├─ packages/
│  ├─ pk-core/             # 两套 PK 引擎 + catalog（JSON 参数真源）+ 校准
│  ├─ protocol/            # 内部 schema、导入导出、金标准夹具
│  ├─ crypto/              # DEK/KEK、Argon2id、XChaCha20-Poly1305 信封、恢复短语
│  └─ db/                  # Drizzle schema（sqlite + pg）+ 生成的迁移 .sql + src/store/ 存储层接缝
├─ docs/                   # DESIGN.md / ROADMAP.md
├─ deploy/
│  ├─ workers/             # wrangler.jsonc（D1 迁移目录指向 packages/db）
│  └─ vps/                 # Dockerfile、compose.yaml、systemd unit
├─ scripts/                # 迁移/按键校验/夹具生成
├─ cliff.toml  biome.json  package.json  tsconfig.base.json
```

**约定**：`packages/*` 不做构建步骤，`exports` 直指 `src/index.ts`，由 Nitro/Vite 打包。

> ✅ **已验证（v0.1 第一周）**：两处同时声明后，`node-server` 与 `cloudflare_module` 双目标均构建成功，
> 且分别在 node 与 workerd（`wrangler dev`）上实测返回同一份数据。
> **关键：只写一处不够**——SSR 走 Vite 的解析器，Nitro 产物走 rollup 的解析器，两边都要放行：
> `nitro.externals.inline` + `vite.ssr.noExternal`。少一边，问题会推迟到部署时才炸。

> ⚠️ 两个部署目标的产物写在**同一个 `.output/`**，后一次构建会覆盖前一次。
> 所以本地验收也必须分两轮：`build:node` → `PORT=3210 node .output/server/index.mjs`；
> `build:cf` → `npx wrangler dev .output/server/index.mjs --assets .output/public --port 3211`。
> wrangler 4 起必须显式给入口（不再从 `nuxt preview` 或默认配置里猜），漏了会报
> `Missing entry-point to Worker script or to assets directory`。

---

## 4. 数据模型

### 4.1 术语

| 术语       | 取值                                                             | 说明                                              |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `category` | `estradiol` / `testosterone` / `antiAndrogen`                    | 上游模型的一等公民；`antiAndrogen` 只记录、不建模 |
| `compound` | `E2 EB EV EC EN EU` / `T TC TE TU` / `CPA ...`                   | 统一替代上游的 `ester`，为睾酮留位                |
| `route`    | `injection` `oral` `sublingual` `gel` `patchApply` `patchRemove` | 与上游一致，不多不少                              |
| `unit`     | `pg/ml` `pmol/l`（E2）× `ng/dl` `nmol/l`（T）                    | 单位与 `analyte` 解耦                             |

### 4.2 剂量：**两个字段，永不合流**

这是整个项目最容易致命的一处。同一名字（`doseMG`）在两处语义相反：

- Kira 协议：`doseMG` = **药物本身的质量**（戊酸雌二醇 2mg ≠ 雌二醇 2mg）
- 上游 PK 模型：`doseMG` = **活性当量**（输入已按 E2/T 当量归一，参数里不再乘换算因子）

因此内部 schema 强制拆开：

| 字段              | 类型    | 语义                                                                |
| ----------------- | ------- | ------------------------------------------------------------------- |
| `doseMG`          | number  | **原始药物质量**，用户输入什么就是什么                              |
| `doseEquivMG`     | number  | **活性当量**，由 `compound` 的 `toActiveFactor`（catalog 提供）换算 |
| `equivOverridden` | boolean | 用户手工改过当量时为 `true`，禁止再自动覆盖                         |

规则：

1. PK 引擎**只吃** `doseEquivMG`；`doseMG` 不参与任何计算。
2. 换算因子**只存在于 catalog JSON**，代码里不得出现魔法数字。
3. 导出到 `kira-hrt` 时写 `doseMG`（原始量）；从 `kira-hrt` 导入时按 `ester` 查 catalog 换算出 `doseEquivMG`。
4. 契约测试：任取 N 条记录做 `import → export` 往返，`doseMG` 必须逐条等值（见 §8.4）。
5. 抗雄（`category = antiAndrogen`）**没有当量**：`doseEquivMG` 恒为 `0`，因为它对 E2/T 曲线的贡献就是 0。
   拿它的 `doseMG` 冒充当量，会把「50mg 色普龙」画成「50mg 雌二醇」——这是这类项目最贵的一类错误。

### 4.3 信封（服务端可见的部分）

```ts
interface Envelope {
  id: string // UUIDv7（时间有序，便于分页）
  userId: string
  kind: 'dose' | 'lab' | 'scalar' | 'tombstone'
  takenAt: number | null // epoch ms；标量与墓碑为 null
  rev: number // 单调递增，CAS 依据
  deviceId: string
  updatedAt: number // 服务端时钟，仅用于游标分页，**不用于裁决**
  iv: string // base64，XChaCha20-Poly1305 192-bit nonce
  ct: string // base64，ciphertext || tag
}
```

`kind` 与 `takenAt` 明文是刻意的权衡：服务端需要它们做分页、墓碑清扫与提醒调度；它们本身不构成健康信息（你不知道 `dose` 是哪一种药）。若某天认为 `takenAt` 也是敏感信息，改用"日桶"粒度即可，协议留了 `kind=scalar:reminder` 的旁路。

### 4.4 密文内的载荷

**dose**

| 字段                          | 必填 | 说明                                                                                  |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `compound` `category` `route` | ✓    | 见 §4.1                                                                               |
| `doseMG` `doseEquivMG`        | ✓    | 见 §4.2                                                                               |
| `extras`                      |      | 途径相关：`{ areaCm2?, releaseRateUgPerDay?, holdMinutes?, theta?, site?, batchNo? }` |
| `note`                        |      | 自由文本                                                                              |
| `tzOffsetMin`                 |      | 记录时刻的本地偏移，用于正确显示与提醒                                                |
| `weightKG`                    |      | 给药**当时**的体重（上游两种工具都按事件存）；缺失时回落备份级 `bodyWeightKg`         |
| `clientUpdatedAt`             | ✓    | 客户端时钟，**冲突裁决用这个**                                                        |

**lab**

| 字段               | 必填 | 说明                                                             |
| ------------------ | ---- | ---------------------------------------------------------------- |
| `analyte`          | ✓    | `E2` / `T` / `unknown`。**权威字段，不按单位猜**                 |
| `concValue` `unit` |      | 只含监测项时省略                                                 |
| `monitoring`       |      | `{ prolactin?, prolactinUln?, alt?, altUln?, ast?, potassium? }` |
| `labNote`          |      |                                                                  |

> `unknown` 保留、可编辑、可导出，但**不进入任何拟合**（E2 / T / 背景 E2）。既无激素值又无监测项的记录直接丢弃。
> 类型补全只在"字段缺失"时发生，显式 `unknown` 永不覆盖。

**scalar**（`kind='scalar'`，`id` = `scalar:weight` / `scalar:pkParams` / `scalar:medPlan` / `scalar:appSettings`）

按键并集 + 每键 `stamp`，语义与 Kira 的 `mergeIncomingAppState` 一致：incoming 覆盖同键，prior 独有键保留，**无法表达"删键"**（删除走 tombstone）。

**tombstone**

```ts
{ kind: 'tombstone', targetId: string, deletedAt: number }
```

不物理删除，永不复活（合并时以 lexicographic max 为准）。

### 4.5 时间

- 内部一律 **epoch ms（UTC）**；`tzOffsetMin` 只用于显示与提醒。
- `timeH`（自 epoch 起的小时数）**只存在于导入导出边界**，是协议方言，不是内部表示。
- 提醒按用户 IANA 时区展开成下一次触发时刻，存 `next_fire_at`（epoch ms）供扫描。

### 4.6 本地存储（v0.1）

v0.1 没有账号，记录存在**这台设备的浏览器**里。选型与边界：

| 项   | 决定                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| 引擎 | IndexedDB（`hrt-tracker` 库，`dose` / `lab` 两个 store，`takenAt` 建索引）              |
| 访问 | 只经由 `RecordStore` 接口（`list` / `put` / `delete` / `clear`），页面不碰 `IDBRequest` |
| 内容 | **明文** `Dose` / `Lab`。v0.2 上手后换成 `Envelope{iv, ct}`，接口不变、页面不改         |
| 不用 | OPFS + SQLite WASM：首屏多 1–2 MB、要 COOP/COEP 头换 SharedArrayBuffer，v0.1 不值得     |

为什么先明文：现在既没账号也没密钥，先套信封只会造一把没锁的钥匙；但接口必须现在立住，
否则 v0.2 要改的是每个页面的读取路径，而不是一个实现。

`useRecordStore()` 返回 `{ store: ShallowRef<RecordStore | null>, error }`：SSR 阶段 `store` 是 `null`，
页面据此显示空态（而不是在服务端伪造一个空库，让首屏与服务端数据不一致）。

---

## 5. 密钥层级

```
                 安全密码 ──Argon2id(m=64MiB,t=3,p=1)──► KEK ──XChaCha20-Poly1305──┐
                                                                               ├──► DEK(32B, 随机)
                 恢复短语(24 词) ──Argon2id(同参)──► KEK2 ──XChaCha20-Poly1305────┘        │
                                                                                        │
   每条记录明文 ──XChaCha20-Poly1305(DEK, AAD = id|kind|rev)──► ct ──────────────────────┘

   分享密码 ──Argon2id──► shareKey ──包裹(临时快照密钥)──► KV 中的密文快照
```

**D1 中 `users` 表存什么**：`dek_wrapped_kek`、`dek_wrapped_recovery`（两段 base64 的包裹对象：`iv|ct`，**tag 在 ct 末尾，不单独一段**）、两个 salt、Argon2 参数。**没有 DEK 明文，没有可由服务端推导的材料。**

参数与编码的具体值（`packages/crypto` 已实现，有测试对参考实现逐字节对照）：

| 项         | 值                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------ |
| KDF        | Argon2id，`memorySizeKiB = 65536`（= 64 MiB）、`iterations = 3`、`parallelism = 1`、输出 32 字节 |
| salt       | 16 字节随机，`kdf_salt_a`（口令）与 `kdf_salt_b`（恢复短语）**各自独立**                         |
| AEAD       | XChaCha20-Poly1305，nonce **24 字节纯随机**（不需要计数器，也就不存在回绕复用）                  |
| 存储编码   | `base64(iv) + "                                                                                  | " + base64(ct‖tag)` |
| 恢复短语   | BIP39 英文 24 词（256 bit 熵 + 8 bit 校验和），只包裹/解包 DEK                                   |
| 口令归一化 | NFKC（全角/组合字符算同一个口令），**不 trim**（首尾空格是密码的一部分）                         |

**AAD 的编码不是“把三个字段用 `|` 拼起来”那么简单**：id 是客户端生成、将来还来自导入文件的自由字符串，
裸拼接下 `id="ab",kind="dose"` 与 `id="a",kind="b|dose"` 会撞。实现用长度前缀：
`hrt:record:v1|<id 字节长>:<id>|<kind>|<rev>`，并且直接拒绝含 `|` 的 `kind`。
包裹用的两段也用域分隔 AAD（`hrt:dek:v1|wrapped-by:kek` 与 `…:recovery`），否则“恢复短语包的那段密文”
可以被搬到 `dek_wrapped_kek` 列下，把“用短语解”降级成“用密码解”。

### 5.1 不变量

1. DEK 只在客户端内存中存在；登出、切换账号、重锁立即丢弃。
2. 改密码 = 用新 KEK 重新包裹**同一个 DEK**，记录密文不动（无需重加密全库）。
3. 恢复短语等价于"第二把钥匙"，只能包裹/解包 DEK，**不能当登录凭据**（登录仍需身份认证）。
4. 每条记录的 AAD 绑定 `id|kind|rev`：阻止服务端把 A 的密文挪到 B 的 id 下，或回放旧 rev。
5. `shareKey` 只包裹**临时快照密钥**，快照与主库密钥完全隔离；分享撤销只删 KV 条目，不影响主数据。

### 5.2 四种登录方式如何与 E2EE 共存

| 方式                       | 认证               | 解密                     | 备注                                                                      |
| -------------------------- | ------------------ | ------------------------ | ------------------------------------------------------------------------- |
| 邮箱 + 口令                | ✓（Argon2id 校验） | ✓（派生 KEK）            | 主路径                                                                    |
| TOTP                       | 第二步验证         | 不参与                   | 与口令叠加                                                                |
| OIDC（GitHub/Google/自建） | ✓                  | ✗                        | **登录后仍需输安全密码**，UI 必须明说                                     |
| Passkey / WebAuthn         | ✓                  | 可选（PRF 扩展派生 KEK） | PRF 支持矩阵：Chromium / Safari 支持，Firefox 至今无 → 必须能力探测并降级 |

> 这条是"四种登录都做"与"真 E2EE"的接缝：**OIDC 提供了便利，但永远不能单独解锁数据**。用户界面上 `OIDC 登录 → 输入安全密码` 的两段式必须显式，不能伪装成一次登录。

### 5.3 明确不承诺的东西

- 不防御设备被完全控制（内存中的 DEK 可被读）。
- 不防御"用户主动导出明文"（`kira-hrt` 导出就是明文）。
- 不提供找回：没有客服、没有后门、没有服务端 escrow。**这是产品承诺，不是缺陷。**

---

## 6. 认证与会话

### 6.1 表（明文元数据，服务端可见）

| 表                   | 关键列                                                                                                                                                                  | 落地阶段 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `users`              | `id`, `email`(唯一，写入前 normalize), `email_verified_at`, `status`, `created_at`, `dek_wrapped_kek`, `dek_wrapped_recovery`, `kdf_salt_a`, `kdf_salt_b`, `kdf_params` | v0.2 ✅  |
| `credentials`        | `user_id`, `password_hash`(Argon2id PHC 串), `totp_secret_ct`, `totp_enabled`                                                                                           | v0.2 ✅  |
| `sessions`           | `id`, `user_id`, `token_hash`(SHA-256), `device_label`, `created_at`, `last_seen`, `expires_at`, `revoked_at`                                                           | v0.2 ✅  |
| `invite_codes`       | `code_hash`, `created_by`, `used_by`, `expires_at`, `used_at`                                                                                                           | v0.2 ✅  |
| `records`            | `(user_id, id)` 复合主键, `kind`, `taken_at`, `rev`, `iv`, `ct`, `device_id`, `updated_at`（= §4.3 信封）                                                               | v0.2 ✅  |
| `storage_kv`         | `key`, `value`, `expires_at`（VPS 上兵位 KV 的替身，§13）                                                                                                               | v0.2 ✅  |
| `oidc_links`         | `user_id`, `issuer`, `subject`, `email_hint`                                                                                                                            | v0.3+    |
| `passkeys`           | `user_id`, `credential_id`, `public_key`, `sign_count`, `prf_capable`                                                                                                   | v0.3+    |
| `reminders`          | `user_id`, `next_fire_at`, `payload_ct`（提醒内容也加密）                                                                                                               | v0.4     |
| `push_subscriptions` | `user_id`, `endpoint`, `p256dh`, `auth`                                                                                                                                 | v0.4     |

几条不属于表的约束：

- **`users.email` 必须归一化后再存**（`normalizeEmail`：trim + 小写）。不改的话，`Aki@x.com`
  能注册成一个新账号，而密码重置邮件会发到那个地址——技术上 RFC 允许 local part 区分大小写，
  但泄露的是真实用户的数据。
- **`status = 'incomplete'`** 是 §6.3 第 4 步之前的合法状态：能完成注册或注销，不能写任何记录。
  “`dek_wrapped_*` 为空”这个判断散在每个接口里就会有人忘掉一处，写成一列可查。
- **`records` 的 `updated_at` 用服务端时钟**，客户端时间只活在密文里；否则一个时钟偏到 2030 年的设备
  就能把它自己排在游标末尾永远同步不到。
- **不建 `text_pattern_ops` 之类的花式索引**：游标只有一种形状 `(user_id, updated_at, id)`，
  一个索引对它负责到底（`EXPLAIN QUERY PLAN` 有测试盯着）。

### 6.2 会话

- **session 存 D1，不存 KV。** 理由：KV 最终一致最长 ~60 秒，用它存会话等于"登出后 token 还能用一分钟"。
- token = 32B 随机，Cookie `HttpOnly; Secure; SameSite=Lax`；D1 只存 `SHA-256(token)`。
- 撤销即时生效；提供"设备列表 → 踢下线"。
- KV 只承担：限流计数、WebAuthn challenge（短 TTL）、分享快照缓存。

### 6.3 注册流程（顺序不可变）

1. 邮箱 → 发验证码 → 验证（无邮件服务时用邀请码旁路）
2. 设置安全密码（强度检查，UI 明示"忘记即永久丢失"）
3. **生成 + 抄写 + 复述恢复短语**（24 词，三选一验证）
4. 客户端生成 DEK，包裹两份（KEK / 恢复短语 KEK），上传包裹对象
5. 创建 session

> 第 4 步之前没有任何数据可写：`dek_wrapped_*` 为空的账号状态是 `incomplete`，只能完成注册或注销。

### 6.4 存储层接缝（`packages/db/src/store/`）

业务代码（auth / sync / share）只认 `ServerStore` 这个接口，不认 D1 / better-sqlite3 / pg。
理由不是“将来可能换数据库”，而是一个具体的坑：**D1 没有交互事务**，单语句 ≤100 个绑定参数。
直接用 `db` 写“先查再改”的代码会在 SQLite 上全绿、在 D1 上偶发丢写，而这类 bug 只在生产出现。

- **一条 SQL 路径，两个方言**：`openServerStore({ exec, dialect })`。不写两份实现——两份实现里
  “哪个更快”会比一致性更早被优化掉。SQL 只用两边共有的子集：`ON CONFLICT`、`RETURNING`、`IS NULL`。
- **需要原子性的动作都收成一条语句**：`consumeInviteCode` 是一条 `UPDATE ... WHERE used_at IS NULL ... RETURNING`，
  两个并发请求里只有一个能拿到行；写成“查 → 判断 → 写”就是邀请码被用两次。CAS 推送同理（§7.2）。
- **方言差异只有两处**，都在 `sql.ts` 顶部写明：① 布尔：SQLite 只有 0/1，PG 是真 `boolean`；
  ② PG 驱动把 `bigint` 读成**字符串**，所以每个 mapper 都过 `num()`——漏一处就会变成 `'1790…' + 1`。
- **`openServerStore` 是 async 的**，因为 SQLite 的外键级联默认关闭，必须先在这条连接上
  `PRAGMA foreign_keys = ON`。不加的话“删账号即硬删密文”会留下孤儿行，而删除测试在 PG 上却是绿的。
- **执行器按能力探测**（`execute` 或 `all`）**并按形状归一化**（数组 / `{rows}` / `{results}`）：
  sqlite 系的 drizzle 实例没有 `execute()`，`bun:sqlite` 的 `all()` 还是同步返回的。
  认不出的形状**抛错**——静默返回空数组会让所有写操作都“成功”。
- **KV 的 TTL 由读取方判断**：`kvGet` 遇到过期即删并返回 `null`；另有 `kvSweep` 供定时清理。
  没有 KV 的原生 TTL 时，读取就是唯一的清扫时机。

测试是同一套断言跑在 `bun:sqlite` 与 PGlite（真 PostgreSQL 编译成 wasm）上，每个用例两个方言各跑一遍（§14.1）。

---

## 7. 同步协议

### 7.1 拉取

```
GET /api/sync?since=<cursor>&limit=200
→ { items: Envelope[], nextCursor: string | null, serverTime: number }
```

- `cursor` = `base64(<updatedAt>:<id>)` 复合游标。**必须带 id**：批量导入常让上千条落在同一 `updatedAt`，纯时间戳游标会整页跳过（Kira 踩过这个坑）。
- 首次同步 `since` 省略 = 全量分页。

### 7.2 推送（CAS）

```
POST /api/sync
{ items: [{ id, kind, takenAt, rev, baseRev, deviceId, iv, ct }] }
→ { accepted: string[], conflicts: [{ id, rev, iv, ct }], rejected: [{ id, reason }] }
```

规则：

1. `baseRev === 当前 rev` 才写（新记录 `baseRev = 0`），否则进 `conflicts` 并**返回当前密文**。
2. 单批 ≤ **20 条**（D1 batch 原子但每条语句最多 100 个绑定参数，20 条 × ~8 参数留足余量）。
3. 幂等：同一 `(id, baseRev)` 重试安全。
4. 解不开的密文一律 `rejected`，**不落库**（落库会让分享/MCP 读到垃圾）。

### 7.3 冲突解决（客户端）

1. 客户端解不开对面密文就**无法合并内容** —— 所以冲突返回的是密文，由本机用 DEK 解开后合并。
2. 同 id 两版本合并：按密文内的 `clientUpdatedAt` 取新；相等则 `deviceId` 字典序大者胜（确定性 tiebreak）。
3. 合并结果 `rev + 1` 重试，最多 3 轮；仍冲突则落"待人工确认"列表（UI 展示两条记录让用户选）。
4. **内容相等判定必须与合并引擎共用同一个 `contentFingerprint(kind, payload)`**：按 kind 列举参与比较的字段、排除 `clientUpdatedAt` 等记账字段。若用整条 `JSON.stringify` 比较，`createdAt` 差异会导致"永远重推、永不收敛"（Kira 真出过这事故）。

### 7.4 删除

tombstone 是普通记录（`kind='tombstone'`），走同一条 CAS 路径。推送方在墓碑存在期间不得重推目标记录；接收方合并时"墓碑优先"。

---

## 8. 导入 / 导出

### 8.1 兼容矩阵

| 优先级 | 来源        | 格式                                  | 夹具来源           |
| ------ | ----------- | ------------------------------------- | ------------------ |
| **P0** | Transmtf    | 明文 / 密码加密 JSON                  | 自建（可复现）     |
| **P0** | Kira HRT    | `format:"kira-hrt"`、`meta.version:3` | 自建（可复现）     |
| **P1** | Featherline | `.hrtbackup`（加密）                  | **需真实脱敏样本** |
| **P1** | Oyama 派生  | Oyama 备份 JSON                       | 需样本             |
| **P2** | 通用 CSV    | 表头映射                              | 自建               |

P1 的空缺是**已知缺口**，不是遗漏：没有真实样本就无法测出边界（`docs/ROADMAP.md` 里列为外部依赖）。

### 8.2 导出

| 格式                      | 内容                                | 风险控制                                                   |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `kira-hrt`（明文）        | 记录 + 化验 + 体重                  | 导出前**强制二次确认**，文案写明"生成未加密的健康数据文件" |
| `hrt-tracker.bak`（加密） | 全量记录 + `dek_wrapped_*` + 元数据 | 需输入安全密码或恢复短语；用于换设备/灾备                  |

### 8.3 字段映射要点

- `timeH` ↔ `takenAt`：`takenAt = Math.round(timeH * 3600_000)`；导入后立刻用回写校验（往返误差 ≤ 1ms）。
- `ester` ↔ `compound`：直接映射；未知值按 Kira 规则降级（`ester` → `E2`，未知 `route` → 该行跳过并计入 `skipped[]`）。
- `doseMG`：语义见 §4.2，导入必须换算。
- 化验：缺 `analyte` 的旧备份 → `unknown`（不按单位猜）；一次性映射选项只在导入预览层提供，默认不开启。

### 8.4 夹具与金标准测试

`packages/protocol/fixtures/<source>/<case>.{json,expected.json}`，每个夹具断言的是**规范化后的记录数组**（排序稳定、字段全量）。

必须覆盖：

1. 往返：`import(kira-hrt) → export(kira-hrt)` 的 `doseMG` 逐条等值。
2. 跳过：未知 `route` 行被跳过且计入报告，不静默丢弃。
3. 化验：`unknown` 不进拟合、监测项单独成条、空记录被丢弃。
4. 时间：跨夏令时的本地时间显示正确。
5. 剂量：EV 2mg 与 E2 2mg 的 `doseEquivMG` 不同，且 PK 曲线不同。

### 8.5 v0.1 的导入 / 导出界面契约（已实现）

实现在 `apps/web/shared/pk/backup.ts`（纯函数）+ `apps/web/app/pages/backup.vue`（界面），
同目录 `backup.test.ts` 覆盖判定与映射。

- **判格式靠标记，不靠猜字段。** `format:"kira-hrt"` 或数字型 `meta.version` → Kira；其余 → Transmtf。
  判不准时 `certain: false`，界面写「不确定」并允许手选；选错也不会静默改数据（字段同源，换个壳照样能读）。
- **写入保留原 id。** 同一份备份重复导入是**覆盖**，不是追加（已实测：连导两次仍是 5 条给药）。
  这条依赖“导入的 id 就是来源的 id”，所以导入器绝不能重新生成 id。
- **未建模的顶层字段进 `preserved`，不静默丢弃。** 报告里列出键名，用户自己判断要不要另存。
- **一条坏行不拖垮整个文件。** 未知 `route` 进 `skipped[{index, reason}]`，其余照常导入。
- **导出原值，不导出当量。** 往返后 `doseMG` 逐条等值；当量是派生量，写进文件只会在别的工具里被当成质量读。
- **明文导出必须显式勾选。** 按钮默认 `disabled`，勾选文案写「我知道这是明文」；文件名带格式与日期。

---

## 9. PK 引擎

### 9.1 两份真源，一份 catalog

| 引擎       | 参数来源                                                                        | 覆盖（v0.1 实际）                   |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| `builtin`  | HRT-Recorder 的 `PKSharedCatalog.json`（算法/参数按规格实现，**不搬实现代码**） | E2 + T + 抗雄（抗雄只记录不进曲线） |
| `transmtf` | Transmtf-HRT-Tracker（MIT）的 `pk.ts` 参数与扩展（`catalog.transmtf.json`）     | **仅 E2 五途径**；抗雄与 EU 留 v0.3 |

两者都归一到同一份 catalog 结构（`hormone` / `compound` / `route` 三级），差异用字段表达而非分支代码。
两个引擎共用一个数值内核 `solver.ts`（一阶隔室 + 离散事件 + 通量窗口的 RK4），所以线性系统的
恒等关系（AUC = 总量/清除率、叠加、步长收敛）只需验证一次。`simulate()` 按 `engine` 字段分派，
默认 `builtin`（它是唯一同时支持两种激素的引擎）。

### 9.1.1 `builtin` 的结构（已实现）

一室分布容积 + **线性储库链**。所有隔室只有一种行为（一阶流失 + 流入下一个），所以整条系统线性时不变：

```
注射：depot(快) ┐
       depot(慢)┴─▶ 血浆酯 ──k2──▶ 活性池(注射) ──kClearInjection──▶ 清除
口服：肠道 ──kAbs──▶ 活性池(非注射) ──kClear──▶ 清除
凝胶：闭式通量 A0·Fmax·k1·e^(-k1t) ─▶ 活性池(非注射)
贴片：恒速通量 rate·[apply, remove) ─▶ 活性池(非注射)
```

确定性结论全部写成断言（`packages/pk-core/test/engine.test.ts`）：

- **解析解对齐**：单链三隔室有闭式解，逐点比对相对误差 < 1e-6。
- **AUC 恒等式**：`AUC = F × doseEquiv / (Vd × kClear*)`，不靠实现自证。
- **线性叠加 / 步长收敛 / 剂量翻倍 / 体重反比**：任一条被破坏都说明模型被写脏。
- **数量级哨兵**：`1e9` 与 `1e8` 写错会立刻被抓到。

途径差异只体现在「初始质量乘哪个系数」和「进哪个活性池」，不产生任何分支数值逻辑。

**两条表观清除率的用法**（ADR 31）：注射走 `kClearInjection`（E2 0.041 / T 0.03），其余途径走 `kClear`（0.41 / 0.6），唯一例外是十一酸雌二醇 EU（长效靠吸收而非清除）。这不是我们的推断：Transmtf 的 `resolveParams` 写的就是 `route === injection && ester !== EU ? kClearInjection : kClear`，两个上游共用同一组 CorePK 常量（`vdPerKG 2.0` / `kClear 0.41` / `kClearInjection 0.041` / `depotK1Corr 1.0`，与本 catalog 逐字相同）。分池用之后 E2 与 T 的注射曲线同时落进已发表区间（EV 5mg → Cmax≈385 pg/mL @54h、AUC≈4.7×10⁴；TC 100mg/周 → 周均≈670 ng/dL），只用 `kClear` 则低 10–20 倍。

### 9.1.2 `transmtf` 的结构（已实现）

同一内核，差异全在参数与一级隔室：

```
注射：depot(快/慢) ─▶ 血浆酯 ──k2──▶ 活性池(注射) ──kClearInjection──▶ 清除
口服：肠道 ──kAbs──▶ (EV 追加一级血浆水解) ──▶ 活性池 ──kClear──▶ 清除
凝胶：表面 ──(kPen+kLoss)──▶ 皮肤储库 ──kRel──▶ 活性池 ──kClear──▶ 清除
贴片：恒速通量 ─▶ 活性池；无标称速率时降为 k1=0.0075 的指数释放储库
```

与 `builtin` 的**真正差异只有两处**，其余是同一组常数（`vdPerKG 2.0` / `kClear 0.41` / `kClearInjection 0.041`）：

1. **凝胶**：吸收分数从常数 `Fmax`（E2 0.06）换成 `kPen/(kPen+kLoss)`（Oestrogel ≈ 0.10），
   并多出「溶剂变干 → 皮肤储库缓释」的延迟。同一 1.5mg 剂量 AUC 相差 ≈1.67 倍、峰值更晚——
   这正是双曲线叠加要展示的东西，测试里也是被断言的关系，而不是巧合。
2. **贴片 fallback**：`builtin` 是恒速通量，`transmtf` 是指数释放储库。形状不同，同样被断言。

三室级联落进同一个求解器的方式：表面有两条平行出口（渗透 `kPen`、损失 `kLoss`），而隔室只有
一个出口，于是在剂量时刻把损失那份直接扣掉，投入 `M0·kPen/(kPen+kLoss)`、表面流失率取
`kPen+kLoss`。进入皮肤的瞬时通量 `M0·kPen·e^{-(kPen+kLoss)t}` 与上游逐字相同，**这是同一个线性
方程组的等价改写，不是近似**——测试用上游方程的部分分式解作外部预言机，逐点相对误差 < 1e-6
（含洗掉之后的分段解）。

洗掉（`washAfterH`）把表面剩余质量清零，是求解器的 `clear` 事件，精确施加在事件时刻。暴露
保留率因此是已渗透量 `1−e^{-(kPen+kLoss)·wash}`（1h → ≈0.75），与 EstroGel −22% / Divigel −30%
的标签方向一致。涂抹部位、面积、叠加外用品都只是乘在初始质量上的系数：生殖器部位的 AUC 比约
4.7 倍（不是 8 倍，因为吸收分数本身有上限），润肤霜 +38%、防晒霜 −16%、未知外用品中性 1.0。

### 9.2 切换与对比

- **全局设置**切换引擎（每条记录不单独选）。
- 图表支持**双曲线叠加对比**：同一份输入跑两次 simulate，画在同一坐标系。这是产品最好的说明书。
- 男性化模式（含睾酮）强制 `builtin`；`transmtf` 在该模式下置灰并给出一句话原因。
- 主图只有雌二醇 / 睾酮两条 y 轴（各自单一单位）。抗雄要等 v0.3 的独立小图（CPA ng/mL、
  比卡鲁胺 µg/mL），因为它们的单位与量级跟激素不同，不往主图里塞。

### 9.3 校准（v0.3：只做 MAP）

- 输入：可信的**给药前** E2 化验（`analyte='E2'`，且距上次给药 ≥ 该途径的阈值）。
- 背景 E2 = 可信给药前样本的中位数；**无此类样本则背景为 0，不得凭空假定**。
- 拟合时扣除背景、输出时加回一次。
- 输出必须带**可信区间**与"哪些化验参与了拟合"的清单。`unknown` 化验不参与。
- EKF / OU-Kalman 在 v1.0 作为可选估计器（`docs/ROADMAP.md`）。

### 9.4 Worker 协议

```ts
// 请求
{ id: string, type: 'simulate', engine: 'builtin'|'transmtf', doses: Dose[], range: [number, number], stepMin: number, pkParams: PkParams }
// 响应
{ id, type: 'result', engine, unit: 'pg/ml'|'ng/dl', series: { t: Float64Array, conc: Float64Array }, auc, peak: { conc, tMS }, warnings: string[] } | { id, type: 'error', message: string }
```

主线程**不做任何** PK 计算。曲线点数按 `stepMin` 与视图宽度裁剪，缩放时只重算可见窗口。

协议层三条硬约束（都有对应测试）：

1. **Worker 消息是不可信输入。** `parsePkWorkerRequest` 逐字段校验形状，不合法就抛错，绝不 `as` 进引擎。
2. **一个请求不叫“最新”。** 双引擎对比天然是两个并发请求，拿一个全局序号去判过期会把先回来的那条吞掉（builtin 就这样整条消失过）。过期判定属于**页面**：只有它知道这次请求对应哪一次选择（`pages/index.vue` 的 `generation`）。
3. **图表只负责画。** 曲线集合（条数与颜色）变化才重建 uPlot 实例；同一集合的数据更新用 `setData(data, true)`（`true` = 重算 y 范围）。传 `false` 会沿用上一次的纵向尺度，贴片曲线就被画进注射量级的坐标系里，看着像一条贴着底边的直线。

### 9.5 区间与采样（页面责任）

引擎不知道也不该知道“用户在界面上想看哪段”，但它有两个硬性假设：

1. **起算点之前的给药会被堆到 t=0。** `solver` 在积分前调 `applySchedulesUpTo(0)`，所有 `atH ≤ 0` 的给药一次性加到初始状态，**不衰减**。
   所以区间起点必须落在**第一条记录之前**（`pages/index.vue` 用 `doses[0].takenAt`）。
   不能为了“只看最近一个月”把起点往后挠——那会把一个月前的注射变成一个虚假的 hp 峰值。
2. **峰值是采样点上的最大值。** `finalize` 在 `series.conc` 上取 max，不插值。步长放粗就会低估值，界面必须把步长写出来。

因此真实记录的区间 = 「第一条 → 最后一条 +7 天」，步长由区间长度反推：`stepMin = max(30, ceil(spanMin/4000/5)*5)`，
点数封顶 ~4000。一条 354 天的记录集算出来是 130 分钟——能看，但界面会多一行「步长已自动放粗，峰值可能略偏低」。

预期的正解是**热身段**（从第一条记录开始算，只渲染窗口）：那需要改引擎接口，不在 v0.1 范围内，已记入 §18。

---

## 10. 分享快照

1. 用户设分享密码 → Argon2id → `shareKey`。
2. 客户端生成**临时快照密钥**，用它加密"渲染所需的最小数据集"（曲线点 + 期间用药摘要，**不含备注与化验明细**，除非用户显式勾选）。
3. KV 存 `{ ct, iv, ttl, createdAt }`，TTL 只能是 **7 天 / 30 天**。
4. 无密码只读链接：**默认关闭**；开启时 TTL 上限 **24 小时**，UI 明写"任何拿到链接的人都能看到这些记录"。
5. 撤销 = 删 KV 条目（立即失效）；分享与主库密钥隔离，泄露分享密码不威胁主数据。

---

## 11. 提醒与推送

### 11.1 分两级

| 阶段 | 机制                                                   | 说明                           |
| ---- | ------------------------------------------------------ | ------------------------------ |
| v0.3 | 本地通知（Service Worker 排程 + 打开应用时校准）       | 无服务端依赖，安卓 Chrome 可靠 |
| v1.0 | Web Push（VAPID）+ Workers Cron（**最小粒度 1 分钟**） | 免费套餐每次触发算一次请求     |

### 11.2 调度

- `reminders.next_fire_at` 建索引 `(next_fire_at)`；Cron 每分钟取 `next_fire_at <= now` 的行，推送后重算下一次。
- 幂等：每条提醒带 `fire_id`，推送前用 KV 做 90 秒去重窗口（Cron 重试/多实例安全）。
- **iOS 现实**：Web Push 需 iOS 16.4+ **且已"添加到主屏幕"**，UI 必须探测并给出说明，不能承诺"一定会响"。

### 11.3 服务端零诊断的替代方案

- 客户端埋点：`{ version, errorCode, ciphertextBytes, itemCount }`，**无内容、无 id 列表**。
- "导出调试包"按钮：用户本地生成一份包含版本/错误/长度的 JSON，**由用户自己决定发给谁**。

---

## 12. MCP（v1.0）

服务端无明文 → MCP **不能**做成服务端读库。

形态：**客户端代理**。本地/浏览器内运行一个 MCP 服务端，通过同一套 `packages/protocol` + `pk-core` 读写本地库；云端只作为同步目标。

- 若要"远程用 AI 助手读记录"，唯一合法路径是用户显式提供一次性解锁材料（短会话 + 明确授权 UI），**不做长期托管**。
- MCP 的工具集与 REST 语义一致（list/add/edit/delete dose、lab、weight、pkParams），不新增能力。

---

## 13. 双部署

| 能力         | Cloudflare Workers                                                       | VPS（默认）                                   |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------- |
| Nitro preset | `cloudflare_module`                                                      | `node-server`                                 |
| SQL          | D1（**无交互事务**、单语句 ≤100 参数、batch 原子）                       | SQLite（`better-sqlite3`，真事务）            |
| 备选 SQL     | —                                                                        | PostgreSQL（`node-postgres`，`DATABASE_URL`） |
| KV           | KV（最终一致 ≤60s）                                                      | `storage_kv` 表（强一致）或 Redis（可选）     |
| 定时         | Cron Triggers（≥1min）                                                   | systemd timer / `node-cron`                   |
| 静态资源     | Workers Assets                                                           | 反代静态目录                                  |
| 密钥         | `wrangler secret put`                                                    | `.env`（`0600`）或 systemd `EnvironmentFile`  |
| 迁移         | `drizzle-kit generate --dialect sqlite` → `wrangler d1 migrations apply` | 同一份 sqlite 迁移；pg 单独一套               |

**迁移的来源只有一个**：`packages/db/migrations/sqlite`。D1 的 `migrations_dir` 直接指向它，
VPS 的 SQLite 也用它（`drizzle-kit migrate`）。两份手抄的 DDL 必然漂，而 DDL 漂到了生产才发现。
PG 单独一套（`migrations/pg`），逻辑形状由 `test/schema-parity.test.ts` 强制与 sqlite 一致。

**设计约束（因 D1 反推）**：

1. 所有多写操作必须是**幂等单批**，禁止依赖"读-改-写"事务。
2. 主键在**客户端生成**（UUIDv7），因为 batch 内读不到前一条语句的结果。
3. 不使用 PG 独有类型（`jsonb` 索引用不上）；JSON 一律 `text`。

**方言差异清单**（必须在 CI 双跑验证）：`LIMIT/OFFSET` 语义、`ON CONFLICT` 写法、`RETURNING` 支持、大小写与 `COLLATE`、布尔存储。

CI 里不靠 service 容器验 PG：`unit` job 用 **PGlite**（真 PostgreSQL 编译成 wasm）把同一批 `.sql` 灌进去，
和 `bun:sqlite` 平行地跑**同一套断言**（`packages/db/test/store.test.ts` 里每个用例两个方言各一遍）。
加一个 `postgres` service 会让本地和 CI 跑的东西不一样。

`lint` job 还会重新 `drizzle-kit generate` 并 `git diff --exit-code`：改了 schema 忘生成迁移比迁移写错更
隐蔽——本地全绿，部署时才发现少一列。

两条目标的构建、启动、上线命令与坑写在 `deploy/README.md`（含 `deploy/systemd/hrt-tracker.service` 样例与
`deploy/smoke.sh` 蹦烟脚本）。设计文档不再重复一份可能过期的命令。

---

## 14. 测试与 CI

### 14.1 矩阵

| job          | 内容                                                             | 目标    | 状态                                         |
| ------------ | ---------------------------------------------------------------- | ------- | -------------------------------------------- |
| `lint`       | `biome ci` + `bun run typecheck`（三个包各一次）                 | 全部    | ✅ v0.1（i18n 键对称等 v0.2 接入 i18n 后加） |
| `unit`       | `bun test`                                                       | 全部    | ✅ v0.1                                      |
| `node`       | `build:node` + 起服务 + `deploy/smoke.sh 3210`                   | VPS     | ✅ v0.1（Playwright E2E 待 v0.2 有账号后）   |
| `cf-local`   | `build:cf` + `wrangler dev`（miniflare）+ `deploy/smoke.sh 3212` | Workers | ✅ v0.1                                      |
| `cf-preview` | 部署临时 preview + 5 条 smoke（登录/写一条/读回/导出/删除）      | Workers | v0.2（要账号与 secrets）                     |

两条目标的蹦烟是**同一个脚本**（`deploy/smoke.sh`），断言的也是同一份东西：health JSON + 三个页面 200。
分开写两套 grep 就会出现“本地绿、CI 绿、线上红”这种最难查的差异。

**密码学断言必须对上游参考实现逐字节对照**，禁止自己跟自己比：
Argon2id → libargon2 的 `argon2id_hash_raw`；XChaCha20-Poly1305 → libsodium 的
`crypto_aead_xchacha20poly1305_ietf_encrypt`；恢复短语 → BIP39 官方测试向量（24 词那八组）。
向量值与出处写在各测试文件顶部，夹具在 `packages/crypto/test/fixtures/`。

`node` 与 `cf-local` 必须是**两个独立 job**：它们往同一个 `.output/` 里写，跑在同一台 runner 上会互相覆盖。

**miniflare ≠ 真 D1**：参数上限（100）与 batch 语义不完全等价，所以 `cf-preview` 不可省——它只是推到 v0.2，
因为现在还没有账号、没有 D1 表，也没有东西可以 smoke。

### 14.2 硬门槛

每个里程碑结束时，`node` 与 `cf-preview` **必须同时绿**。任一红 = 里程碑未完成。

### 14.3 提交规范

Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` …），`git-cliff` 生成 CHANGELOG。提交必须签名（SSH），签名密钥：`~/.ssh/akiebb_signing`，作者 `AkiEbb <me@akiebb.dev>`。

---

## 15. i18n

- v0.1：`zh-Hans`（默认）+ `en`；其余语言按社区 PR 增量接入。
- 结构：`apps/web/i18n/locales/<lang>.json`，扁平键；缺失键**回退 `en`**。
- CI 检查：`scripts/check-i18n.mjs` 校验键集合对称 + 无空值 + 无未使用键。
- 医疗相关文案（剂量、单位、告警）改动需**同 PR 更新所有已存在语言**，否则 CI 失败。

---

## 16. 威胁模型

| 攻击者               | 能否读到明文 | 说明                                                      |
| -------------------- | ------------ | --------------------------------------------------------- |
| 拿到 DB dump         | ✗            | 只有 AES-GCM 密文与 Argon2id 包裹对象，无任何可用密钥材料 |
| 拿到 Cloudflare 账号 | ✗            | 无平台密钥可拿；KV/D1 里没有密钥材料                      |
| 服务运营者（本人）   | ✗            | 这是设计目标，不是能力缺失                                |
| 拿到分享链接         | 视设置       | 无密码链接 = 可见；有密码 = 需密码                        |
| 用户设备被控         | ✓            | 内存中的 DEK。不防御，只在 UI 说明                        |
| 用户自己导出明文     | ✓            | `kira-hrt` 导出是明文，这是数据可携带权的代价             |

**日志纪律**：请求日志只记 `{ method, path, status, userId, durationMs, ciphertextBytes }`；永不记录 body、`iv`、`ct`、任何 header 里的 token。

---

## 17. 决定记录（ADR 摘要）

| #   | 决定                                                                    | 备选被否的理由                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 新仓库 `AkiEbb/HRT-Tracker`，Kira 只做维护                              | 就地重写会撕裂现有发布链；monorepo 改造成本吃掉 MVP                                                                                                                                                                                                          |
| 2   | 从上游重写（Transmtf MIT + HRT-Recorder 规格），MIT 许可                | 移植 GPL 会绑定许可；重写换来许可自由                                                                                                                                                                                                                        |
| 3   | 完整平替，但分四阶段垂直切片                                            | 一次性铺开等于第二个两年                                                                                                                                                                                                                                     |
| 4   | Drizzle + drizzle-kit 三方言                                            | 手写方言层维护成本高；Drizzle 换来同一 schema                                                                                                                                                                                                                |
| 5   | MIT                                                                     | AGPL 在此场景杠杆价值低于社区门槛成本                                                                                                                                                                                                                        |
| 6   | 双部署双绿是每阶段硬门槛                                                | 最后再适配 = 存储层推倒重来                                                                                                                                                                                                                                  |
| 7   | 真 E2EE（服务端零密钥副本）                                             | Kira 式"KMS 包裹副本"会让隐私承诺落空                                                                                                                                                                                                                        |
| 8   | 口令 KEK + 恢复短语，OIDC/Passkey 只做认证                              | 服务端 escrow 违背第 1 条铁律                                                                                                                                                                                                                                |
| 9   | 记录级信封 + 记录级 LWW                                                 | 整份快照在 D1 上是灾难；CRDT 对记录型数据无收益                                                                                                                                                                                                              |
| 10  | 导入三档优先级（P0 可自建夹具）                                         | 无法为没有样本的格式写测试                                                                                                                                                                                                                                   |
| 11  | catalog 驱动 + 全局引擎 + 双曲线对比                                    | 每记录选引擎会让校准与缓存乘二                                                                                                                                                                                                                               |
| 12  | session 存 D1                                                           | KV 最终一致使"立即登出"失真                                                                                                                                                                                                                                  |
| 13  | VPS 默认 SQLite                                                         | pg 的运维面是纯负担                                                                                                                                                                                                                                          |
| 14  | `@nuxt/ui` v4                                                           | shadcn-vue 与它同源，二选一即可；v4 已原生适配 Tailwind v4                                                                                                                                                                                                   |
| 15  | 内部 schema 自有 + 边界适配                                             | 直接吃协议会让 `doseMG` 双重语义变成永久隐患                                                                                                                                                                                                                 |
| 16  | 只做 PWA                                                                | 壳会带来两套通知/密钥存储/导入                                                                                                                                                                                                                               |
| 17  | 客户端合并 + 服务端 CAS                                                 | 服务端 LWW 在 E2EE 下是自欺                                                                                                                                                                                                                                  |
| 18  | 提醒两级推进                                                            | 无 Cron 的免费方案撑不住每日漏服提醒                                                                                                                                                                                                                         |
| 19  | **砍掉 OCR**                                                            | 与 E2EE 无关的纯成本项，手工录入够用                                                                                                                                                                                                                         |
| 20  | 代码库中性名，品牌配置化                                                | 提前定品牌消耗一轮决策；去品牌化对受众有真实价值                                                                                                                                                                                                             |
| 21  | 校准先只做 MAP                                                          | 估计器数量不决定信任，表达质量才决定                                                                                                                                                                                                                         |
| 22  | 分享默认安全侧                                                          | 无密码链接必须显式开启且 24h 过期                                                                                                                                                                                                                            |
| 23  | i18n 先中英                                                             | 质量差的多语言是医疗文案风险                                                                                                                                                                                                                                 |
| 24  | CI 三段式（unit / node / cf-preview）                                   | miniflare 与真 D1 不等价                                                                                                                                                                                                                                     |
| 25  | 导出双格式 + 账号删除即硬删                                             | 软删与"已经删了"的承诺冲突                                                                                                                                                                                                                                   |
| 26  | SSH 签名 + AkiEbb 身份                                                  | 卡片 GPG 密钥绑的是 RhenCloud 身份，签不出 Verified                                                                                                                                                                                                          |
| 27  | 信任边界五条铁律写进文档                                                | 只活在对白里的约束等于没有约束                                                                                                                                                                                                                               |
| 28  | 两份文档（DESIGN + ROADMAP）                                            | 文档越多越没人读                                                                                                                                                                                                                                             |
| 29  | 抗雄当量恒为 0                                                          | 用自身毫克数冒充当量会污染曲线与导出                                                                                                                                                                                                                         |
| 30  | 体重按事件存（`weightKG`），标量只做回落                                | 上游两种工具都是这个模型；全局体重会让历史曲线随修改而漂移                                                                                                                                                                                                   |
| 31  | 注射用 `kClearInjection`，其余用 `kClear`（两池），EU 例外              | 上游明示规则（`ester !== EU ? kClearInjection : kClear`）；同池混用时 E2 与 T 无法同时对上实测                                                                                                                                                               |
| 32  | 引擎只读 `doseEquivMG`，`doseMG` 连参数都不传                           | 少一个能出错的入口，比多一层"记得别用"的自觉可靠                                                                                                                                                                                                             |
| 33  | 两个引擎共用一个数值内核，引擎只提供参数与隔室拓扑                      | 线性系统的恒等关系只需验证一次；引擎差异变成可测的“相差多少倍”而不是两个黑盒                                                                                                                                                                                 |
| 34  | `transmtf` 的凝胶三室级联把损失份额在剂量时刻扣掉                       | 与上游并行出口方程严格等价（逐点 < 1e-6），不需要给隔室加第二个出口，也就不需要新的数值路径                                                                                                                                                                  |
| 35  | v0.1 的 `transmtf` 只做 E2 五途径，抗雄/EU 留 v0.3                      | 抗雄曲线在 v0.1 图表里没有位置（独立小图到 v0.3），先换不来用户可见价值                                                                                                                                                                                      |
| 36  | 记录 AEAD 用 **XChaCha20-Poly1305**，不用 AES-256-GCM                   | AES-GCM 只有 96-bit nonce（12 字节），用纯随机能用的样本太少，只能上计数器/去重纪律；而多标签页 + 离线队列恰恰没有全局计数器。XChaCha 的 24 字节随机 nonce 把“复用”变成概率上不可能。代价是放弃 WebCrypto 硬件加速（桌面端几 MB/s 的差别，记录只有几百字节） |
| 37  | Argon2id 用 `hash-wasm`（参考实现的 wasm 编译），参数单位写进字段名     | 64 MiB / 3 轮的纯 JS 实现在手机上慢到用户以为卡死；wasm 与 libargon2 逐字节一致（有向量测试）。`memorySizeKiB` 而不是 `memorySize`，因为“64 当成 MB 写”会把强度默默降到 1/1024                                                                               |
| 38  | 恢复短语用 **BIP39 英文 24 词**                                         | 校验和能让“抄错一个词”当场报错，而不是三个月后“恢复失败”；2048 词表与其他工具互认，用户手上已有的那份 BIP39 备份也能用；短语只包 DEK，不做登录凭据                                                                                                           |
| 39  | AAD 用长度前缀 + `kind` 禁含 `\|`                                       | id 是客户端生成、还能来自导入文件的自由字符串，裸 `\|` 拼接下 `id="ab",kind="dose"` 与 `id="a",kind="b\|dose"` 会撞；包裹两段再加域分隔 AAD，防止“恢复包”被搬到“口令包”列                                                                                    |
| 40  | 存储层是一个**窄接口**（`ServerStore`），不是一个 drizzle 句柄          | 业务代码直接拿 `db` 写“读-改-写”，在 SQLite 上绿、在 D1（无交互事务）上偶发丢写；把需要原子性的动作各自收成一条语句，才能把“并发下只成功一次”写进测试                                                                                                        |
| 41  | 一份 SQL 实现 + 两个方言，而不是两份实现                                | 两份实现里“哪个更快”会比一致性更早被优化掉；差异只剩布尔与 bigint-as-string 两处，集中在 mapper，漏一处立刻被双方言测试抓住                                                                                                                                  |
| 42  | 邀请码消费写进 `UPDATE ... WHERE used_at IS NULL ... RETURNING`         | 先查后写等于把“同一个码被两个并发请求用掉”留成上线后的偶然事件；一条语句把检查与使用合并，第二次必然拿到 0 行                                                                                                                                                |
| 43  | `pullRecords` 的游标是 `(updated_at, id)` 复合比较，不是 `updated_at >` | 批量导入会让上千条共用同一个 `updated_at`，纯时间戳游标会整页跳过；SQL 里必须写成 `updated_at > ? OR (updated_at = ? AND id > ?)`                                                                                                                            |

---

## 18. 待定 / 已知缺口

| 项                               | 状态         | 触发条件                                                                                     |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| Featherline / Oyama 夹具         | **缺样本**   | 拿到脱敏样本后补 P1                                                                          |
| Passkey PRF 支持矩阵             | 未实测       | v1.0 前用真机验证 Chromium/Safari/Firefox                                                    |
| Nitro 打包 workspace TS 包的摩擦 | ✅ 已验证    | `nitro.externals.inline` + `vite.ssr.noExternal`，node 与 workerd 双实测绿                   |
| 通知在 iOS PWA 的实际可靠性      | 未实测       | v0.3                                                                                         |
| 睾酮在 Transmtf 引擎下的缺失     | 已知         | 男性化模式强制 builtin；`transmtf` 在睾酮请求上直接抛错而非静默给空曲线                      |
| `transmtf` 的抗雄与 EU 未实现    | 已知（v0.3） | CPA 二室 / 比卡鲁胺单室 / EU 长效 depot 参数已记在 `catalog.transmtf.json._gaps`，不凭空实现 |
| `transmtf` 凝胶参数的证据强度    | 上游先验     | `kPen/kLoss/kRel` 与部位因子（生殖器 8×）是上游的人群先验，不是 IVPT 标定值                  |
| `kClearInjection` 是表观拟合值   | 上游明示     | 同一分子不存在两条清除率，但两个上游都按途径区分；EU 走 `kClear`                             |
| EU（十一酸雌二醇）不在 catalog   | 已知         | `builtin` 目录无 EU，导入这类记录进 `preserved` 而不画曲线；待补参数                         |
| TU 长效 depot 峰值偏高           | **已知偏差** | 十一酸睾酮 1000mg 峰值约 2760 ng/dL，实测约 400–600；两段释放表达不了蓖麻油 depot 的平坦轮廓 |
| 逐事件体重不参与 Vd              | 已知         | v0.1 用全局体重算分布容积，事件体重只触发提示；逐事件 Vd 会让同剂量的曲线随改体重跳变        |
| 没有热身段（warm-up）            | 已知（v0.2） | 看一段窗口就必须从第一条记录算起（§9.5）；真要“只看最近 30 天”，需要引擎先算热身段再裁切输出 |
| 真实记录跨度大时峰值被低估       | 已知         | 步长上限拉到 130+ 分钟，峰值只取采样点上的最大；界面会写出来，但不等于就准                   |
