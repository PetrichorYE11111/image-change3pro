# Infinite Canvas — Railway 部署文档

本文档记录本项目在 Railway 上的部署方式、服务组成，以及前端接入第三方 AI 接口（change2pro）时遇到的 CORS 问题与解决方案。

## 一、总体架构

Infinite Canvas 是**纯前端**应用（`web/` 下的 Vite + React），构建后由 nginx 托管静态文件。所有 AI 请求都由**浏览器直接**发往用户在设置里填写的接口地址，项目本身没有后端转发层。

因此 Railway 上部署了两个服务：

| 服务 | 作用 | 部署方式 | 公开地址 |
|---|---|---|---|
| `app` | Infinite Canvas 前端 | Docker 镜像 `ghcr.io/basketikun/infinite-canvas:latest`（端口 3000） | https://app-production-946f.up.railway.app |
| `cors-proxy` | 给第三方 AI 接口补 CORS 头的反向代理 | Docker 镜像 `testcab/cors-anywhere:latest`（端口 8080） | https://cors-proxy-production-5a4e.up.railway.app |

- Railway 项目名：`infinite-canvas`
- 项目 ID：`ba5107d1-2aeb-42e1-9e40-70483e158f61`
- 环境：`production`

## 二、部署 `app`（前端）

仓库根目录的 `docker-compose.yml` 直接引用了官方预构建镜像，无需本地构建：

```yaml
services:
  app:
    image: ghcr.io/basketikun/infinite-canvas:latest
    ports:
      - "3000:3000"
```

Railway 部署步骤（CLI）：

```bash
# 1. 安装并登录 Railway CLI
bash <(curl -fsSL railway.com/install.sh)
source ~/.railway/env
railway login

# 2. 在仓库目录初始化项目
railway init            # 交互式创建项目 infinite-canvas

# 3. 用官方镜像创建 app 服务（对应 docker-compose 里的 image）
railway add --service app --image ghcr.io/basketikun/infinite-canvas:latest

# 4. 生成公开域名（容器监听 3000）
railway domain --port 3000
```

> 说明：最初尝试用仓库根 `Dockerfile` 由 Railway 构建，构建器多次 `Failed`。改为直接使用 `docker-compose.yml` 指定的预构建镜像后一次成功，这也更贴合 compose 文件的原意。

## 三、问题：浏览器直连第三方 AI 接口被 CORS 拦截

在应用里配置 change2pro 接口（`https://api.change2pro.com`）后，浏览器控制台报错：

```
Access to XMLHttpRequest at 'https://api.change2pro.com/v1/models'
from origin 'https://app-production-946f.up.railway.app'
has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**根因**：change2pro 的服务器没有针对浏览器跨域请求返回 `Access-Control-Allow-Origin` 头。由于本项目是浏览器直连接口、没有自己的后端，浏览器的同源策略会直接拦掉这些请求。这不是应用配置错误，而是第三方接口不支持跨域调用。

### 前端如何拼接接口地址

`web/src/stores/use-config-store.ts` 的 `buildApiUrl()`：如果填写的 Base URL 不以 `/v1` 结尾，会自动追加 `/v1`。所以填 `https://api.change2pro.com`，实际请求会打到 `https://api.change2pro.com/v1/...`。**不要**自己再填 `/v1` 或完整的 `/v1/chat/completions` 路径，否则会重复。

## 四、解决方案：部署 CORS 反向代理

新增一个 `cors-proxy` 服务（基于 `testcab/cors-anywhere` 镜像），它转发请求到目标接口并补上 CORS 头。

```bash
# 创建镜像服务
railway add --service cors-proxy \
  --image testcab/cors-anywhere:latest \
  --variables "PORT=8080"

# 生成公开域名
railway service link cors-proxy
railway domain --port 8080

# 收紧访问：仅允许本应用来源调用（否则代理对全网开放）
railway variables --set \
  "CORSANYWHERE_WHITELIST=https://app-production-946f.up.railway.app" \
  --service cors-proxy
railway redeploy --service cors-proxy --yes
```

`cors-anywhere` 的调用格式是 `https://<代理域名>/<完整目标URL>`。

## 五、应用内正确配置

打开 https://app-production-946f.up.railway.app 的渠道设置，按下表填写：

| 字段 | 值 |
|---|---|
| 协议 | OpenAI |
| 接口地址 (Base URL) | `https://cors-proxy-production-5a4e.up.railway.app/https://api.change2pro.com` |
| API Key | change2pro 的 API Key |

前端会自动补 `/v1`，最终请求为：

```
https://cors-proxy-production-5a4e.up.railway.app/https://api.change2pro.com/v1/models
```

## 六、验证

```bash
URL="https://cors-proxy-production-5a4e.up.railway.app/https://api.change2pro.com/v1/models"

# 允许的来源 → 转发到上游（未带 key 时上游回 401，证明已穿透）
curl -s -w "\n%{http_code}\n" -H "Origin: https://app-production-946f.up.railway.app" "$URL"
# → {"code":"API_KEY_REQUIRED",...}  status=401

# 未授权来源 → 代理直接 403，不转发
curl -s -w "\n%{http_code}\n" -H "Origin: https://evil.example.com" "$URL"
# → The origin "..." was not whitelisted ...  status=403
```

响应头包含 `access-control-allow-origin`，浏览器不再拦截。

### 6.1 gpt-image-2 三条链路端到端实测（2026-08-10）

用 change2pro 沙盒 key 经反代实跑，三条链路全部 `200` 且返回 `b64_json`，响应头均带 `access-control-allow-origin: *`：

| 链路 | 前端代码 | 请求 | 结果 |
|---|---|---|---|
| 列模型 / SDK | `fetchImageModels()` | `GET /v1/models` | `200`，返回 `gpt-image-2` |
| 文生图 | `requestGeneration()` | `POST /v1/images/generations`（JSON） | `200` + `b64_json`，~43s |
| 图生图 | `requestEdit()` | `POST /v1/images/edits`（multipart，字段 `image`） | `200` + `b64_json`，~59s（直连 ~97s） |

说明：

- 前端 `buildApiUrl()` 会强制补 `/v1`；实测 change2pro 兼容 `/v1/images/*`，**前端无需改代码**，`gpt-image-2` 已是默认图片模型。
- change2pro 返回体带 C2PA（`jumb`/`c2pa`）元数据，属正常。

## 七、安全注意事项

- **API Key 泄露风险**：调试过程中若在明文渠道（聊天、日志、截图）暴露过 `sk-...` key，应立即到 change2pro 后台**撤销并重新生成**。
- **代理已加白名单**：`CORSANYWHERE_WHITELIST` 限定只有本应用来源可用，避免代理被他人滥用中转。若之后更换了 `app` 的域名，需同步更新此白名单变量。
- 该代理会透传 `Authorization` 头到上游，请确保代理服务本身（Railway）可信。

## 八、常用运维命令

```bash
source ~/.railway/env
railway status                              # 查看所有服务状态
railway logs --service app                  # 查看 app 运行日志
railway logs --service cors-proxy           # 查看代理日志
railway variables --service cors-proxy      # 查看代理环境变量
railway redeploy --service <name> --yes     # 重新部署
```
