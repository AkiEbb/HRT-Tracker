export * as pgSchema from './schema.pg'
export * as sqliteSchema from './schema.sqlite'

export type UserRow = typeof import('./schema.sqlite').users.$inferSelect
export type RecordRow = typeof import('./schema.sqlite').records.$inferSelect
export type SessionRow = typeof import('./schema.sqlite').sessions.$inferSelect
export type CredentialRow = typeof import('./schema.sqlite').credentials.$inferSelect

/**
 * 邮箱规范化。**只做一次，在写入和查询之前**：注册时存 `normalizeEmail(input)`，
 * 登录时也查 `normalizeEmail(input)`。
 *
 * 大小写不敏感是刻意的：`a@x.com` 与 `A@x.com` 在几乎所有邮件服务商那里是同一个邮箱。
 * 如果按原样存，攻击者可以用 `Aki@x.com` 注册一个"新账号"，然后靠收件箱里的
 * 密码重置/邀请把原账号的邮件抢走。技术上 RFC 允许 local part 区分大小写，
 * 但那是理论，泄露的是真实用户的数据。
 *
 * 不做 Unicode 归一化：邮箱里出现全角字符本就该在更早的校验里被拒绝。
 */
/**
 * 邮箱规范化。**只做一次，在写入和查询之前**：注册时存 `normalizeEmail(input)`，
 * 登录时也查 `normalizeEmail(input)`。
 *
 * 大小写不敏感是刻意的：`a@x.com` 与 `A@x.com` 在几乎所有邮件服务商那里是同一个邮箱。
 * 如果按原样存，攻击者可以用 `Aki@x.com` 注册一个"新账号"，然后靠收件箱里的
 * 密码重置/邀请把原账号的邮件抢走。技术上 RFC 允许 local part 区分大小写，
 * 但那是理论，泄露的是真实用户的数据。
 *
 * 不做 Unicode 归一化：邮箱里出现全角字符本就该在更早的校验里被拒绍。
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
