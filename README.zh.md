---
description: "可安装的实验性 profile 层，为已经使用 agents=v1 的应用通过 REST 与 SSE 提供 OpenAI Agents API。"
kind: "package-bundle"
---

# @fakhrulfaiz/dsh-agents-api

[English](README.md) | 中文

## 概述

从 DeepSeek Harness Host 提供 [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api)，使 OpenAI SDK 或 cURL 客户端可以创建已保存 agent、打开 `sess_*` 会话、流式传输 turn 事件，并发送跟进或取消输入。当客户端已经使用 `OpenAI-Beta: agents=v1` 时选择它。本包是实验性可安装插件：它不属于随附的 `web`、`headless`、`acp` 或 `sdk` profile。Host profile 仍拥有工具、沙箱和模型路由；本插件把 HTTP 映射到 `ctx.agents.create`、`followup`、`steer` 和 `cancel`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 `dsh-host-webserver`、`dsh-session`、`dsh-agent` 和 `dsh-agent-default-model` 一起挂载（循环工厂必须已经注册），然后把 OpenAI 客户端的 `baseURL` 指向该服务器。创建会话时，Host 的 **provider** 取自 `ctx.agentDefaultModel.currentSelection()`，**model** id 取自 Agents API 的 `agent.model`。

### 从 GitHub 安装

当你要把本包装进 profile、又不改它的源码时用这条路径。先创建专用的、基于 base 的 profile。不要加到随附的 `web` profile：该 profile 已经拥有 `id: webserver`。

```sh
pnpm dsh plugin --profile agents add github:fakhrulfaiz/dsh-agents-api
pnpm dsh plugin --profile agents remove @fakhrulfaiz/dsh-agents-api
```

如果 pnpm 拦截了 git 的 `prepare` / `tsdown` 构建，在 profile 的 `pnpm-workspace.yaml` 中允许它，然后重新运行 `add`：

```yaml
allowBuilds:
  '@fakhrulfaiz/dsh-agents-api': true
```

CLI 会在需要时初始化 profile。patch 插入监听 `0.0.0.0:3080` 的 `dsh-host-webserver`（`id: webserver`），以及前缀 `/v1` 的本插件（`id: agents-api`，空 `apiKey`）。后续 profile patch 可以替换任一行的完整配置。

### 从本地检出开发

当你要改本包时用这条路径。把 profile 指到本地树（绝对路径，或相对运行 `pnpm dsh` 的 DeepSeek Harness 检出的路径）。

若 DeepSeek Harness 检出里已有 `packages/experimental/agents-api`：

```sh
pnpm dsh plugin --profile agents add ./packages/experimental/agents-api
```

从本仓库的任意克隆：

```sh
pnpm dsh plugin --profile agents add /absolute/path/to/dsh-agents-api
```

编辑 `src/` 之后，在包目录运行 `pnpm build`（或让安装跑 `prepare`），然后重启 profile。profile 的 `package.json` 里若是 `link:` 依赖，运行会加载该本地树；若是 `github:` 依赖，则会加载远程提交，直到你再次 `add`。
### 何时选择它

当 OpenAI Agents API 客户端需要针对本地 Host 的 REST 加 SSE 时选择它。Agent Client Protocol stdio 请用 [`dsh-acp`](../../acp/acp/README.zh.md)，第一方 JSON-RPC SDK 请用 [`dsh-sdk-jsonrpc-server`](../../sdk/server/README.zh.md)。本网关不实现 Assistants v2 的 `/v1/threads`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '127.0.0.1'
    port: 3080
- name: '@fakhrulfaiz/dsh-agents-api'
  config:
    apiKey: ''
    prefix: '/v1'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `''` | `Authorization` 中要求的 Bearer 令牌；空字符串关闭鉴权 |
| `prefix` | `/v1` | 每条 Agents API 路由的 URL 前缀 |

生成的 [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agents-api) 是每个已接受字段及其 JSDoc 的完整来源。

