# deepseek-harness-codex-bridge

> 原包名 `dsh-codex-bridge`（DeepSeek Harness × Codex 桥）

dsh（DeepSeek Harness）工具插件：让 dsh 的 agent 通过**官方 Codex**（ChatGPT 订阅，官方身份）执行任务。

## ✅ 账号安全（本插件的优势）

> 与市面上其他「使用 GPT 订阅/会员」的插件有本质区别：**本插件走官方 Codex CLI 路由（官方允许），不调用任何未公开接口，因此没有封号风险**，也不需要 API Key 或登录凭据。

- **官方路由**：本插件通过**官方 Codex CLI**（`codex login` 官方认证，官方 OAuth 设备码流程）连接，走 OpenAI 官方支持的通路——不触碰 `chatgpt.com/backend-api` 等未公开接口。
- **零凭据**：插件不读取、不保存、不传输任何 ChatGPT 账号凭据。认证由你**本机已登录的官方 Codex CLI** 自己持有。
- **零第三方**：插件只连接**本机回环地址**（`ws://127.0.0.1:4500`）上的 codex app-server，不发起任何第三方网络请求，不使用共享账号或账号池。
- **可审计**：全仓库无任何 token/凭据处理代码，`npm test` 与 `scripts/verify-integration.mjs` 验证的也是协议行为，不含认证材料。

> 对比：市面上一些类似插件直接调用 ChatGPT 网页版后端（`chatgpt.com/backend-api`）这类**未公开、官方不支持**的接口，那才存在违反 OpenAI 服务条款、账号受限被封号的风险。本插件走官方路由，不在此列。


```
用户 ↔ dsh web UI
        ↔ dsh agent ──工具调用──▶ dsh-codex-bridge（dsh 进程内）
                                        │ JSON-RPC 2.0 (WebSocket)
                                        ▼
                          codex app-server（独立进程, ws://127.0.0.1:4500）
                                        │ 官方身份
                                        ▼
                          chatgpt.com/backend-api（ChatGPT 订阅）
```

桥插件只做协议翻译：dsh 工具调用 → JSON-RPC 请求；app-server 事件 → dsh 工具结果（最终回复 + 过程摘要）。

## 功能

- **`codex` 工具**：dsh 模型可见的唯一入口。参数：`prompt`（必填）、`model`、`sandbox`、`thread_id`（续会话）。
- **多轮会话**：同一 dsh 会话内自动续接 codex thread（内存映射，桥重启后丢失 → 工具返回文本中带 `thread_id` 供显式续接）。
- **过程可见性**：工具结果 = Codex 最终回复 + 过程摘要（阶段列表 + 命令输出尾部，长度有界）。
- **dynamicTools（实验）**：把白名单内的 dsh 工具暴露给 Codex 调用（`dsh_` 前缀防保留命名冲突），`item/tool/call` 映射回 `ctx.tools` 在 dsh 进程内执行。默认关闭。

## 前置条件

- Node ≥ 22（用原生 WebSocket，无第三方网络依赖）
- 已登录 ChatGPT 的 codex CLI（`codex login status` 应显示 `Logged in using ChatGPT`）
- dsh v0.1.0-rc.6+

## 安装

```sh
# 1. 启动 app-server（见下方 launchd 配置，或手动：）
codex app-server --listen ws://127.0.0.1:4500

# 2. 装入 dsh web profile（在 profile 目录加依赖 + bundles 条目）
dsh plugin --profile web add file:/path/to/dsh-codex-bridge
# 然后编辑 ~/.dsh/profiles/web/package.json，在 dsh.profile.bundles 数组末尾加 "dsh-codex-bridge"

# 也可以用辅助脚本一次完成（含 launchd plist 安装）：
bash scripts/install.sh
```

重启 dsh 后生效。

## 配置

插件配置写在 profile 的 `cordis.patch.yml`（按行 id 覆盖）：

```yaml
- id: codex-bridge
  config:
    appServerUrl: ws://127.0.0.1:4500   # app-server 地址
    defaultModel: gpt-5.6-terra          # 默认模型（以 `codex` 本地实际支持为准）
    sandbox: read-only                   # read-only | workspace-write | danger-full-access
    approvalPolicy: never                # 桥接场景必须 never：没有人回答审批请求
    cwd: null                            # 新 thread 的工作目录；null = 服务器默认
    dynamicTools: []                     # 暴露给 Codex 的 dsh 工具白名单，如 [bash, fs_read]
    toolPrefix: dsh_                     # Codex 侧工具名前缀
    connectTimeoutMs: 10000
    requestTimeoutMs: 30000
    idleTimeoutMs: 30000                 # 空闲多久后主动断开 app-server 连接（下次请求惰性重连）
    turnTimeoutMs: 900000                # 单个 codex turn 的总预算
    maxCommandOutputChars: 4000          # 每条命令保留的输出尾部长度
    maxProcessChars: 8000                # 过程摘要总长度上限
```

