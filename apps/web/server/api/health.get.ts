import { CATALOG_SOURCE } from '@hrt/pk-core'
import { PROTOCOL_VERSION } from '@hrt/protocol'

/**
 * workspace 包内联的探针：
 * 这个 handler 同时 import 两个 packages/*，是双目标构建（node-server / cloudflare_module）
 * 能否正确打包 TS-only workspace 包的最小验证点。
 */
export default defineEventHandler(() => ({
  ok: true,
  protocol: PROTOCOL_VERSION,
  catalog: CATALOG_SOURCE.name,
}))
