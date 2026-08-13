#!/bin/sh
set -e

# Executed automatically by the official nginx image entrypoint through /docker-entrypoint.d/*.sh before nginx starts.
# Generate runtime config.js from environment variables. Each analytics provider has an independent variable;
# unset providers remain disabled, load no scripts, and send no external requests. Multiple providers may be enabled together.

# GA4 and Baidu IDs contain only letters, numbers, and hyphens. Remove other characters
# so quotes and similar values cannot break the JavaScript strings in config.js as a defense-in-depth measure.
sanitize_id() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9-'
}

GA4_ID=$(sanitize_id "${ANALYTICS_GA4_ID:-}")
BAIDU_ID=$(sanitize_id "${ANALYTICS_BAIDU_ID:-}")

cat > /usr/share/nginx/html/config.js <<EOF
window.__RUNTIME_CONFIG__ = {
  ANALYTICS_GA4_ID: "${GA4_ID}",
  ANALYTICS_BAIDU_ID: "${BAIDU_ID}"
};
EOF

# Railway / 任意宿主动态端口支持：
# 若设置了 PORT 环境变量（Railway 注入），用 envsubst 把 nginx.conf 模板中的
# ${PORT} 替换为实际端口；否则回退到 3000（本地 Docker 默认）。
export PORT="${PORT:-3000}"
envsubst '${PORT}' \
    < /etc/nginx/conf.d/default.conf \
    > /tmp/nginx-rendered.conf
cp /tmp/nginx-rendered.conf /etc/nginx/conf.d/default.conf
