#!/bin/sh
set -e

# 由 nginx 官方镜像的入口在启动前自动执行（/docker-entrypoint.d/*.sh），随后 nginx 正常拉起。
# 从环境变量生成运行期配置 config.js；每家统计一个独立变量，未设置的留空，
# 前端据此判定该家「关闭」，不加载对应脚本、不发外部请求。可同时启用多家。

# GA4 / 百度 ID 只含字母、数字和连字符；过滤掉其它字符，
# 避免值里的引号等破坏 config.js 的 JS 字符串（纵深防御）。
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
