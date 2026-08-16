# codex 桥插件 SPEC v0.1.0

dsh（DeepSeek Harness）工具插件：让 dsh 的 agent 通过官方 Codex（ChatGPT 订阅，官方身份）
执行任务，支持流式事件呈现与动态工具注入（Codex 可调用 dsh 侧工具）。

> 状态：待 K3 实现。协议依据：learn.chatgpt.com/docs/app-server.md（2026-08 官方文档）
> + dsh v0.1.0-rc.6 本机源码（~/.npm-global/lib/node_modules/@deepseek-ai/）。

## 1. 架构

```
用户 ↔ dsh web UI (3080, launchd 托管)
        ↔ dsh agent (deepseek-v4-pro) ──工具调用──▶ codex 桥插件（dsh 进程内）
                                                          │ JSON-RPC 2.0 (WebSocket)
                                                          ▼
                                              codex app-server（独立进程, launchd 托管, ws://127.0.0.1:4500）
                                                          │ 官方身份
                                                          ▼
                                              chatgpt.com/backend-api（ChatGPT 订阅）
```

- **桥 = dsh 插件**（独立 npm 包，`dsh plugin add file:...` 装入 web profile）
- **app-server = 独立进程**，launchd 单独托管（`ai.dsh.codex-app-server.plist`，崩溃自愈，
  与 dsh web 同模式），监听 `ws://127.0.0.1:4500`
- 桥插件只做协议翻译：dsh 工具调用 → JSON-RPC 请求；app-server 事件 → dsh 工具结果/增量

## 2. 功能需求

### 2.1 工具：`codex`（给 dsh 模型看的唯一入口）
参数（JSON Schema）：
- `prompt` (string, required)：任务描述
- `model` (string, optional)：覆盖模型，默认取配置
- `sandbox` (enum: read-only|workspace-write|danger-full-access, optional)
- `thread_id` (string, optional)：续会话时传；不传 = 新会话

工具描述（教 deepseek 何时用）：
「当用户明确要求使用 GPT/ChatGPT/Codex 模型、或任务适合由 Codex 执行时调用。
执行时间可能较长（秒级到分钟级）。返回 Codex 的最终回复。多轮可传 thread_id 延续。」

### 2.2 流式呈现（体验层）
- 桥订阅 app-server 事件，把过程可见性转给 dsh：
  - `item/agentMessage/delta` → 累积 agent 文本
  - `item/commandExecution/outputDelta` → 命令输出
  - `item/reasoning/summaryTextDelta` → 推理摘要
  - `item/started` / `item/completed` → 阶段状态（thinking / 执行命令 / 修改文件 / 完成）
- 呈现通道（按可行性排序，实现时先验证）：
  1. 工具结果文本 = 最终回复 + 过程摘要（阶段列表 + 命令输出尾部）——保底，必然可用
  2. dsh `job_output` 增量 delta 机制（参考 dsh-tool-bash persistent 实现）——模型可
     在任务运行中读到增量，向用户播报进度
  3. dsh call view（TerminalCallView 等 presentation 类型）——UI 层展示，若 API 允许
- **诚实边界**：dsh 工具模型下没有「模型逐字打字」体验；做到的是「任务过程可见、
  结果完整返回」。UI 呈现为工具调用卡片 + 过程摘要 + 最终结果。

### 2.3 dynamicTools（Codex 调用 dsh 工具）
- 桥把 dsh 工具目录（`ctx.tools` 注册的工具，按配置白名单筛选）翻译成 Responses API
  格式的 dynamicTools（name/description/parameters），随 `thread/start` 传入
  （`capabilities.experimentalApi = true`）
- 调用流程（协议确认）：
  1. `item/started` { type: dynamicToolCall, status: inProgress, tool, arguments }
  2. `item/tool/call`（server request）→ 桥映射回 `ctx.tools` 执行（同名工具，dsh 进程内执行）
  3. 桥回复 content items（执行结果）
  4. `item/completed` { type: dynamicToolCall, contentItems/success }
- 工具命名：避免 Codex 保留命名空间（如 bash、fs 等内置名）；dsh 工具名前缀化（如 `dsh_xxx`）
- 白名单配置：默认空（关闭）；用户按需开启并选择暴露哪些 dsh 工具
- 注意：dynamicTools 是 experimental API，需 `capabilities.experimentalApi = true`