请求应发送 `OpenAI-Beta: agents=v1`。在已配置前缀下的官方路由：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` `GET` | `/agents` | 创建或列出已保存 agent |
| `GET` `POST` `DELETE` | `/agents/{agent_id}` | 读取、更新或删除已保存 agent |
| `POST` `GET` | `/agents/sessions` | 创建或列出会话（`agent` 对象和/或 `agent_id`） |
| `GET` `POST` `DELETE` | `/agents/sessions/{session_id}` | 读取、更新（`model` / `reasoning.effort` / `service_tier` / `metadata`）或删除 |
| `POST` `GET` | `/agents/sessions/{session_id}/events` | 提交输入事件；`GET` 是 SSE 流（`?stream=true`） |
| `GET` | `/agents/sessions/{session_id}/items` | 列出已保存条目（默认 `order=asc`） |
| `GET` | `/agents/sessions/{session_id}/turns` | 列出 turn |
| `GET` | `/agents/sessions/{session_id}/turns/{turn_id}` | 读取一个 turn |

`POST /agents/sessions` 接受字符串或 `input_text` 消息作为 `input`，并用 `stream: true` 在创建响应上返回 SSE。跟进使用 `agent.session.input.message`；转向与新 turn 跟随 Host 的空闲或进行中状态；取消使用 `agent.session.input.cancel`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本插件是函数插件（`name` / `inject` / `Config` / `apply`，无 default export）。`apply` 通过 `ctx.effect` 注册前缀处理器，并把 `session/event` 扇出为 Agents API SSE 事件以及实时条目列表。`/agents/sessions` 在 `/agents/:agent_id` 之前匹配，因此字面量 `sessions` 段不会被当成 agent id。

每个会话以 `sess_*` id 调用 `ctx.agents.create`（ACP 创建路径），`agentOptions.provider` 来自 `agentDefaultModel`，`agentOptions.model` 来自线上 agent，然后 `followup` 或 `steer`。已保存 agent 只存在于本进程；会话本地内联 agent 会物化，但不会出现在 `GET /agents`。条目列表从实时 `session/event` 记录累积，不读取历史 Session 日志。`reason.kind === 'error'` 的 `turn/end` 变成 `agent.session.turn.failed`；其他结束变成 `agent.session.turn.completed`。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、前缀注册、Session 事件桥接 |
| [`src/gateway.ts`](src/gateway.ts) | 有序 HTTP 路由与 Host agent 生命周期 |
| [`src/session-registry.ts`](src/session-registry.ts) | 会话、turn、条目与 SSE 订阅者目录 |
| [`src/agent-store.ts`](src/agent-store.ts) | 已保存 agent 的 CRUD |
| [`src/items.ts`](src/items.ts) | 一条 Session 事件到已保存条目 |
| [`src/bridge.ts`](src/bridge.ts) | Session 事件到 Agents API 输出事件 |
| [`src/pending-function-calls.ts`](src/pending-function-calls.ts) | 停住的客户端函数工具等待与 `requires_action` |
| [`src/mount-function-tools.ts`](src/mount-function-tools.ts) | 线缆 `type: "function"` → 作用域 Host 工具注册 |
| [`cordis.patch.yml`](cordis.patch.yml) | 插入 webserver 与本插件的列表 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md) — 发布策略与依赖隔离。
- [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) — 本网关实现的线协议约定。
- [dsh-acp](../../acp/acp/README.zh.md) — 面向非 HTTP 客户端、仅用于自动化的 stdio 协议。
- [OpenAI Agents API HTTP 网关](../../../.agents/notes/implemented/feature/2026-09-17-openai-agents-api-http-gateway.zh.md) — 路由、创建路径与条目投影决策。

-----

<a id="model-experience"></a>
## 模型体验

### 会话输入文本

#### 模型看到什么

`POST /agents/sessions` 以及 `agent.session.input.message` 中每个非空 `input` 字符串或 `input_text` 部分会成为一条 Host 用户消息（`source.kind: user`）。

`agent.tools` 上的线缆 `type: "function"` 工具会挂载为作用域 Host 工具。模型调用时，Host 会停住 `execute`，会话状态变为 `requires_action`，`required_actions` 列出待处理调用。用匹配的 `call_id` 提交 `agent.session.input.tool_result`（或旧别名 `agent.session.input.function_call_output`）以完成 Host 工具并继续该 turn。该路径追加真实的 Host `tool/result`，不会提交用户跟进。

Host profile 组合中的工具仍然可用，并与线缆函数工具叠加。同名时，作用域线缆工具会遮蔽该会话的 profile 全局工具。

#### Token 影响

这些用户消息与工具结果会留在 Session 中，直到普通 compaction 替换或移除该历史。

#### KV Cache 影响

跟进与转向追加到现有 Session。它们不替换先前已完成 turn 的可复用前缀。新会话开始新的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **实验性 opt-in 层** — 随附的 `web` / `headless` / `acp` / `sdk` profile 不包含本包；把它加到专用的、基于 base 的 profile。
- **不要叠到随附的 web profile 上** — 该 profile 已经插入 `id: webserver`；本 patch 插入同一个 id。
- **`openai_hosted` 不会开通 OpenAI 沙箱** — 除非 `environment.type` 为 `self_hosted` 且 `workspace_directory` 为绝对路径，Host 使用 `process.cwd()`。
- **只挂载 `type: "function"` 工具** — MCP、`web_search`、`programmatic_tool_calling`、`tool_search` 与 `defer_loading` 在创建时被拒绝；这些能力请用 Host profile。
- **会话设置更新留在 Agents API 资源上** — `POST /agents/sessions/{id}` 记录 `model`、`reasoning.effort` 和 `service_tier` 供后续读取；它不会改道实时 Host agent。
- **已保存 agent 是进程本地的** — `GET /agents` 列出本进程创建的 agent；它们在重启后不持久。
- **SSE 不回放** — 断开后请读取会话并 `GET .../items`；事件流只从订阅时刻开始发出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。路由分发、已保存 agent CRUD 与实时条目列表由 HTTP 和 Loader 测试覆盖；它们不比较独立产生的观察。
