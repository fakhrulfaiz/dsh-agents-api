/**
 * OpenAI Agents API wire types (`OpenAI-Beta: agents=v1`).
 *
 * Defined locally so this package has no runtime dependency on the OpenAI SDK.
 *
 * Reference: https://developers.openai.com/api/docs/guides/agents-api
 */

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

/** MCP server connection declared on an agent. */
export interface OAIMcpTool {
  type: 'mcp'
  server_label: string
  transport: {
    type: 'http' | 'stdio'
    server_url?: string
  }
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
 * OpenAI-hosted sandbox. This gateway cannot provision that sandbox; it uses
 * the Host process cwd instead.
 */
export interface OAIOpenAIHostedEnvironment {
  type: 'openai_hosted'
}

/** Environment accepted on session create. */
export type OAIEnvironmentConfig =
  | OAINoneEnvironment
  | OAISelfHostedEnvironment
  | OAIOpenAIHostedEnvironment

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
 * `agent` and `reasoning` merge supplied fields; `metadata` replaces the map.
 */
export interface UpdateSessionParams {
  agent?: {
    model?: string | null
    reasoning?: { effort?: ReasoningEffort | null }
    service_tier?: ServiceTier | null
  }
  metadata?: Record<string, string> | null
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

/** Saved user or assistant message. */
export interface OAIMessageItem {
  id: string
  type: 'message'
  role: 'user' | 'assistant'
  content: OAITextContentPart[]
  phase?: 'commentary' | 'final_answer' | null
  status: ItemStatus
  turn_id: string
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
}

/** Saved reasoning summary. */
export interface OAIReasoningItem {
  id: string
  type: 'reasoning'
  summary?: Array<{ type: 'summary_text'; text: string }>
  status: ItemStatus
  turn_id: string
}

/** One saved session item. */
export type OAISessionItem =
  | OAIMessageItem
  | OAIFunctionCallItem
  | OAIFunctionCallOutputItem
  | OAIMcpCallItem
  | OAICommandExecutionItem
  | OAIReasoningItem

/** User, assistant, or system input message. */
export interface OAIInputMessage {
  role: 'user' | 'assistant' | 'system'
  content?: Array<{ type: string; text?: string }>
}

/** Submit a follow-up or steering message. */
export interface OAISendMessageInputEvent {
  type: 'agent.session.input.message'
  input: OAIInputMessage[]
}

/** Cancel the active turn. */
export interface OAICancelInputEvent {
  type: 'agent.session.input.cancel'
}

/** Return a custom function result. */
export interface OAIFunctionCallOutputInputEvent {
  type: 'agent.session.input.function_call_output'
  turn_id?: string
  call_id: string
  output: unknown
}

/** Input event accepted by `POST /v1/agents/sessions/{session_id}/events`. */
export type OAIInputEvent =
  | OAISendMessageInputEvent
  | OAICancelInputEvent
  | OAIFunctionCallOutputInputEvent

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
  | { type: 'agent.session.turn.output_text.delta'; event_id: string; item_id: string; output_index: number; content_index: number; session_id: string; turn_id: string; delta: string }
  | { type: 'agent.session.turn.output_text.done'; event_id: string; item_id: string; output_index: number; content_index: number; session_id: string; turn_id: string; text: string }
  | { type: 'error'; event_id: string; session_id?: string; error: { message: string; type?: string; code?: string } }