### 2.4 多轮会话管理
- 每个 dsh 对话会话 → 插件内维护 `thread_id` 映射（按 dsh session id）
- 首轮：thread/start + turn/start；后续：thread/resume + turn/start（携带 thread_id）
- 桥重启后映射丢失 → 工具描述提示用户可传 thread_id 续接（或配置持久化 thread 映射）

## 3. 协议细节（实现依据）

### 3.1 连接
- `codex app-server --listen ws://127.0.0.1:4500`（launchd 托管）
- JSON-RPC 2.0，每 WebSocket text frame 一条消息（协议无 jsonrpc 头）
- 初始化：`initialize` → `initialized` 通知（capabilities 里开 experimentalApi）

### 3.2 关键方法
- `thread/start`：{ model, dynamicTools?, sandboxPolicy?, approvalPolicy?, cwd?, capabilities? }
- `thread/resume`：{ threadId, ...同 start }
- `turn/start`：{ threadId, input: [{ type: "text", text }] }
- 通知流：item/started、item/completed、item/agentMessage/delta、
  item/reasoning/summaryTextDelta、item/commandExecution/outputDelta、
  item/tool/call（server request，需响应）、turn/started、turn/completed
- 结束判定：turn/completed（status: completed/failed）或 error 事件

### 3.3 dynamicTools 请求/响应（server request `item/tool/call`）
请求：{ id, itemId, tool, arguments }
响应：{ id, result: { contentItems: [{ type: "text", text }] } }（或 error）

### 3.4 默认模型
- 配置默认 `gpt-5.6-terra`（app-server 官方文档示例模型），可覆盖
- 模型列表以本地 codex CLI 实际支持为准（`codex exec` 验证）

## 4. 插件形态（dsh 侧）

- Cordis 插件：命名导出 `name` / `inject` / `apply`（参照 dsh-llm-codex-oauth 范式）
- `inject`: ['tools', 'llm', 'commands']（tools 必须；llm 用于取模型配置？——确认 dsh
  工具插件的注入面，参照 dsh-tool-bash 的 inject）
- 工具注册：`ctx.tools` + `defineTool`（dsh-tools 的 schema 规范）
- 依赖：WebSocket client（Node 22 原生 WebSocket，无需第三方包）+ 无其他运行时依赖
- 配置：cordis.patch.yml 或插件 config（appServerUrl、defaultModel、sandbox、
  dynamicTools 白名单、thread 映射持久化开关）

## 5. 目录结构（本仓库）

```
codex 桥/
├── package.json          # name: dsh-codex-bridge, ESM, v0.1.0
├── src/
│   ├── index.js          # 插件入口（name/inject/apply）
│   ├── bridge.js         # app-server JSON-RPC client（ws 连接、请求/响应、事件路由）
│   ├── tools.js          # codex 工具定义 + dynamicTools 翻译 + ctx.tools 映射
│   ├── thread.js         # dsh session ↔ codex thread 映射
│   ├── events.js         # 事件 → 工具结果/增量文本 的翻译
│   └── config.js         # 配置 schema 与默认值
├── scripts/
│   └── install.sh        # 安装辅助（可选，装插件+写 plist）
└── README.md
```

## 6. 验证方案

1. 单测：JSON-RPC client 用 mock server（node:test）验证请求/响应/事件路由
2. 集成：本机起 app-server（ws://127.0.0.1:4500），脚本直连验证 thread/start +
   turn/start + 事件流 + dynamicTool 往返
3. dsh 实测：装入 web profile → 重启 dsh → 对话「用 GPT 审查 xx」→ 验证工具被调、
   结果返回、多轮续接、dynamicTools 调用 dsh 工具
4. 安全检查：凭据不进仓库、日志不落 token、无第三方网络请求（只连本地 app-server）

## 7. 发布计划

- 独立仓库：MartyYao/deepseek-harness-codex-bridge（干净版：无凭据、无本机路径硬编码）
- v0.1.0 起始（用户版本约定）
- 本机部署路径：源码即本仓库（安装脚本与 README 均使用相对路径或 `$HOME`）
- app-server 进程管理：launchd plist 随插件 README 提供；Deck 托盘集成列为后续
  （v0.14+ 增强，不在本插件范围）

## 8. 明确不做（v0.1.0 范围外）

- 不做 dsh llm seam 接入（pi-ai 式模型通道）——本插件是工具级
- 不做 image 输入支持（app-server 是否支持待验证，后续再说）
- 不做多账号/账号池
- 不做 Deck 壳内集成（保持壳与 DSH 解耦原则）
