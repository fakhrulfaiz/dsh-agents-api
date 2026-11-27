/**
 * OpenAI Agents API wire types (`OpenAI-Beta: agents=v1`).
 *
 * Defined locally so this package has no runtime dependency on the OpenAI SDK.
 *
 * Reference: https://developers.openai.com/api/docs/guides/agents-api
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  OAILocalEnvironment,
  OAISandboxEnvironment,
  OAISandboxSessionEnvironment,
} from './environment-types.ts'
import type { OwnerId } from './auth/authenticator.ts'

import type { ConnectRequest } from './connect-request.ts'

/** Conversation roles accepted on input messages. */
export type Role = 'user' | 'assistant' | 'system'
/** Session lifecycle reported on `agent.session` resources. */
export type SessionStatus = 'idle' | 'in_progress' | 'requires_action' | 'failed'
/** Turn lifecycle reported on `agent.session.turn` resources. */
export type TurnStatus = 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled'
/** Item completion reported on saved session items. */
export type ItemStatus = 'in_progress' | 'completed' | 'incomplete'
/** Tool-call completion reported on function, MCP, and command items. */
export type ToolCallStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete'
/** Service-tier selection accepted on agent and session updates. */
export type ServiceTier = 'auto' | 'default' | 'flex' | 'priority' | 'fast'
/** Reasoning effort accepted on agent configuration. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Best-effort token accounting on session and turn resources.
 *
 * Cached tokens are included in `input_tokens`. Reasoning tokens are included
 * in `output_tokens`. Counts may be `null` when unknown.
 */
export interface OAITokenUsage {
  input_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens: number
  output_tokens_details: { reasoning_tokens: number }
  total_tokens: number
}

/** Cursor page returned by list endpoints. */
export interface OAIListResponse<T> {
  object: 'list'
  data: T[]
  first_id: string | null
  last_id: string | null
  has_more: boolean
}

/** An owner-scoped grouping of sessions. `null` environment means the default workspace. */
export interface OAIProject {
  id: string
  object: 'project'
  name: string
  status: 'active' | 'archived'
  pinned: boolean
  agent_id: string | null
  environment: OAIEnvironmentConfig | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

/**
 * Page query for `projects.list`. `status` defaults to `active`, `limit` to 20,
 * and `order` to `desc`. `after` is the last id of the previous page, as in
 * `OwnedCollection`; a foreign id starts the list from the beginning.
 */
export interface ProjectListQuery {
  owner: OwnerId
  status?: 'active' | 'archived' | 'all'
  limit?: number
  after?: string
  order?: 'desc' | 'asc'
}

/** Custom function tool the application implements. */
export interface OAIFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  defer_loading?: boolean
}

/** Built-in tool-search tool. */
export interface OAIToolSearchTool {
  type: 'tool_search'
}

/** Built-in programmatic tool-calling tool. */
export interface OAIProgrammaticToolCallingTool {
  type: 'programmatic_tool_calling'
  enabled?: boolean
}

/** Streamable HTTP transport for a wire MCP server. */
export interface OAIMcpHttpTransport {
  type: 'http'
  server_url: string
  headers?: Record<string, string>
}

