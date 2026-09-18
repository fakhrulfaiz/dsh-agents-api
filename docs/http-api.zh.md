# OpenAI Agents API 路由

`@deepseek-ai/dsh-experimental-agents-api` 的 HTTP 路由与线协议语义。包 README 拥有安装与 profile 组合；本页拥有路径目录。

请求应发送 `OpenAI-Beta: agents=v1`。路径位于已配置的 `prefix` 下（默认 `/v1`）。

## 路由

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

## 会话创建与跟进

`POST /agents/sessions` 接受字符串或 `input_text` 消息作为 `input`，并用 `stream: true` 在创建响应上返回 SSE。跟进使用 `agent.session.input.message`。转向与新 turn 跟随 Host 的空闲或进行中状态。取消使用 `agent.session.input.cancel`。

创建会话时，Host 的 **provider** 取自 `ctx.agentDefaultModel.currentSelection()`，**model** id 取自 Agents API 的 `agent.model`。

## 函数工具

`agent.tools` 上的线缆 `type: "function"` 工具会挂载为作用域 Host 工具。模型调用时，Host 会停住 `execute`，会话状态变为 `requires_action`，`required_actions` 列出待处理调用。用匹配的 `call_id` 提交 `agent.session.input.tool_result`（或旧别名 `agent.session.input.function_call_output`）以完成 Host 工具并继续该 turn。该路径追加真实的 Host `tool/result`，不会提交用户跟进。

Host profile 组合中的工具仍然可用，并与线缆函数工具叠加。同名时，作用域线缆工具会遮蔽该会话的 profile 全局工具。

## 相关说明

- [挂载线缆函数工具](changes/2026-09-18-mount-function-tools.md) — 停住的 execute 与 `tool_result` 约定。
- [OpenAI Agents API](https://developers.openai.com/api/docs/guides/agents-api) — 上游线协议指南。
