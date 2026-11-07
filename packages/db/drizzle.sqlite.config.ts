import { defineConfig } from 'drizzle-kit'

/**
 * 一个 schema、两个方言、两套迁移目录。迁移文件进版本库（`migrations/sqlite`、`migrations/pg`），
 * 因为它们就是部署产物——线上跑的是这些 `.sql`，不是这里的 TS。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.sqlite.ts',
  out: './migrations/sqlite',
  strict: true,
  verbose: true,
})
