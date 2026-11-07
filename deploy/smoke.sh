#!/usr/bin/env bash
# 两条目标的同一套冒烟：健康 JSON + 三个页面都是 200。
#
# 用法：deploy/smoke.sh <port>
#
# 只做「起没起来、页面打不打得开」这一件事。node-server 与 wrangler dev 都跑它，
# 所以本地验收和 CI 验收断言的是同一份东西，而不是两套各写各的 grep。
set -euo pipefail

port=${1:?用法: deploy/smoke.sh <port>}
base="http://127.0.0.1:${port}"
health=$(mktemp)
trap 'rm -f "$health"' EXIT

# 环境里的 http_proxy 会把 127.0.0.1 也当外网送出去，这里一律直连。
curl_common=(--silent --show-error --max-time 10 --noproxy '*')

ready=0
for _ in $(seq 1 60); do
  if curl "${curl_common[@]}" --fail --output "$health" "${base}/api/health" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "冒烟失败：${base}/api/health 在 60 秒内没有响应" >&2
  exit 1
fi

echo "health: $(cat "$health")"

for path in / /records /backup; do
  code=$(curl "${curl_common[@]}" --output /dev/null --write-out '%{http_code}' "${base}${path}")
  if [ "$code" != "200" ]; then
    echo "冒烟失败：${path} 返回 ${code}" >&2
    exit 1
  fi
  echo "page ${path}: ${code}"
done

echo "冒烟通过：端口 ${port}"