/** Stdio transport for a wire MCP server. */
export interface OAIMcpStdioTransport {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** MCP server connection declared on an agent. */
export interface OAIMcpTool {
  type: 'mcp'
  server_label: string
  transport: OAIMcpHttpTransport | OAIMcpStdioTransport
  allowed_tools?: string[] | null
  required?: boolean
  connection_origin?: 'service' | 'environment'
  credential_id?: string | null
  request_metadata?: Record<string, unknown>
}

/** Built-in web-search tool. */
export interface OAIWebSearchTool {
  type: 'web_search'
  mode?: 'disabled' | 'cached' | 'live'
  context_size?: 'low' | 'medium' | 'high'
  allowed_domains?: string[] | null
  location?: unknown
}

/** One tool entry on an agent configuration. */
export type OAIToolConfig =
  | OAIFunctionTool
  | OAIToolSearchTool
  | OAIProgrammaticToolCallingTool
  | OAIMcpTool
  | OAIWebSearchTool

/** Subagent delegation controls. */
export interface OAIMultiAgentConfig {
  enabled: boolean
  max_concurrent_subagents?: number | null
}

/** Reasoning controls. */
export interface OAIReasoningConfig {
  effort?: ReasoningEffort | null
  summary?: 'auto' | 'none' | null
}

/** Output format and verbosity. */
export interface OAITextConfig {
  format?: { type: 'text' } | { type: 'json_schema'; schema: Record<string, unknown> }
  verbosity?: 'low' | 'medium' | 'high'
}

/**
 * DSH extension: per-session Host tool mask mapped to `agentCtx.tools.restrict()`.
 * Omitted or `null` leaves every Host profile tool visible.
 */
export interface OAIHostToolsConfig {
  /** Keep only these Host tool names (intersect with `deny` when both are set). */
  allow?: string[] | null
  /** Hide these Host tool names from the model and execution. */
  deny?: string[] | null
}

/** One Host tool schema from `GET /agents/tools`. */
export interface OAIHostToolCatalogEntry {
  name: string
  description: string
  parameters: Record<string, unknown>
  source: 'host'
}

/** One entry of `GET /agents/skills`. */
export interface AgentSkill {
  name: string
  description?: string
  /** Where the skill came from: `builtin`, an install source (`upload`, `github`, `editor`, `chat`), or a Host discovery source such as `bundled`. */
  source?: string
  /** `builtin` (Agentry's own), `library` (the owner's), `private` (this agent's), or `bundled` (always on, such as `office-*`). */
  kind: 'builtin' | 'library' | 'private' | 'bundled'
  /** Installed skill id (`library` and `private` only). */
  id?: string
  /** Whether an installed skill includes executable files. */
  has_scripts?: boolean
  /** Whether the session's agent (or the default chat, without `session_id`) uses the skill. */
  enabled: boolean
}

/** Agentry extension: Composio app grants, toolkit slug to `'all'` or exact tool slugs. */
export type AgentAppGrants = Record<string, 'all' | string[]>

/**
 * Agentry extension: which skills a saved agent uses. Absent or `null` uses
 * every built-in; an explicit selection uses exactly the listed built-ins and
 * library skills. The agent's private skills always apply.
 */
export interface AgentSkillSelection {
  /** Built-in skill names. */
  builtin: string[]
  /** Library skill ids (`skill_…`). */
  library: string[]
}

/** One entry of `GET /agents/commands`. */
export interface AgentCommand {
  name: string
  description: string
  /** Placeholder for the free-form text after the name; absent when the command takes none. */
  input_hint?: string
  accepts_attachments: boolean
}

/** Saved or session-local agent configuration. */
export interface OAIAgent {
  id: string
  object: 'agent'
  created_at: number
  updated_at: number
  name: string | null
  instructions: string | null
  model: string
  metadata: Record<string, string>
  tools: OAIToolConfig[]
  /** DSH extension: Host profile tool allow/deny mask. */
  /** Agentry extension: Composio app grants; absent or `null` is unrestricted (legacy `metadata.connectors` still read). */
  apps?: AgentAppGrants | null
  /** Agentry extension: `ask` (default) approves each write on the user's behalf; `auto` does not ask. */
  send_policy?: 'ask' | 'auto' | null
  /** Agentry extension: skill selection; see `AgentSkillSelection`. */
  skills?: AgentSkillSelection | null
  /** Agentry extension: the web browser (Playwright MCP, sandbox chats only); absent or `null` is auto: the browser when the chat's sandbox has it (server default `browser.default`). */
  browser?: boolean | null
  host_tools?: OAIHostToolsConfig | null
  multi_agent?: OAIMultiAgentConfig | null
  reasoning?: OAIReasoningConfig | null
  service_tier?: ServiceTier | null
  text?: OAITextConfig | null
}

/** Body for `POST /v1/agents`. */
export interface CreateAgentParams {
  model: string
  name?: string | null
  instructions?: string | null
  metadata?: Record<string, string> | null
  tools?: OAIToolConfig[] | null
  /** Agentry extension: Composio app grants; absent or `null` is unrestricted (legacy `metadata.connectors` still read). */
  apps?: AgentAppGrants | null
  /** Agentry extension: `ask` (default) approves each write on the user's behalf; `auto` does not ask. */
  send_policy?: 'ask' | 'auto' | null
  /** Agentry extension: skill selection; see `AgentSkillSelection`. */
  skills?: AgentSkillSelection | null
  /** Agentry extension: the web browser (Playwright MCP, sandbox chats only); absent or `null` is auto: the browser when the chat's sandbox has it (server default `browser.default`). */
  browser?: boolean | null
  host_tools?: OAIHostToolsConfig | null
  multi_agent?: OAIMultiAgentConfig | null
  reasoning?: OAIReasoningConfig | null
  service_tier?: ServiceTier | null
  text?: OAITextConfig | null
}

/** Body for `POST /v1/agents/{agent_id}`. Omitted fields keep their saved values. */
export interface UpdateAgentParams {
  model?: string
  name?: string | null
  instructions?: string | null
  metadata?: Record<string, string> | null
  tools?: OAIToolConfig[] | null
  /** Agentry extension: Composio app grants; absent or `null` is unrestricted (legacy `metadata.connectors` still read). */
  apps?: AgentAppGrants | null
  /** Agentry extension: `ask` (default) approves each write on the user's behalf; `auto` does not ask. */
  send_policy?: 'ask' | 'auto' | null
  /** Agentry extension: skill selection; see `AgentSkillSelection`. */
  skills?: AgentSkillSelection | null
  /** Agentry extension: the web browser (Playwright MCP, sandbox chats only); absent or `null` is auto: the browser when the chat's sandbox has it (server default `browser.default`). */
  browser?: boolean | null
  host_tools?: OAIHostToolsConfig | null
  multi_agent?: OAIMultiAgentConfig | null
  reasoning?: OAIReasoningConfig | null
  service_tier?: ServiceTier | null
  text?: OAITextConfig | null
}

/** Self-hosted executor environment. */
export interface OAISelfHostedEnvironment {
  type: 'self_hosted'
  id?: string
  workspace_directory?: string
  capability_directories?: string[]
  remote_url?: string
}

/** No sandbox; the session still requires a Host workspace cwd. */
export interface OAINoneEnvironment {
  type: 'none'
}

/**
 * A hosted environment, as the OpenAI Agents API defines it: an optional
 * `environment_template_id` plus inline template fields (`files`, `env`, `network`,
 * `packages`, `plugins`, `skills`, `setup_commands`, `capability_directories`) and our
 * `provider` and `image` extensions. With a template id or any inline field the gateway
 * provisions an environment through a sandbox provider; a bare `{ type: 'openai_hosted' }`
 * provisions nothing and uses the session's default workspace under the `workspaces` root.
 */
export interface OAIOpenAIHostedEnvironment {
  type: 'openai_hosted'
  environment_template_id?: string
  [field: string]: unknown
}

/** Environment accepted on session create. */
export type OAIEnvironmentConfig =
  | OAINoneEnvironment
  | OAISelfHostedEnvironment
  | OAIOpenAIHostedEnvironment
  | OAILocalEnvironment
  | OAISandboxEnvironment
  | OAISandboxSessionEnvironment

/** Action the application must complete before work can continue. */
export type OAIRequiredAction =
  | {
    type: 'function_call'
    name: string
    arguments: Record<string, unknown>
    turn_id: string
    call_id: string
  }
  | {
    type: 'environment_connection'
    environment_id: string
  }
  | {
    type: 'approval'
    /** Answer with `agent.session.input.approval_response` and this id. */
    id: string
    kind: 'sandbox_escalation' | 'user_question' | 'tool_approval'
    prompt: string
    /** `["approve","deny"]` for an approval; the option labels of a single question, else `[]`. */
    options: string[]
    /** Tool the request is about (approvals only). */
    tool_name?: string
    /** Tool call the request is about, when known (approvals only). */
    call_id?: string
    /** Full question items for a multi-question request (`user_question` only). */
    questions?: AskUserQuestionItem[]
    /** Set when a subagent of this session asked (its Host session id, as in `/subagents`). */
    subagent_id?: string
  }

/** Durable session resource. */
export interface OAIAgentSession {
  id: string
  object: 'agent.session'
  created_at: number
  last_active_at: number
  status: SessionStatus
  error: string | null
  metadata: Record<string, string>
  vault_ids: string[]
  agent: OAIAgent
  environment: OAIEnvironmentConfig
  required_actions: OAIRequiredAction[]
  usage: OAITokenUsage | null
}

/**
 * Resolved session setup stored on the session index row: what a restart needs
 * to rebuild the agent. It holds no conversation content.
 */
export interface SessionConfig {
  agent: OAIAgent
  environment: OAIEnvironmentConfig
  metadata: Record<string, string>
  vault_ids: string[]
}

/**
 * Inline or overlay agent fields on session create.
 * `model` is required when `agent_id` is omitted.
 */
export type SessionAgentParams = Omit<CreateAgentParams, 'model'> & { model?: string }

/** Body for `POST /v1/agents/sessions`. */
export interface CreateSessionParams {
  /** Inline agent configuration, or field overrides when `agent_id` is also set. */
  agent?: SessionAgentParams
  /** Saved agent id from `POST /v1/agents`. */
  agent_id?: string
  environment?: OAIEnvironmentConfig
  metadata?: Record<string, string> | null
  vault_ids?: string[]
  input?: string | OAIInputMessage[]
  stream?: boolean
}

/**
 * Body for `POST /v1/agents/sessions/{session_id}`.
 *
 * Only `model`, `reasoning.effort`, `service_tier`, and `metadata` may change.
 * `agent` and `reasoning` merge supplied fields; `metadata` replaces the map;
 * `metadata_merge` (Agentry) merges keys into it.
 */
export interface UpdateSessionParams {
  agent?: {
    model?: string | null
    reasoning?: { effort?: ReasoningEffort | null }
    service_tier?: ServiceTier | null
  }
  metadata?: Record<string, string> | null
  /**
   * Agentry extension: change single metadata keys without replacing the map.
   * A `null` value deletes the key. Applied after `metadata` when both are sent.
   */
  metadata_merge?: Record<string, string | null>
}

/** One cycle of work inside a session. */
export interface OAITurn {
  id: string
  object: 'agent.session.turn'
  session_id: string
  agent_id: string
  status: TurnStatus
  created_at: number
  started_at?: number | null
  completed_at?: number | null
  subagent_id?: string | null
  error?: { code: string; message: string } | null
  usage?: OAITokenUsage | null
}

/** Text part on a message item. */
export interface OAITextContentPart {
  type: 'input_text' | 'output_text'
  text: string
}

/**
 * File part on a user message item, in the order the user sent it (after the `input_text` part).
 * `file_id` is absent when the file was not uploaded through `POST /agents/files` (or its row is gone); the
 * part then shows name and size only and has no content link.
 */
export interface OAIInputFilePart {
  type: 'input_image' | 'input_file'
  /** Id for `GET /agents/files/{file_id}/content`. */
  file_id?: string
  filename: string
  bytes: number
  media_type: string
  /** Pixel size of the stored image (`input_image` only). */
  width?: number
  height?: number
  /** Internal: DSH attachment id used to resolve `file_id`; removed before items leave the API. */
  attachment_id?: string
}

/** Saved user or assistant message. */
export interface OAIMessageItem {
  id: string
  type: 'message'
  role: 'user' | 'assistant'
  content: Array<OAITextContentPart | OAIInputFilePart>
  phase?: 'commentary' | 'final_answer' | null
  /** `schedule` for a prompt a scheduled task delivered; absent for messages the client sent. */
  source?: 'schedule'
  /** Task that delivered the message, when exactly one did. */
  schedule_id?: string
  status: ItemStatus
  turn_id: string
  /** Agentry extension: the assistant step (1-based within its turn) that produced it. */
  step?: number
  /** Agentry extension: token usage of the assistant step, when the provider reported it. */
  usage?: OAITokenUsage
  /** Agentry extension: see `OAIItemTiming`. */
  timing?: OAIItemTiming
}

/**
 * Agentry extension: when the Session log recorded an item, in epoch
 * milliseconds. Each field is present only when the log has it: a running
 * tool call has no `completed_at_ms` yet.
 */
export interface OAIItemTiming {
  /** An assistant step: when the step started (its request was sent); a tool call: when it was called. */
  started_at_ms?: number
  /** An assistant step: its first streamed token. */
  first_token_at_ms?: number
  /** When the item was finished: the reply settled, the tool answered, the message was logged. */
  completed_at_ms?: number
}

/** Saved function call. */
export interface OAIFunctionCallItem {
  id: string
  type: 'function_call'
  name: string
  call_id: string
  arguments: Record<string, unknown> | string
  status: ToolCallStatus
  turn_id: string
  /** Agentry extension: the assistant step that called it. */
  step?: number
  /** Agentry extension: see `OAIItemTiming`. */
  timing?: OAIItemTiming
}

/** Saved function-call result. */
export interface OAIFunctionCallOutputItem {
  id: string
  type: 'function_call_output'
  call_id: string
  output: string
  error?: string | null
  status: ToolCallStatus
  turn_id: string
  /** Agentry extension: a sign-in link for a connected app found in the output; clients show a Connect button. */
  connect_request?: ConnectRequest
  /** Agentry extension: images the tool returned (screenshots, `read_image`), in order; absent when there are none. */
  images?: OAIOutputImagePart[]
  /** Agentry extension: see `OAIItemTiming`. */
  timing?: OAIItemTiming
}

/** Agentry extension: one image a tool returned, served by `GET /agents/files/{file_id}/content`. */
export interface OAIOutputImagePart {
  type: 'output_image'
  /** Id for `GET /agents/files/{file_id}/content`; the same in live and replayed items. */
  file_id?: string
  /** Display name, when the tool gave one. */
  filename?: string
  media_type: string
  bytes: number
  /** Pixel size of the stored image. */
  width?: number
  height?: number
}

/** Saved MCP tool call. */
export interface OAIMcpCallItem {
  id: string
  type: 'mcp_call'
  server_label: string
  name: string
  arguments: Record<string, unknown>
  output?: unknown
  error?: string | null
  status: ToolCallStatus
  turn_id: string
}

/** Saved shell or terminal command. */
export interface OAICommandExecutionItem {
  id: string
  type: 'command_execution'
  command: string
  cwd?: string
  exit_code?: number
  output?: string
  duration_ms?: number
  status: ToolCallStatus
  turn_id: string
  /** Agentry extension: the assistant step that called it. */
  step?: number
  /** Agentry extension: see `OAIItemTiming`. */
  timing?: OAIItemTiming
}

/**
 * Saved result of a Host slash command (`/compact`, `/goal`, ...). Human-only
 * output: it never reaches the model. A command that ran between turns has
 * `turn_id: null`.
 */
export interface OAISlashCommandItem {
  /** `item_cmd_<seq of the command's run event>`. */
  id: string
  type: 'slash_command'
  /** Pairs the command's `command/run` and `command/done` log events. */
  command_id: string
  /** Command name without the leading slash. */
  name: string
  /** Text after the name, when the command recorded it. */
  args?: string
  /** `completed` for a success result, `failed` for an error result. */
  status: 'completed' | 'failed'
  /** The handler's output or error text. */
  text?: string
  /** Turn the command ran inside, or `null` when it ran between turns. */
  turn_id: string | null
}

/** Saved reasoning summary. */
export interface OAIReasoningItem {
  id: string
  type: 'reasoning'
  summary?: Array<{ type: 'summary_text'; text: string }>
  status: ItemStatus
  turn_id: string
  /** Agentry extension: the assistant step that produced it. */
  step?: number
  /** Agentry extension: see `OAIItemTiming`. */
  timing?: OAIItemTiming
}

/** One saved session item. */
export type OAISessionItem =
  | OAIMessageItem
  | OAIFunctionCallItem
  | OAIFunctionCallOutputItem
  | OAIMcpCallItem
  | OAICommandExecutionItem
  | OAIReasoningItem
  | OAISlashCommandItem

/** User, assistant, or system input message. */
export interface OAIInputMessage {
  role: 'user' | 'assistant' | 'system'
  content?: OAIInputPart[]
}

/**
 * One input part. `input_text` carries `text`. `input_image` and `input_file` carry `file_id` of a file uploaded with
 * `POST /agents/files`; `image_url`, `file_data`, and `file_url` are rejected with 400 `unsupported_content_part`.
 */
export interface OAIInputPart {
  type: string
  text?: string
  /** Id of a staged file (`input_image`, `input_file`). */
  file_id?: string
  /** Accepted by OpenAI, rejected here. */
  image_url?: unknown
  /** Accepted by OpenAI, rejected here. */
  file_data?: unknown
  /** Accepted by OpenAI, rejected here. */
  file_url?: unknown
  /** Ignored; the stored name is used. */
  filename?: string
  /** Ignored. */
  detail?: string
}

/** Submit a follow-up or steering message. */
export interface OAISendMessageInputEvent {
  type: 'agent.session.input.message'
  input: OAIInputMessage[]
  /** Switch the session model from the next model step, before this message is queued. */
  model?: string
  /** Switch the reasoning effort from the next model step; with `model` omitted the current model is kept. */
  reasoning?: { effort?: ReasoningEffort | null }
}

/** Answer a pending `approval` required action. */
export interface OAIApprovalResponseInputEvent {
  type: 'agent.session.input.approval_response'
  /** `id` of the `approval` required action. */
  id: string
  decision: 'approve' | 'deny' | 'answer'
  /** For `answer`: `{ selected, custom? }` (one question) or `{ answers: [{ id, selected, custom? }] }`. */
  payload?: unknown
}

/** Cancel the active turn. */
export interface OAICancelInputEvent {
  type: 'agent.session.input.cancel'
}

/** Return a custom function result (legacy Agents API input name). */
export interface OAIFunctionCallOutputInputEvent {
  type: 'agent.session.input.function_call_output'
  turn_id?: string
  call_id: string
  output: unknown
}

/**
 * Return a custom function result (current Agents API input name).
 *
 * Official docs: https://developers.openai.com/api/docs/guides/agents-api/tools/functions
 */
export type OAIToolResultInputEvent =
  | {
    type: 'agent.session.input.tool_result'
    turn_id: string
    call_id: string
    success: true
    output: unknown
  }
  | {
    type: 'agent.session.input.tool_result'
    turn_id: string
    call_id: string
    success: false
    error: string
  }

/** Input event accepted by `POST /v1/agents/sessions/{session_id}/events`. */
export type OAIInputEvent =
  | OAISendMessageInputEvent
  | OAICancelInputEvent
  | OAIFunctionCallOutputInputEvent
  | OAIToolResultInputEvent
  | OAIApprovalResponseInputEvent

/** Body for `POST /v1/agents/sessions/{session_id}/events`. */
export interface PostSessionEventsBody {
  events?: OAIInputEvent[]
}

/** Output event written on the session SSE stream. */
export type OAISessionEvent =
  | { type: 'agent.session.created'; event_id: string; session: OAIAgentSession }
  | { type: 'agent.session.idle'; event_id: string; session: OAIAgentSession }
  | { type: 'agent.session.in_progress'; event_id: string; session: OAIAgentSession }
  | { type: 'agent.session.requires_action'; event_id: string; session: OAIAgentSession }
  | { type: 'agent.session.failed'; event_id: string; session: OAIAgentSession }
  | { type: 'agent.session.turn.created'; event_id: string; session_id: string; turn: OAITurn }
  | { type: 'agent.session.turn.in_progress'; event_id: string; session_id: string; turn: OAITurn }
  | { type: 'agent.session.turn.completed'; event_id: string; session_id: string; turn_id: string; turn: OAITurn; usage?: OAITokenUsage | null }
  | { type: 'agent.session.turn.failed'; event_id: string; session_id: string; turn_id: string; turn: OAITurn; usage?: OAITokenUsage | null }
  | { type: 'agent.session.turn.cancelled'; event_id: string; session_id: string; turn_id: string; turn: OAITurn; usage?: OAITokenUsage | null }
  | { type: 'agent.session.turn.item.added'; event_id: string; session_id: string; turn_id: string; item: OAISessionItem }
  | { type: 'agent.session.turn.item.done'; event_id: string; session_id: string; turn_id: string; item: OAISessionItem }
  | { type: 'agent.session.item.done'; event_id: string; session_id: string; turn_id: string | null; item: OAISlashCommandItem }
  | { type: 'agent.session.turn.output_text.delta'; event_id: string; item_id: string; output_index: number; content_index: number; session_id: string; turn_id: string; delta: string }
  | { type: 'agent.session.turn.output_text.done'; event_id: string; item_id: string; output_index: number; content_index: number; session_id: string; turn_id: string; text: string }
  | { type: 'error'; event_id: string; session_id?: string; error: { message: string; type?: string; code?: string } }
  | { type: 'agent.session.subagent.created'; event_id: string; session_id: string; subagent: OAISubagent }
  | { type: 'agent.session.subagent.updated'; event_id: string; session_id: string; subagent: OAISubagent; turn: OAITurn }
  | { type: 'agent.session.subagent.closed'; event_id: string; session_id: string; subagent: OAISubagent }
  | { type: 'agent.session.subagent.item.added'; event_id: string; session_id: string; subagent_id: string; turn_id: string; item: OAISessionItem & { subagent_id: string } }
  | { type: 'agent.session.subagent.item.done'; event_id: string; session_id: string; subagent_id: string; turn_id: string; item: OAISessionItem & { subagent_id: string } }

/** A Host child session observed under an Agents API session (`/subagents`). Turns and items stay on their own routes. */
export interface OAISubagent {
  id: string
  object: 'agent.session.subagent'
  session_id: string
  parent_session_id: string
  status: 'active' | 'closed'
  created_at: number
  closed_at?: number
  /** Model of the subagent's latest model request, from its Session log; `null` before its first request. */
  model: string | null
}

/** Local calendar time of an `at` timing. */
export interface ScheduleLocalAt {
  /** Four-digit ISO calendar date. */
  date: string
  /** Local wall-clock time `HH:mm[:ss[.SSS]]`. */
  time: string
  /** Explicit UTC or IANA zone. */
  time_zone: string
}

/**
 * When a scheduled task runs: DSH's tagged union, one member per `kind`. Input
 * and output use the same members; reads echo `at` as the UTC instant and
 * normalize `time` to `HH:mm:ss.SSS`.
 */
export type ScheduleTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | ScheduleLocalAt }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string }