dsh 模型会自行调用 `codex` 工具。返回文本末尾带 `[codex thread_id: ...]`，可传给下一轮显式续接。

### 空闲自动断开（idleTimeoutMs）

桥与 app-server 的 WebSocket 按需建立后默认保持。dsh headless 场景任务结束不会触发插件 dispose，持有的 socket 会阻止 dsh 进程退出——因此桥在**最后一次活动**（请求发出 / 响应或事件到达 / server request 应答）后空闲 `idleTimeoutMs`（默认 30 秒）即主动断开，断开后的下一次调用自动重连。进行中的 turn（有挂起请求或活动事件监听）不会被空闲断开打断；同一 dsh 会话内间隔小于 `idleTimeoutMs` 的连续工具调用复用同一连接，thread 续接不受影响。

## 使用

在 dsh 对话中直接说，例如：

- 「用 GPT 审查一下 src/auth.ts 的安全性」
- 「让 Codex 解释一下这个仓库的构建流程」

dsh 模型会自行调用 `codex` 工具。返回文本末尾带 `[codex thread_id: ...]`，可传给下一轮显式续接。

### dynamicTools 示例

配置 `dynamicTools: [bash]` 后，Codex 在 turn 中可以调用 `dsh_bash`：app-server 发来 `item/tool/call` server request，桥在 dsh 进程内执行 `bash` 工具并回传结果。白名单为空时该路径完全关闭。

## app-server 进程托管（launchd）

`scripts/install.sh` 会写入 `~/Library/LaunchAgents/ai.dsh.codex-app-server.plist` 并加载。手写参考：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.dsh.codex-app-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/codex</string>
    <string>app-server</string>
    <string>--listen</string>
    <string>ws://127.0.0.1:4500</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/codex-app-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/codex-app-server.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/ai.dsh.codex-app-server.plist
```

## 验证

```sh
npm test                              # 单测：mock WebSocket 验证 JSON-RPC 客户端 / 事件翻译 / 工具映射
node scripts/verify-integration.mjs   # 集成：直连本机 app-server，跑通 thread/turn/事件流/多轮/dynamicTools
```

## 错误分类

工具错误文本按来源分类，便于 dsh 模型判断如何处理：

- `无法连接 app-server (...)` — app-server 未运行或地址错误
- `codex turn 超时（...）` — turn 预算内未收到 `turn/completed`（已同时请求 `turn/interrupt` 清理 server 侧）
- `codex turn failed: ...` — codex 侧 turn 失败（模型/配额/上游错误）
- `codex turn 被中断` / `被 dsh 侧取消` — 取消路径
- `与 app-server 的连接已关闭` — 断线快速失败（挂起请求与进行中的 turn 立即以该错误终结）
- `续接 thread ... 失败 ... 已开启新会话` — 过期 thread 映射自动回退

## 安全边界

- 只连本地 app-server（配置项可改，但插件本身不发起任何其他网络请求）
- 无凭据：认证完全由 codex CLI 自己持有
- 默认 `sandbox: read-only` + `approvalPolicy: never`：Codex 无法改文件，也不会卡在审批上
- dynamicTools 默认空白名单：Codex 调用 dsh 工具的能力默认关闭

## 已知限制（v0.1.0）

- thread 映射只在内存中（上限 256 条，LRU 淘汰）；桥重启后需显式传 `thread_id` 续接
- dsh 工具模型下没有逐字流式体验：过程在 turn 结束后以摘要呈现（SPEC §2.2「诚实边界」）
- dynamicTools 是 codex 实验 API（`capabilities.experimentalApi`），协议可能随 codex 版本变动
- 白名单工具经 `ctx.tools.execute` 带调用方 agent 身份执行，并随 codex turn 的取消/结束一并 abort；桥接场景无人应答审批，需要审批/escalation 的调用被拒（fail-closed），结果文本中带「未经过 dsh 人工审批」标注；桥自身的 `codex` 工具强制不可暴露（防自递归）
- 不支持 image 输入、多账号
