# Open Design 编译与调试指南

Open Design 推荐通过 `tools-dev` 编译调试。它会同时启动 daemon 和 Web，并支持热更新。

## 1. 准备 Node.js 和 pnpm

项目要求：

- Node.js 24.x
- pnpm 10.33.2

这台机器已经有可用的 Node.js 24：

```bash
cd "/home/hhr/Documents/ChatGPT/开源软件分析/open-design"

export PATH="/home/hhr/Downloads/.lark-cli-runtime/node-v24.22.3/bin:$PATH"
corepack enable
hash -r

node --version
pnpm --version
```

预期分别输出 `v24.x` 和 `10.33.2`。然后安装依赖：

```bash
pnpm install
```

> 不要使用全局的 Node.js 18 / pnpm 11，也不要使用已经废弃的 `pnpm dev`。

## 2. 前台启动调试

推荐使用固定端口启动：

```bash
pnpm tools-dev run web \
  --daemon-port 17456 \
  --web-port 17573
```

然后打开：

<http://127.0.0.1:17573>

该模式会：

- 编译并运行 daemon；
- 启动 Next.js Web 开发服务器；
- 自动把 `/api` 请求代理到 daemon；
- 支持前端代码热更新；
- 将 daemon 日志直接输出到当前终端；
- 按 `Ctrl+C` 停止。

## 3. 验证 OpenCode Server

先确认 OpenCode CLI 可用：

```bash
opencode --version
```

在 Open Design 中进入 **Settings → Models & providers → Local CLI**，选择
**OpenCode Server**，然后滚动到页面底部并展开
**高级：代理与自定义路径（Advanced: proxy & custom paths）**：

- Server URL：`http://127.0.0.1:4096`
- Password：本地托管模式可以留空
- OpenCode binary：通常使用 `opencode`；无法自动找到时填写绝对路径

点击连接测试或发送第一条消息时，Open Design 会自动执行并管理：

```bash
opencode serve --hostname 127.0.0.1 --port 4096 --print-logs
```

终端中看到以下内容表示启动成功：

```text
[opencode-server] managed server ready at http://127.0.0.1:4096
```

daemon 关闭时，只会停止由 Open Design 自己启动的 OpenCode Server；已有的外部 Server 不会被停止。

## 4. 后台调试与日志

后台启动 daemon 和 Web：

```bash
pnpm tools-dev start web \
  --daemon-port 17456 \
  --web-port 17573
```

常用管理命令：

```bash
pnpm tools-dev status
pnpm tools-dev logs
pnpm tools-dev check
pnpm tools-dev stop
```

## 5. 单独编译

分别编译 daemon、Web 和 desktop：

```bash
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/web build
pnpm --filter @open-design/desktop build
```

执行完整静态检查：

```bash
pnpm typecheck
pnpm guard
```

只验证新增的 OpenCode Server 功能：

```bash
pnpm --filter @open-design/daemon exec vitest run \
  -c vitest.config.ts \
  tests/runtimes/opencode-server.test.ts \
  tests/runtimes/opencode-server-manager.test.ts
```

## 6. daemon 断点调试

在第一个终端中编译并以 Node.js Inspector 模式启动 daemon：

```bash
pnpm --filter @open-design/daemon build

node --inspect-brk=127.0.0.1:9229 \
  apps/daemon/dist/cli.js \
  --port 17456 \
  --no-open
```

在第二个终端中启动 Web：

```bash
OD_PORT=17456 \
pnpm --filter @open-design/web dev -- -p 17573
```

随后可以：

- 在 VS Code 中使用 Node Attach 连接 `127.0.0.1:9229`；
- 或在 Chrome 中打开 `chrome://inspect`；
- Web 前端断点直接使用浏览器开发者工具。

## 7. 常见问题

### pnpm 版本不兼容

如果出现以下错误：

```text
ERR_PNPM_UNSUPPORTED_ENGINE
Expected version: >=10.33.2 <11
```

重新确认 Node.js 24 的目录排在 `PATH` 最前面，并启用 Corepack：

```bash
export PATH="/home/hhr/Downloads/.lark-cli-runtime/node-v24.22.3/bin:$PATH"
corepack enable
hash -r
pnpm --version
```

### OpenCode Server 端口被占用

检查 `4096` 端口：

```bash
ss -ltnp | grep ':4096'
```

如果端口上已经运行了认证配置不兼容的服务，请停止该服务，或者在 Settings 中为 OpenCode Server 设置其他本地 URL。

### better-sqlite3 原生模块错误

```bash
pnpm --filter @open-design/daemon rebuild better-sqlite3
pnpm --filter @open-design/daemon exec node -e "require('better-sqlite3')"
```

## 8. 相关代码

- OpenCode Server 管理器：`apps/daemon/src/runtimes/opencode-server-manager.ts`
- OpenCode Server runtime：`apps/daemon/src/runtimes/defs/opencode-server.ts`
- daemon 启动入口：`apps/daemon/src/server.ts`
- 中文快速上手：`docs/i18n/QUICKSTART.zh-CN.md`