/** Lifecycle of a scheduled task. */
export type ScheduleStatus = 'active' | 'paused' | 'ended'

/** One delivery of a scheduled task into its session: an inbox receipt, not model completion. */
export interface AgentScheduleRun {
  /** UTC instant of the occurrence that was delivered. */
  scheduled_at: string
  /** UTC instant the session durably accepted the message. */
  delivered_at: string
  /** Id of the delivered message. */
  message_id: string
  /** Session that accepted the message. */
  session_id: string
}

/** A scheduled task (`/v1/agents/schedules`). */
export interface AgentSchedule {
  id: string
  object: 'agent.schedule'
  title: string
  prompt: string
  timing: ScheduleTiming
  status: ScheduleStatus
  /** UTC instant of the next occurrence; `null` unless `status` is `active`. */
  next_run_at: string | null
  created_at: string
  updated_at: string
  /** Equals `updated_at`; send it back as `revision` to detect a concurrent edit. */
  revision: string
  /** Session that receives each run. */
  session_id: string
  /** A run is queued or executing in the session. */
  running: boolean
  last_run: AgentScheduleRun | null
}

/** Body of `POST /v1/agents/schedules`. */
export interface CreateScheduleParams {
  title: string
  prompt: string
  timing: ScheduleTiming
  /** Existing own session to deliver to; `agent_id`, `agent`, and `environment` are then ignored. */
  session_id?: string
  agent_id?: string
  agent?: SessionAgentParams
  environment?: OAIEnvironmentConfig
}

/** Body of `POST /v1/agents/schedules/{schedule_id}`. */
export interface UpdateScheduleParams {
  title?: string
  prompt?: string
  timing?: ScheduleTiming
  /** `revision` the client read; a different stored value answers 409 `schedule_conflict`. */
  revision?: string
}
