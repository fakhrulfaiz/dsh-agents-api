/**
 * HTTP dispatcher for the OpenAI Agents API.
 *
 * Route order is load-bearing: `/agents/sessions`, `/agents/tools`, `/agents/skills`,
 * `/agents/commands`, `/agents/schedules`, and `/agents/files` are matched before
 * `/agents/:agent_id` so those literal segments are never captured as an agent id.
 */

import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { ScheduleService } from '@deepseek-ai/dsh-schedule'
import type { SkillProvider, SkillProviderControl, SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { materializeAgent, updatedAgent } from './agent-records.ts'
import { mintEventId } from './bridge.ts'
import type { ApprovalBridge } from './approvals/approval-bridge.ts'
import { AgentsApiRequestError, SessionCreateError } from './errors.ts'
import {
  badRequest,
  errorMessage,
  json,
  listQuery,
  matchRoute,
  metadataFilter,
  normalizePath,
  notFound,
  paginate,
  readBody,
  routeParam,
  writeRequestError,
} from './http.ts'
import { fileIdsFromInput, overlayAgent, parseApprovalResponse, userTextFromInput } from './input.ts'
import { applyHostToolsRestrict, validateHostTools } from './host-tools.ts'
import { mountAgentInstructions } from './mount-instructions.ts'
import { AGENTRY_PRESET_ID } from './preset.ts'
import { copyIntoSandboxUploads, MAX_ARTIFACT_BYTES, providerRows, type AgentrySandboxProvider } from './sandbox/agentry-sandbox-provider.ts'
import { sandboxStartErrorIn, type SandboxPresets } from './sandbox/presets.ts'
import { SandboxApiError } from '@agentry/sandbox/client'
import { createAgentrySkillProvider, SkillInvalidations } from './skills/provider.ts'
import { sweepStaged, type InstallDeps } from './skills/install.ts'
import { SkillInstallApi } from './skills/routes.ts'
import { builtinTemplate, BUILTIN_TEMPLATES, isBuiltinTemplateId } from './environment/builtin-templates.ts'
import { TerminalError, TerminalHub } from './sandbox/terminals.ts'
import { forgetWorkspaceAlias, workspaceOf } from './sandbox/workspace-alias.ts'
import { DeliverablesCache } from './history/deliverables-cache.ts'
import type { DeliverableEntry } from './history/deliverables.ts'
import { mountSkillTools } from './skills/tools.ts'
import { effectiveGrants, validateAppGrants } from './composio-grants.ts'
import { DEFAULT_APPROVAL_VERBS, mountComposio } from './mount-composio.ts'
import type { GithubDeps } from './skills/github.ts'
import { resolveAgentSkills, validateSkillSelection, type BuiltinSkill } from './skills/resolve.ts'
import { mountAgentTools } from './mount-agent-tools.ts'
import { mountSandboxTools } from './mount-sandbox-tools.ts'
import { mountComposioAppTools } from './mount-composio-app-tools.ts'
import { mountScheduleGuidance } from './mount-schedule-guidance.ts'
import { mountFunctionTools, validateMountableTools } from './mount-function-tools.ts'
import { AgentsApiMcpConfigError, mcpToolsFrom, mountMcpTools } from './mount-mcp-tools.ts'
import { PendingFunctionCalls } from './pending-function-calls.ts'
import { ScheduleApi } from './schedules.ts'
import { slashCommandItem } from './items.ts'
import { COMMAND_NAME, CommandsApi, commandNotFound, type CommandService, type CommandTarget } from './commands.ts'
import { withFileIds } from './files/item-parts.ts'
import { openAttached, type AttachmentsPort } from './files/attached.ts'
import { AttachmentIngest, type AttachedFiles } from './files/ingest.ts'
import { FilesApi, uploadedFileSource, type FilesRuntime } from './files/api.ts'
import { SkillsApi, type SkillTarget } from './skills.ts'
import { SessionRegistry } from './session-registry.ts'
import { WireProjector, type ProjectionBase } from './history/projector.ts'
import type { SessionHistory } from './history/session-history.ts'
import { NO_STORED_CONFIG } from './recovery.ts'
import { findMaskedSecret, MASKED_SECRET, redactAgentSecrets } from './redact.ts'
import { applySessionUpdate, baseOf, configOf, sessionFromRow } from './session-resource.ts'
import { writeEvent, writeSSEHeaders } from './sse.ts'
import type { ArtifactS3Config } from './artifacts.ts'
import { artifactContentDisposition, artifactContentType, getS3Artifact, getWorkspaceArtifact, listS3Artifacts, listWorkspaceArtifacts, sanitizeRelativePath } from './artifacts.ts'
import { directorySegment } from './environment/local.ts'
import type { CreateEnvironmentInput } from './environment/provider.ts'
import { readRuntimeInfo } from './environment/runtime-info.ts'
import { toSdkEnvironment, type SdkEnvironment } from './environment/environment-compat.ts'
import { absoluteFilePath, parseFileListQuery, parseFileWrite, selectFilePage, type SdkEnvironmentFile } from './environment/file-compat.ts'
import { normalizeTemplateConfig, parseTemplateInput, toSdkTemplate, unsupportedFields } from './environment/template-compat.ts'
import type { SandboxProvider } from './sandbox/contract.ts'
import type { SandboxRegistry } from './sandbox/registry.ts'
import type { EnvironmentRecord, EnvironmentStatus, EnvironmentTemplate, EnvironmentTemplateConfig, OAISandboxEnvironment } from './environment-types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentState } from './session-registry.ts'
import {
  StoreUnavailableError,
  encodeSessionCursor,
  guardStore,
  type SessionIndexRow,
  type Store,
} from './store/store.ts'
import type {
  CreateAgentParams,
  CreateSessionParams,
  OAIAgent,
  OAIAgentSession,
  OAIEnvironmentConfig,
  OAIFunctionTool,
  OAIHostToolsConfig,
  OAIInputEvent,
  OAIOpenAIHostedEnvironment,
  OAIRequiredAction,
  OAISessionEvent,
  OAIToolResultInputEvent,
  SessionConfig,
  SessionStatus,
  UpdateAgentParams,
  UpdateSessionParams,
} from './types.ts'

import { requireAnyRole } from './auth/authenticator.ts'
import type { AuthResult, Authenticator, OwnerId, Principal } from './auth/authenticator.ts'

export interface Route {
  method: string
  pattern: string
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    params: Record<string, string>,
    principal: Principal,
  ) => Promise<void>
}

/** Backends wired by plugin apply. */
export interface GatewayOptions {
  /** Sandbox providers for `/agents/environments`, by name, with a default. */
  sandboxes: SandboxRegistry
  /** Per-sandbox agent presets; sessions on Agentry Sandbox environments mount theirs. Absent: such sessions cannot start. */
  sandboxPresets?: SandboxPresets
  /** Root of `<owner>/<session>/` default session workspaces. */
  workspacesRoot: string
  /** The bundled runtime payload's `runtime.json`, for `GET /agents/environments/runtimes`; absent means none. */
  runtimeInfoPath?: string
  /** Reads items, turns, and wire events from the Session log. */
  history: SessionHistory
  /** Pending approvals and questions; the gateway answers, cancels, and deletes through it. */
  approvals: ApprovalBridge
  /** The Host schedule service when the profile provides one, read at call time. */
  schedule: () => ScheduleService | undefined
  /** The Host skill registry when the profile provides one, read at call time. */
  skills: () => { list: (options?: SkillViewOptions) => Promise<readonly SkillSummary[]> } | undefined
  /** Milliseconds the skill catalog is cached (`skills.cacheTtlSeconds` * 1000). */
  skillsTtlMs: number
  /** The Host command registry when the profile provides one, read at call time. */
  commands: () => CommandService | undefined
  /** Milliseconds the command catalog is cached (`commands.cacheTtlSeconds` * 1000). */
  commandsTtlMs: number
  /** Slash commands Agentry exposes (`commands.allow`); `undefined` exposes every Host command. */
  commandsAllow?: readonly string[]
  /** Agentry's built-in skills, loaded at plugin start; absent means none. */
  builtinSkills?: () => readonly BuiltinSkill[]
  /** Folder of installed skills (`skills.dir`); absent disables the Agentry skill provider's installed skills. */
  skillsRoot?: string
  /** Composio grant enforcement and send approvals (`composio` config). */
  composio?: { serverLabel: string; approvalVerbs: readonly string[]; approvalSlugs: readonly string[] }
  /** GitHub endpoints for skill imports (tests point it at a fake). */
  skillsGithub?: GithubDeps
  /** Host skill discovery sources hidden from the catalog (developer folders). */
  skillsHiddenSources?: readonly string[]
  artifacts?: ArtifactS3Config
  /** Staging bytes and limits for `/agents/files`; absent when `uploads.dir` is not configured (uploads answer 501). */
  files?: FilesRuntime
  /** The DSH attachment service when the profile provides one, read at call time. */
  attachments?: () => AttachmentsPort | undefined
}

/** A session created by `provisionSession`: projector registered, agent live, index row written, no turn started. */
export interface ProvisionedSession {
  /** New session id. */
  sessionId: SessionId
  /** Live projector registered in the session registry. */
  projector: WireProjector
  /** Projection base the projector was built from. */
  base: ProjectionBase
  /** Resolved session agent. */
  resolved: OAIAgent
}

/**
 * Request dispatcher registered on `ctx.webServer`.
 *
 * Every agent, template, environment, and session read and write is scoped
 * to the authenticated owner; another owner's record answers 404. Until a
 * store is attached, and after a store call rejects, routes answer 503
 * `store_unavailable`.
 */
export class AgentsGateway {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly pendingBySession = new Map<string, PendingFunctionCalls>()
  /** Tail of each session's status writes, so writes land in the order the statuses were produced. */
  private readonly statusWrites = new Map<string, Promise<void>>()
  /** Resumes in flight, so two requests do not resume one session twice. */
  private readonly resuming = new Map<string, Promise<void>>()
  private readonly sandboxes: SandboxRegistry
  private readonly sandboxPresets: SandboxPresets | undefined
  private readonly runtimeInfoPath: string | undefined
  private readonly workspacesRoot: string
  private readonly history: SessionHistory
  private readonly approvals: ApprovalBridge
  private readonly schedule: () => ScheduleService | undefined
  private readonly artifacts: ArtifactS3Config | undefined
  private readonly routes: Route[]
  /** Agentry built-in skills. */
  private readonly builtinSkills: () => readonly BuiltinSkill[]
  /** Installed-skills folder. */
  private readonly skillsRoot: string
  private readonly skillInstallApi: SkillInstallApi
  /** Deliverables per session, reused until the session changes. */
  private readonly terminals = new TerminalHub()
  private readonly deliverablesCache = new DeliverablesCache<DeliverableEntry>(500)
  private readonly skillsGithub: GithubDeps | undefined
  private readonly composio: { serverLabel: string; approvalVerbs: readonly string[]; approvalSlugs: readonly string[] }
  /** Refresh hooks of live sessions' Agentry skill providers, by owner. */
  readonly skillInvalidations = new SkillInvalidations()
  /** Commands Agentry exposes; `undefined` exposes all. */
  private readonly commandsAllow: ReadonlySet<string> | undefined
  private readonly commandsApi: CommandsApi
  private readonly ingest: AttachmentIngest
  private readonly commands: () => CommandService | undefined
  /** Sessions with a command executing, so a second one is refused instead of interleaving. */
  private readonly commandsRunning = new Set<string>()
  #store: Store | undefined
  #storeError: string | undefined
  /** Owners whose `owners` row this store already holds. */
  readonly #knownOwners = new Set<OwnerId>()

  /**
   * @param ctx - plugin context with `webServer`, `sessions`, and `agents`.
   * @param authenticator - resolves the caller of every request under the prefix.
   * @param prefix - URL prefix, default `/v1`.
   * @param store - durable records, or `undefined` until `attachStore`.
   * @param sessionRegistry - live session directory.
   * @param options - environment provider and optional workspace and artifact backends.
   */
  constructor(
    private readonly ctx: Context,
    private readonly authenticator: Authenticator,
    private readonly prefix: string,
    store: Store | undefined,
    private readonly sessionRegistry: SessionRegistry,
    options: GatewayOptions,
  ) {
    if (store !== undefined) this.attachStore(store)
    this.sandboxes = options.sandboxes
    this.sandboxPresets = options.sandboxPresets
    this.runtimeInfoPath = options.runtimeInfoPath
    this.workspacesRoot = options.workspacesRoot
    this.history = options.history
    this.approvals = options.approvals
    this.schedule = options.schedule
    this.artifacts = options.artifacts
    const scheduleApi = new ScheduleApi({
      schedule: options.schedule,
      store: () => this.store,
      createSession: (owner, params) => this.createIdleSession(owner, params),
      discardSession: (owner, sessionId) => this.discardSession(owner, sessionId),
      warn: message => this.ctx.logger.warn(message),
    })
    this.builtinSkills = options.builtinSkills ?? (() => [])
    this.skillsRoot = options.skillsRoot ?? ''
    this.skillsGithub = options.skillsGithub
    this.composio = options.composio ?? { serverLabel: 'composio', approvalVerbs: DEFAULT_APPROVAL_VERBS, approvalSlugs: [] }
    this.skillInstallApi = new SkillInstallApi(this.installDeps(), options.skillsGithub)
    const skillsApi = new SkillsApi({
      skills: options.skills,
      resolveTarget: (owner, sessionId) => this.resolveSkillTarget(owner, sessionId),
      ttlMs: options.skillsTtlMs,
      warn: message => this.ctx.logger.warn(message),
      ...(options.skillsHiddenSources ? { hiddenSources: new Set(options.skillsHiddenSources) } : {}),
      installed: owner => this.store.skills.list(owner, { status: 'active' }),
      defaultChat: async (owner) => {
        const resolved = await resolveAgentSkills({ agent: undefined, owner, store: this.store, builtins: this.builtinSkills() })
        return [
          ...resolved.builtins.map(b => ({ name: b.name, description: b.description, source: 'builtin', kind: 'builtin' as const, enabled: true })),
          ...resolved.installed.map(r => ({ name: r.name, description: r.description, source: r.source, kind: 'library' as const, id: r.id, has_scripts: r.has_scripts, enabled: true })),
        ]
      },
    })
    this.commands = options.commands
    this.commandsAllow = options.commandsAllow ? new Set(options.commandsAllow) : undefined
    this.commandsApi = new CommandsApi({
      commands: options.commands,
      resolveTarget: (owner, sessionId) => this.resolveCommandTarget(owner, sessionId),
      ttlMs: options.commandsTtlMs,
      ...(this.commandsAllow ? { allow: this.commandsAllow } : {}),
      warn: message => this.ctx.logger.warn(message),
    })
    const attachments = options.attachments ?? (() => undefined)
    this.ingest = new AttachmentIngest({
      store: () => this.store,
      staging: options.files?.staging,
      limits: options.files?.limits ?? { maxFileBytes: 0, maxFilesPerMessage: 0, maxMessageBytes: 0, maxStagedBytesPerOwner: 0, allowedMediaTypes: [] },
      attachments,
      warn: message => this.ctx.logger.warn(message),
    })
    const filesApi = new FilesApi({
      store: () => this.store,
      runtime: options.files,
      sources: [uploadedFileSource({
        store: () => this.store,
        staging: options.files?.staging,
        attached: row => openAttached(row, attachments()),
      })],
      warn: message => this.ctx.logger.warn(message),
    })
    this.routes = [
      { method: 'POST', pattern: '/agents', handler: (req, res, _url, _params, p) => this.createAgent(req, res, p.owner) },
      { method: 'GET', pattern: '/agents', handler: (_req, res, url, _params, p) => this.listAgents(res, url, p.owner) },
      { method: 'GET', pattern: '/agents/tools', handler: (_req, res, url, _params, p) => this.listHostTools(res, url, p.owner) },
      { method: 'POST', pattern: '/agents/environments/templates', handler: (req, res, _url, _params, p) => this.createTemplate(req, res, p.owner) },
      { method: 'GET', pattern: '/agents/environments/templates', handler: (_req, res, url, _params, p) => this.listTemplates(res, url, p.owner) },
      { method: 'GET', pattern: '/agents/environments/templates/:template_id', handler: (_req, res, _url, params, p) => this.getTemplate(res, params, p.owner) },
      { method: 'POST', pattern: '/agents/environments/templates/:template_id', handler: (req, res, _url, params, p) => this.updateTemplate(req, res, params, p.owner) },
      { method: 'DELETE', pattern: '/agents/environments/templates/:template_id', handler: (_req, res, _url, params, p) => this.deleteTemplate(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/environments/runtimes', handler: async (_req, res) => { json(res, 200, await readRuntimeInfo(this.runtimeInfoPath)) } },
      { method: 'GET', pattern: '/agents/environments/providers', handler: async (_req, res) => { json(res, 200, { object: 'list', data: await providerRows(this.sandboxes) }) } },
      { method: 'POST', pattern: '/agents/environments', handler: (req, res, _url, _params, p) => this.createEnvironment(req, res, p.owner) },
      { method: 'GET', pattern: '/agents/environments', handler: (_req, res, url, _params, p) => this.listEnvironments(res, url, p.owner) },
      { method: 'POST', pattern: '/agents/environments/:environment_id/files', handler: (req, res, _url, params, p) => this.writeEnvironmentFile(req, res, params, p.owner) },
      { method: 'GET', pattern: '/agents/environments/:environment_id/files/*path', handler: (_req, res, _url, params, p) => this.readEnvironmentFile(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/environments/:environment_id/files', handler: (_req, res, url, params, p) => this.listEnvironmentFiles(res, url, params, p.owner) },
      { method: 'POST', pattern: '/agents/environments/:environment_id/start', handler: (req, res, _url, params, p) => this.environmentAction(req, res, params, p.owner, 'start') },
      { method: 'POST', pattern: '/agents/environments/:environment_id/stop', handler: (req, res, _url, params, p) => this.environmentAction(req, res, params, p.owner, 'stop') },
      { method: 'POST', pattern: '/agents/environments/:environment_id/reset', handler: (req, res, _url, params, p) => this.environmentAction(req, res, params, p.owner, 'reset') },
      { method: 'POST', pattern: '/agents/environments/:environment_id/terminals', handler: (req, res, _url, params, p) => this.openTerminal(req, res, params, p.owner) },
      { method: 'GET', pattern: '/agents/environments/:environment_id/terminals/:terminal_id/stream', handler: (req, res, _url, params, p) => this.streamTerminal(req, res, params, p.owner) },
      { method: 'POST', pattern: '/agents/environments/:environment_id/terminals/:terminal_id/input', handler: (req, res, _url, params, p) => this.terminalCall(req, res, params, p.owner, 'input') },
      { method: 'POST', pattern: '/agents/environments/:environment_id/terminals/:terminal_id/resize', handler: (req, res, _url, params, p) => this.terminalCall(req, res, params, p.owner, 'resize') },
      { method: 'DELETE', pattern: '/agents/environments/:environment_id/terminals/:terminal_id', handler: (_req, res, _url, params, p) => this.terminalCall(undefined, res, params, p.owner, 'close') },
      { method: 'GET', pattern: '/agents/environments/:environment_id', handler: (_req, res, _url, params, p) => this.getEnvironment(res, params, p.owner) },
      { method: 'DELETE', pattern: '/agents/environments/:environment_id', handler: (_req, res, _url, params, p) => this.deleteEnvironment(res, params, p.owner) },
      { method: 'POST', pattern: '/agents/sessions', handler: (req, res, url, _params, p) => this.createSession(req, res, url, p.owner) },
      { method: 'GET', pattern: '/agents/sessions', handler: (_req, res, url, _params, p) => this.listSessions(res, url, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/artifacts/*path', handler: (_req, res, url, params, p) => this.getArtifact(res, params, p.owner, url.searchParams.get('download') === '1') },
      { method: 'GET', pattern: '/agents/sessions/:session_id/deliverables', handler: (_req, res, _url, params, p) => this.listDeliverables(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/artifacts', handler: (_req, res, _url, params, p) => this.listArtifacts(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id/items', handler: (_req, res, _url, params, p) => this.listSubagentTurnItems(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns/:turn_id', handler: (_req, res, _url, params, p) => this.getSubagentTurn(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/turns', handler: (_req, res, _url, params, p) => this.listSubagentTurns(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id/items', handler: (_req, res, _url, params, p) => this.listSubagentItems(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents/:subagent_id', handler: (_req, res, _url, params, p) => this.getSubagent(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/subagents', handler: (_req, res, _url, params, p) => this.listSubagents(res, params, p.owner) },
      { method: 'POST', pattern: '/agents/sessions/:session_id/commands/:name', handler: (req, res, _url, params, p) => this.runCommand(req, res, params, p.owner) },
      { method: 'POST', pattern: '/agents/sessions/:session_id/events', handler: (req, res, _url, params, p) => this.postEvents(req, res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/events', handler: (req, res, _url, params, p) => this.streamEvents(req, res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/items', handler: (_req, res, url, params, p) => this.listItems(res, url, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns/:turn_id', handler: (_req, res, _url, params, p) => this.getTurn(res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id/turns', handler: (_req, res, url, params, p) => this.listTurns(res, url, params, p.owner) },
      { method: 'POST', pattern: '/agents/sessions/:session_id', handler: (req, res, _url, params, p) => this.updateSession(req, res, params, p.owner) },
      { method: 'GET', pattern: '/agents/sessions/:session_id', handler: (_req, res, _url, params, p) => this.getSession(res, params, p.owner) },
      { method: 'DELETE', pattern: '/agents/sessions/:session_id', handler: (_req, res, _url, params, p) => this.deleteSession(res, params, p.owner) },
      ...scheduleApi.routes(),
      ...this.skillInstallApi.routes(),
      ...skillsApi.routes(),
      ...this.commandsApi.routes(),
      ...filesApi.routes(),
      { method: 'GET', pattern: '/agents/:agent_id', handler: (_req, res, _url, params, p) => this.getAgent(res, params, p.owner) },
      { method: 'POST', pattern: '/agents/:agent_id', handler: (req, res, _url, params, p) => this.updateAgent(req, res, params, p.owner) },
      { method: 'DELETE', pattern: '/agents/:agent_id', handler: (_req, res, _url, params, p) => this.deleteAgent(res, params, p.owner) },
    ]
  }

  /**
   * @returns the method and prefix-relative pattern of every route, with `:name` and `*name` captures.
   */
  routeTable(): ReadonlyArray<{ method: string; pattern: string }> {
    return this.routes.map(({ method, pattern }) => ({ method, pattern }))
  }

  /**
   * Serve requests from `store`. Clears an earlier start failure.
   * @param store - opened store; its rejections answer 503 `store_unavailable`.
   */
  attachStore(store: Store): void {
    this.#store = guardStore(store)
    this.#storeError = undefined
    this.#knownOwners.clear()
  }

  /** Stop using the attached store; routes answer 503 until the next `attachStore`. */
  detachStore(): void {
    this.#store = undefined
    this.#knownOwners.clear()
  }

  /**
   * Record that the store could not start; routes answer 503 with `message`.
   * @param message - start failure shown to clients.
   */
  failStore(message: string): void {
    this.#store = undefined
    this.#storeError = message
    this.#knownOwners.clear()
  }

  /**
   * Whether requests can be served: the store is attached, still opening, or failed to start.
   * @returns the state, with the start failure's message when it failed.
   */
  storeStatus(): { state: 'ready' } | { state: 'starting' } | { state: 'failed'; error: string } {
    if (this.#store !== undefined) return { state: 'ready' }
    return this.#storeError === undefined ? { state: 'starting' } : { state: 'failed', error: this.#storeError }
  }

  /** The attached store; a detach during a request surfaces as a store outage. */
  private get store(): Store {
    if (this.#store === undefined) throw new StoreUnavailableError(this.#storeError ?? 'agents store is not attached')
    return this.#store
  }

  /**
   * Dispatch one HTTP request under the configured prefix.
   * @param req - incoming request.
   * @param res - outgoing response.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = requireAnyRole(await this.authenticator.authenticate(req), ['agentry-user', 'agentry-admin'])
    if (!auth.ok) {
      this.rejectAuth(res, auth)
      return
    }
    const { principal } = auth
    if (this.#store === undefined) {
      storeUnavailable(res, this.#storeError ?? 'agents store is opening')
      return
    }
    try {
      await this.dispatch(req, res, principal)
    } catch (error: unknown) {
      if (error instanceof StoreUnavailableError) {
        if (res.headersSent) res.end()
        else storeUnavailable(res, error.message)
        return
      }
      throw error
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
    if (!this.#knownOwners.has(principal.owner)) {
      await this.store.ensureOwner(principal.owner)
      this.#knownOwners.add(principal.owner)
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const method = (req.method ?? 'GET').toUpperCase()
    const pathname = normalizePath(url.pathname)
    const subpath = pathname.startsWith(this.prefix)
      ? normalizePath(pathname.slice(this.prefix.length) || '/')
      : pathname

    for (const route of this.routes) {
      if (route.method !== method) continue
      if (!route.pattern.includes(':') && !route.pattern.includes('*')) {
        if (subpath === route.pattern) {
          await route.handler(req, res, url, {}, principal)
          return
        }
        continue
      }
      const params = matchRoute(route.pattern, subpath)
      if (params) {
        await route.handler(req, res, url, params, principal)
        return
      }
    }
    notFound(res, `Cannot ${method} ${pathname}`)
  }

  private rejectAuth(res: ServerResponse, failure: Extract<AuthResult, { ok: false }>): void {
    if (failure.status === 401) res.setHeader('WWW-Authenticate', 'Bearer')
    json(res, failure.status, {
      error: {
        type: failure.status === 401 ? 'authentication_error' : 'permission_error',
        message: failure.message,
        code: failure.code,
      },
    })
  }

  private async createAgent(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    const body = await readBody(req) as unknown as CreateAgentParams
    if (typeof body.model !== 'string' || body.model === '') {
      badRequest(res, 'Field "model" is required')
      return
    }
    const toolError = validateMountableTools(body.tools ?? [])
    if (toolError) {
      badRequest(res, toolError)
      return
    }
    const hostToolsError = validateHostTools(body.host_tools)
    if (hostToolsError) {
      badRequest(res, hostToolsError)
      return
    }
    const skillsError = this.validateAgentExtensions(body)
    if (skillsError) {
      badRequest(res, skillsError)
      return
    }
    json(res, 200, redactAgentSecrets(await this.store.agents.create(owner, materializeAgent(body))))
  }

  private async listAgents(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const page = await this.store.agents.list(owner, listQuery(url))
    json(res, 200, { ...page, data: page.data.map(redactAgentSecrets) })
  }

  private async listHostTools(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const sessionId = url.searchParams.get('session_id')
    const schemas = await this.hostToolSchemas()
    let data = schemas.map(schema => ({
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      source: 'host' as const,
    }))
    if (sessionId) {
      const row = await this.requireSession(res, owner, sessionId)
      if (!row) return
      data = maskHostCatalog(data, configOf(row).agent.host_tools)
    }
    json(res, 200, { object: 'list', data })
  }

  /**
   * Schemas a new session can call.
   *
   * The web profile keeps model-facing tools on the default agent preset, so
   * the global `schemas()` view is empty. The default preset's scope (leased
   * through `acquireScope`) is that list. Profiles without a preset roster keep the global registry.
   */
  private async hostToolSchemas(): Promise<ReturnType<Context['tools']['schemas']>> {
    const get = (this.ctx as { get?: (name: string) => unknown }).get
    if (typeof get === 'function') {
      try {
        const presets = get.call(this.ctx, 'agentPresets') as {
          acquireScope?: (id?: string) => Promise<{ key: Parameters<Context['tools']['schemas']>[0] } & AsyncDisposable>
        } | undefined
        if (presets !== undefined && typeof presets.acquireScope === 'function') {
          const lease = await presets.acquireScope(AGENTRY_PRESET_ID)
          try {
            return this.ctx.tools.schemas(lease.key)
          } finally {
            await lease[Symbol.asyncDispose]()
          }
        }
      } catch {
        // No preset roster, or the default preset did not mount.
      }
    }
    return this.ctx.tools.schemas()
  }

  /**
   * Registry view for the skill catalog. A session id selects that session's live
   * agent as scope and its workspace as cwd; otherwise the default preset's scope
   * and the owner's default workspace root (when it exists) apply.
   * @param owner - authenticated caller.
   * @param sessionId - requested session, if any.
   * @returns the view, or `undefined` when the session is not owned by `owner`.
   */
  private async resolveSkillTarget(owner: OwnerId, sessionId: string | undefined): Promise<SkillTarget | undefined> {
    let cwd: string | undefined
    if (sessionId !== undefined) {
      const row = await this.store.sessions.get(sessionId, owner)
      if (!row) return undefined
      cwd = this.sessionRegistry.get(row.id)?.workspace ?? await this.history.workspace(row.id)
      const live = this.ctx.agents.get(SessionId(row.id))
      if (live !== undefined) return { scope: live as SkillViewOptions['scope'], cwd }
    } else {
      const root = join(this.workspacesRoot, directorySegment(owner, 'owner'))
      cwd = await stat(root).then(info => info.isDirectory() ? root : undefined, () => undefined)
    }
    const presets = (this.ctx as { get?: (name: string) => unknown }).get?.call(this.ctx, 'agentPresets') as {
      acquireScope?: (id?: string) => Promise<{ key: SkillViewOptions['scope'] } & AsyncDisposable>
    } | undefined
    if (typeof presets?.acquireScope !== 'function') return { scope: undefined, cwd }
    const lease = await presets.acquireScope(AGENTRY_PRESET_ID)
    return { scope: lease.key, cwd, release: () => lease[Symbol.asyncDispose]() }
  }

  /**
   * Registry view for the command catalog: the session's live agent, else the
   * default preset scope. A session that is not live is not resumed to list.
   * @param owner - authenticated caller.
   * @param sessionId - requested session.
   * @returns the view, or `undefined` when the session is not owned by `owner`.
   */
  private async resolveCommandTarget(owner: OwnerId, sessionId: string): Promise<CommandTarget | undefined> {
    const row = await this.store.sessions.get(sessionId, owner)
    if (!row) return undefined
    const live = this.ctx.agents.get(SessionId(row.id))
    if (live !== undefined) return { scope: live }
    const presets = (this.ctx as { get?: (name: string) => unknown }).get?.call(this.ctx, 'agentPresets') as {
      acquireScope?: (id?: string) => Promise<{ key: object } & AsyncDisposable>
    } | undefined
    if (typeof presets?.acquireScope !== 'function') return { scope: undefined }
    const lease = await presets.acquireScope(AGENTRY_PRESET_ID)
    return { scope: lease.key, release: () => lease[Symbol.asyncDispose]() }
  }

  /** Drop cached command catalogs; called when the command registry or a session's preset changes. */
  invalidateCommands(): void {
    this.commandsApi.invalidate()
  }

  private async getAgent(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    const agent = await this.store.agents.get(owner, agentId)
    if (!agent) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    json(res, 200, redactAgentSecrets(agent))
  }

  private async updateAgent(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    const body = await readBody(req) as unknown as UpdateAgentParams
    if (body.tools !== undefined && body.tools !== null) {
      const toolError = validateMountableTools(body.tools)
      if (toolError) {
        badRequest(res, toolError)
        return
      }
      const masked = findMaskedSecret(body.tools)
      if (masked !== undefined) {
        badRequest(res, `${masked} is the redacted placeholder "${MASKED_SECRET}"; send the real value or omit "tools" to keep the stored ones`)
        return
      }
    }
    if (body.host_tools !== undefined) {
      const hostToolsError = validateHostTools(body.host_tools)
      if (hostToolsError) {
        badRequest(res, hostToolsError)
        return
      }
    }
    const skillsError = this.validateAgentExtensions(body)
    if (skillsError) {
      badRequest(res, skillsError)
      return
    }
    const existing = await this.store.agents.get(owner, agentId)
    const updated = existing === undefined ? undefined : await this.store.agents.update(owner, agentId, updatedAgent(existing, body))
    if (updated !== undefined) this.skillInvalidations.invalidate(owner)
    if (!updated) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    json(res, 200, redactAgentSecrets(updated))
  }

  private async deleteAgent(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const agentId = routeParam(params, 'agent_id')
    if (!await this.store.agents.delete(owner, agentId)) {
      notFound(res, `Agent "${agentId}" not found`)
      return
    }
    json(res, 200, { id: agentId, object: 'agent.deleted', deleted: true })
  }

  private async createSession(req: IncomingMessage, res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const body = await readBody(req) as unknown as CreateSessionParams
    let provisioned: ProvisionedSession
    let fileIds: string[]
    try {
      fileIds = fileIdsFromInput(body.input)
      await this.ingest.validate(owner, fileIds)
      provisioned = await this.provisionSession(owner, body)
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        writeRequestError(res, error)
        return
      }
      if (error instanceof SessionCreateError) {
        this.ctx.logger.warn(`agents-api: session create failed: ${errorMessage(error)}`)
        // Development aid: AGENTRY_DEBUG_ERRORS=1 returns the cause (it can name host paths, so never in production).
        const detail = process.env['AGENTRY_DEBUG_ERRORS'] === '1' ? { detail: errorMessage((error as { cause?: unknown }).cause ?? error) } : {}
        json(res, 500, { error: { type: 'server_error', message: 'The session could not be created', code: error.code, ...detail } })
        return
      }
      throw error
    }
    const { sessionId, projector, base } = provisioned
    let attached: AttachedFiles | undefined
    if (fileIds.length > 0) {
      try {
        attached = await this.attachFiles(owner, sessionId, fileIds, provisioned.resolved)
      } catch (error: unknown) {
        await this.discardSession(owner, sessionId)
        if (error instanceof AgentsApiRequestError) {
          writeRequestError(res, error)
          return
        }
        this.ctx.logger.warn(`agents-api: attaching files failed: ${errorMessage(error)}`)
        json(res, 500, { error: { type: 'server_error', message: 'The files could not be attached', code: 'attach_failed' } })
        return
      }
    }

    const oaiSession = projector.snapshot()
    const stream = body.stream === true
      || url.searchParams.get('stream') === 'true'
      || (req.headers.accept ?? '').includes('text/event-stream')
    const userText = userTextFromInput(body.input)
    const hasInput = (userText !== undefined && userText !== '') || attached !== undefined
    const startTurn = (): void => {
      void this.triggerTurn(sessionId, userText ?? '', attached).catch((error: unknown) => {
        this.emitError(sessionId, error)
      })
    }

    if (stream) {
      writeSSEHeaders(res)
      const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt, sseId) => {
        writeEvent(res, evt.type, evt, sseId)
      })
      req.on('close', () => {
        unsubscribe()
      })
      writeEvent(res, projector.created.event.type, projector.created.event, projector.created.id)
      if (hasInput) {
        startTurn()
      } else {
        this.sessionRegistry.emitEphemeral(sessionId, {
          type: 'agent.session.idle',
          event_id: mintEventId(),
          session: oaiSession,
        })
      }
      return
    }

    if (hasInput) startTurn()
    json(res, 200, await this.sessionPayload(oaiSession, base, owner))
  }

  /**
   * Create an idle session for `owner` without an HTTP request: same agent
   * resolution, workspace, agent creation, and index row as
   * `POST /agents/sessions`, and no turn.
   * @param owner - owner recorded on the session.
   * @param params - session body; `input` and `stream` do not apply.
   * @returns the new session resource, status `idle`.
   * @throws AgentsApiRequestError 400 for an invalid agent, tool, workspace, or reasoning effort, or 404 for an unknown `agent_id`.
   * @throws SessionCreateError when the agent or the index row cannot be created; nothing stays registered.
   * @throws StoreUnavailableError when the store is unavailable.
   */
  async createIdleSession(owner: OwnerId, params: Omit<CreateSessionParams, 'input' | 'stream'>): Promise<OAIAgentSession> {
    return (await this.provisionSession(owner, params)).projector.snapshot()
  }

  /**
   * Resolve the session agent, prepare its workspace, register its projector,
   * create its agent, and insert its index row. Starts no turn.
   * @param owner - owner recorded on the session.
   * @param body - session body; `input` and `stream` are ignored.
   * @returns the session id, its live projector and projection base, and the resolved agent.
   * @throws AgentsApiRequestError 400 for an invalid agent, tool, workspace, or reasoning effort, or 404 for an unknown `agent_id`.
   * @throws SessionCreateError when `agents.create` or the index insert fails; the projector, handle, and agent are removed first.
   * @throws StoreUnavailableError when the store is unavailable, after the same cleanup.
   */
  private async provisionSession(owner: OwnerId, body: CreateSessionParams): Promise<ProvisionedSession> {
    const resolved = await this.resolveSessionAgent(body, owner)
    const toolError = validateMountableTools(resolved.tools)
    if (toolError) throw new AgentsApiRequestError(toolError, 400, 'bad_request')
    const hostToolsError = validateHostTools(resolved.host_tools)
    if (hostToolsError) throw new AgentsApiRequestError(hostToolsError, 400, 'bad_request')

    const sessionId = SessionId(`sess_${randomUUID().replaceAll('-', '')}`)
    let cwd: string
    let environment: OAIEnvironmentConfig
    try {
      const workspace = await this.resolveSessionWorkspace(body.environment, owner, sessionId)
      cwd = workspace.cwd
      environment = workspace.environment
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) throw error
      throw new AgentsApiRequestError(errorMessage(error), 400, 'bad_request')
    }
    const agentOptions = await this.agentOptionsFor(resolved)
    if (resolved.reasoning?.effort != null) {
      try {
        await this.ctx.llm.resolveCallConfig({ ...agentOptions })
      } catch (error: unknown) {
        throw new AgentsApiRequestError(errorMessage(error), 400, 'bad_request')
      }
    }
    const pending = new PendingFunctionCalls()
    const config: SessionConfig = {
      agent: resolved,
      environment,
      metadata: body.metadata ?? {},
      vault_ids: body.vault_ids ?? [],
    }
    const now = new Date()
    const base: ProjectionBase = {
      sessionId,
      createdAt: Math.floor(now.getTime() / 1000),
      agent: config.agent,
      environment: config.environment,
      metadata: config.metadata,
      vaultIds: config.vault_ids,
    }
    const projector = new WireProjector(base, false)
    // Registered before the agent exists so no event logged during creation is missed.
    this.sessionRegistry.register(projector, cwd)

    try {
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions,
        setup: this.buildAgentSetup(resolved, pending, cwd, owner, environment),
      })
      this.handles.set(sessionId, handle)
      // Sandbox sessions start in full access: the container is the boundary (the agent has sudo there), and
      // DSH's in-container confinement would set no_new_privs and break sudo. The user can still switch modes.
      if (await this.sandboxEnvironmentOf(owner, environment)) {
        (this.ctx.agents.get(sessionId) as { session?: { append(type: string, data: unknown): void } } | undefined)?.session?.append('sandbox/mode', { mode: 'danger-full-access' })
      }
      this.pendingBySession.set(sessionId, pending)
      await this.store.sessions.insert({
        id: sessionId,
        ownerId: owner,
        agentId: typeof body.agent_id === 'string' && body.agent_id !== '' ? body.agent_id : null,
        environmentId: null,
        dshSessionId: sessionId,
        status: 'idle',
        lastError: null,
        model: resolved.model,
        reasoningEffort: resolved.reasoning?.effort ?? null,
        body: config,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error: unknown) {
      pending.rejectAll(new Error('session create failed'))
      this.sessionRegistry.delete(sessionId)
      const created = this.handles.get(sessionId)
      this.handles.delete(sessionId)
      this.pendingBySession.delete(sessionId)
      if (created) {
        try {
          await created.dispose()
        } catch {
          // Host teardown already ran.
        }
      }
      if (error instanceof StoreUnavailableError) throw error
      if (error instanceof AgentsApiMcpConfigError) throw new AgentsApiRequestError(error.message, 400, 'bad_request')
      const sandboxDown = sandboxStartErrorIn(error)
      if (sandboxDown !== undefined) throw new AgentsApiRequestError(sandboxDown.message, 503, 'sandbox_unavailable')
      throw new SessionCreateError(error)
    }
    return { sessionId, projector, base, resolved }
  }

  /** Wire `error` event for a dispatch failure. It is not a Session log fact, so it carries no `id`. */
  private emitError(sessionId: string, error: unknown): void {
    this.sessionRegistry.emitEphemeral(sessionId, {
      type: 'error',
      event_id: mintEventId(),
      session_id: sessionId,
      error: { message: errorMessage(error) },
    })
  }

  /** Newest first, from index rows only. `after` names the last session of the previous page. */
  private async listSessions(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const query = listQuery(url)
    const after = query.after === undefined ? undefined : await this.store.sessions.get(query.after, owner)
    const metadata = metadataFilter(url)
    const page = await this.store.sessions.list({
      owner,
      limit: query.limit,
      ...(metadata === undefined ? {} : { metadata }),
      ...(after === undefined ? {} : { cursor: encodeSessionCursor(after.createdAt, after.id) }),
    })
    json(res, 200, {
      object: 'list',
      data: page.data.map(row => this.sessionRegistry.getOAISession(row.id) ?? sessionFromRow(row)),
      first_id: page.data[0]?.id ?? null,
      last_id: page.data.at(-1)?.id ?? null,
      has_more: page.nextCursor !== null,
    })
  }

  /**
   * Find the session index row the owner holds, or answer 404.
   * @param res - response that receives the 404.
   * @param owner - calling principal.
   * @param sessionId - session id from the route.
   * @returns the row, or `undefined` after a 404 was written.
   */
  private async requireSession(res: ServerResponse, owner: OwnerId, sessionId: string): Promise<SessionIndexRow | undefined> {
    const row = await this.store.sessions.get(sessionId, owner)
    if (!row) notFound(res, `Session "${sessionId}" not found`)
    return row
  }

  private async getSession(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const row = await this.requireSession(res, owner, routeParam(params, 'session_id'))
    if (!row) return
    json(res, 200, this.sessionRegistry.getOAISession(row.id) ?? sessionFromRow(row))
  }

  private async updateSession(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const row = await this.requireSession(res, owner, sessionId)
    if (!row) return
    const body = await readBody(req) as unknown as UpdateSessionParams
    try {
      const session = await this.changeSettings(row, owner, body)
      if (session === undefined) {
        notFound(res, `Session "${sessionId}" not found`)
        return
      }
      json(res, 200, session)
    } catch (error: unknown) {
      if (!(error instanceof AgentsApiRequestError)) throw error
      writeRequestError(res, error)
    }
  }

  /**
   * Apply a settings update: validate, retarget the live agent when the model
   * or reasoning effort changed, then write the index, then the live projection.
   * @param row - the session's index row.
   * @param owner - calling principal.
   * @param body - update body.
   * @returns the updated resource, or `undefined` when the row disappeared.
   * @throws AgentsApiRequestError 400 when `agent.model` would be empty, or 409 `session_setting_not_live` when the live agent cannot take the change; nothing is stored then.
   */
  private async changeSettings(row: SessionIndexRow, owner: OwnerId, body: UpdateSessionParams): Promise<OAIAgentSession | undefined> {
    const current = configOf(row)
    const next = applySessionUpdate(current, body)
    if (next === undefined) {
      throw new AgentsApiRequestError('Field "agent.model" cannot be null or empty', 400, 'bad_request')
    }
    const merge = body.metadata_merge
    if (merge !== undefined && (merge === null || typeof merge !== 'object' || Object.values(merge).some(value => value !== null && typeof value !== 'string'))) {
      throw new AgentsApiRequestError('Field "metadata_merge" must map keys to strings or null', 400, 'bad_request')
    }
    // A merge-only update skips the whole-row write below, which would overwrite a concurrent merge with this request's stale copy.
    if (body.agent === undefined && body.metadata === undefined && merge !== undefined) return this.mergeSessionMetadata(row, owner, merge)
    if (next.agent.model !== current.agent.model || next.agent.reasoning?.effort !== current.agent.reasoning?.effort) {
      await this.applyLiveModel(row, next.agent, current.agent.model)
    }
    const updated = await this.store.sessions.update(row.id, owner, {
      model: next.agent.model,
      reasoningEffort: next.agent.reasoning?.effort ?? null,
      body: next,
    })
    if (!updated) return undefined
    const settled = this.sessionRegistry.applyConfig(row.id, next) ?? sessionFromRow(updated)
    return merge === undefined ? settled : this.mergeSessionMetadata(row, owner, merge)
  }

  /**
   * Merge metadata keys into a session (`null` deletes a key) and refresh the live projection.
   * @param row - the session's index row.
   * @param owner - calling principal.
   * @param merge - keys to set or delete.
   * @returns the updated resource, or `undefined` when the row disappeared or has no stored setup.
   */
  private async mergeSessionMetadata(row: SessionIndexRow, owner: OwnerId, merge: Record<string, string | null>): Promise<OAIAgentSession | undefined> {
    const updated = await this.store.sessions.mergeMetadata(row.id, owner, merge)
    if (updated?.body == null) return undefined
    return this.sessionRegistry.applyConfig(row.id, updated.body) ?? sessionFromRow(updated)
  }

  /**
   * Point the session's live agent at a model and reasoning effort. The agent
   * applies the complete selection from its next model step; a step already
   * running is unchanged.
   * @param row - the session's index row, used to resume the agent when it is not live.
   * @param agent - the agent configuration after the update.
   * @param modelBefore - the model before the update; a model that is not offered is refused only when it differs from this.
   * @throws AgentsApiRequestError 409 `session_setting_not_live` when no live agent exists, the model is not offered, the route or effort is unsupported, or the selection cannot be recorded.
   */
  private async applyLiveModel(row: SessionIndexRow, agent: OAIAgent, modelBefore: string): Promise<void> {
    const notLive = (message: string): AgentsApiRequestError => new AgentsApiRequestError(message, 409, 'session_setting_not_live')
    try {
      await this.ensureLive(row)
    } catch (error: unknown) {
      throw notLive(`Session "${row.id}" is not running and could not be resumed: ${errorMessage(error)}`)
    }
    const live = this.ctx.agents.get(SessionId(row.id))
    if (live === undefined) throw notLive(`Session "${row.id}" has no running agent`)
    const found = await lookUpModel(
      this.ctx,
      agent.model,
      live.model.current()?.provider ?? this.ctx.agentDefaultModel.currentSelection().provider,
    )
    if (found.known === false && agent.model !== modelBefore) throw notLive(`Model "${agent.model}" is not offered by any configured provider`)
    const provider = found.provider
    const effort = agent.reasoning?.effort
    const route = { provider, model: agent.model, ...(effort == null ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
    try {
      await this.ctx.llm.resolveCallConfig(route)
      live.model.select(route)
    } catch (error: unknown) {
      throw notLive(errorMessage(error))
    }
  }

  private async deleteSession(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!await this.requireSession(res, owner, sessionId)) return
    // Order matters: the live agent is stopped first so a turn in flight cannot
    // call `schedule_create this_session` after the sweep; then the tasks go; the
    // index row goes last. When the sweep fails the session stays indexed and
    // resumes on its next use.
    await this.stopLiveAgent(sessionId)
    try {
      await this.deleteSchedulesForSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`agents-api: schedule cleanup for ${sessionId} failed: ${errorMessage(error)}`)
      json(res, 500, { error: { type: 'server_error', message: 'Scheduled tasks for this session could not be removed', code: 'schedule_cleanup_failed' } })
      return
    }
    await this.discardSession(owner, sessionId)
    this.deliverablesCache.delete(sessionId)
    json(res, 200, { id: sessionId, object: 'agent.session.deleted', deleted: true })
  }

  /**
   * Remove a session's environments, index row, pending approvals and function
   * calls, registry entry, and live agent without an HTTP request. Scheduled
   * tasks that deliver to it are not touched; `DELETE /agents/sessions/{id}`
   * removes them first.
   * @param owner - owner of the session.
   * @param sessionId - session to remove.
   * @throws StoreUnavailableError when the store is unavailable.
   */
  async discardSession(owner: OwnerId, sessionId: string): Promise<void> {
    await this.deleteEnvironmentsForSession(owner, sessionId)
    await this.store.files.deleteForSession(owner, sessionId)
    await this.store.sessions.delete(sessionId, owner)
    this.sessionRegistry.delete(sessionId)
    this.statusWrites.delete(sessionId)
    await this.stopLiveAgent(sessionId)
  }

  /**
   * Cancel the session's turn, reject its pending approvals and function calls,
   * and dispose the live agent. Safe to call twice and for a session with no
   * live agent.
   * @param sessionId - session whose agent stops.
   */
  private async stopLiveAgent(sessionId: string): Promise<void> {
    this.approvals.cancelAll(sessionId)
    this.pendingBySession.get(sessionId)?.rejectAll(new Error(`Session "${sessionId}" was deleted`))
    this.pendingBySession.delete(sessionId)
    this.ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'user' }, { keepInbox: true })
    const handle = this.handles.get(sessionId)
    this.handles.delete(sessionId)
    if (handle) {
      try {
        await handle.dispose()
      } catch {
        // Host teardown already ran; the Agents API session is unregistered.
      }
    }
  }

  /**
   * Delete every scheduled task that delivers to or involves `sessionId`
   * (chat-created `new` tasks list the chat only in `involvedSessionIds`, and a
   * delivered `new_once` task is retargeted). Runs before the index row is
   * removed, so `agentFor` never hands a deleted session's deliveries to the
   * Host's default resolver. A task already deleted elsewhere is skipped.
   * @param sessionId - session being deleted.
   * @throws when the schedule service rejects `catalog` or a delete; the session is then left in place.
   */
  private async deleteSchedulesForSession(sessionId: string): Promise<void> {
    const schedule = this.schedule()
    if (schedule === undefined) return
    for (const entry of await schedule.catalog()) {
      const targeted = 'sessionId' in entry.target && entry.target.sessionId === sessionId
      if (!targeted && !entry.involvedSessionIds.includes(SessionId(sessionId))) continue
      await schedule.edit({ id: entry.id, action: 'delete' })
    }
  }

  /**
   * `POST /agents/sessions/:session_id/commands/:name`: run one Host slash
   * command outside a turn and answer its outcome. Refused with 409
   * `session_busy` while a turn is running or another command is executing.
   * @param req - request carrying `{ input?: string }`.
   * @param res - outgoing response.
   * @param params - route captures `session_id` and `name`.
   * @param owner - authenticated caller.
   */
  private async runCommand(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const name = routeParam(params, 'name')
    const row = await this.store.sessions.get(sessionId, owner)
    if (!row) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const body = await readBody(req)
    if (body.input !== undefined && typeof body.input !== 'string') {
      badRequest(res, '"input" must be a string')
      return
    }
    const commands = this.commands()
    if (commands === undefined || !COMMAND_NAME.test(name) || (this.commandsAllow !== undefined && !this.commandsAllow.has(name))) {
      commandNotFound(res, name)
      return
    }
    try {
      await this.ensureLive(row)
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        writeRequestError(res, error)
        return
      }
      json(res, 500, { error: { type: 'server_error', message: errorMessage(error), code: 'session_resume_failed' } })
      return
    }
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const status = this.sessionRegistry.get(sessionId)?.projector.status
    if (status === 'in_progress' || status === 'requires_action' || this.commandsRunning.has(sessionId)) {
      writeRequestError(res, new AgentsApiRequestError('The session is busy: wait for the current turn or command to finish', 409, 'session_busy'))
      return
    }
    const input = typeof body.input === 'string' && body.input !== '' ? ` ${body.input}` : ''
    const aborted = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) aborted.abort()
    }
    res.on('close', onClose)
    this.commandsRunning.add(sessionId)
    try {
      const execution = await commands.execute(agent, `/${name}${input}`, [], aborted.signal)
      if (execution === undefined) {
        commandNotFound(res, name)
        return
      }
      const item = this.sessionRegistry.get(sessionId)?.projector.items
        .find(candidate => candidate.type === 'slash_command' && candidate.command_id === execution.commandId)
        ?? slashCommandItem({ seq: 0, commandId: execution.commandId, name }, execution.result, null)
      json(res, 200, {
        command_id: execution.commandId,
        name,
        status: execution.result.kind,
        ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
        item,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`agents-api: command "${name}" failed in session ${sessionId}: ${errorMessage(error)}`)
      json(res, 500, { error: { type: 'server_error', message: `Command "${name}" failed`, code: 'command_failed' } })
    } finally {
      this.commandsRunning.delete(sessionId)
      res.off('close', onClose)
    }
  }

  private async postEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const row = await this.store.sessions.get(sessionId, owner)
    if (!row) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    const input = await readBody(req)
    const batch = inputEventsFromBody(input)
    try {
      await this.validateBatchFiles(owner, batch)
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        writeRequestError(res, error)
        return
      }
      throw error
    }
    if (batch.length > 0 && batch.every(evt => evt.type === 'agent.session.input.approval_response')
      && this.sessionRegistry.get(sessionId) === undefined) {
      // Approvals never survive a restart, so there is nothing to resume for.
      writeRequestError(res, new AgentsApiRequestError('No pending approval: the session is not running', 404, 'approval_not_found'))
      return
    }
    try {
      await this.ensureLive(row)
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        json(res, error.status, { error: { type: 'invalid_request_error', message: error.message, code: error.code } })
        return
      }
      json(res, 500, { error: { type: 'server_error', message: errorMessage(error), code: 'session_resume_failed' } })
      return
    }
    if (!this.ctx.sessions.get(SessionId(sessionId))) {
      notFound(res, `Session "${sessionId}" not found`)
      return
    }
    try {
      for (const evt of batch) {
        await this.applyInputEvent(owner, row, evt)
      }
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        writeRequestError(res, error)
        return
      }
      json(res, 500, {
        error: {
          type: 'server_error',
          message: errorMessage(error),
          code: 'event_apply_failed',
        },
      })
      return
    }
    json(res, 200, await this.sessionPayload(this.sessionRegistry.getOAISession(sessionId) ?? sessionFromRow(row), baseOf(row), owner))
  }

  /** Session plus the items and turns CoreWork reads after create and follow-up. */
  private async sessionPayload(
    session: OAIAgentSession,
    base: ProjectionBase,
    owner: OwnerId,
  ): Promise<OAIAgentSession & { session: OAIAgentSession; items: unknown[]; turns: unknown[] }> {
    const page = { limit: 100, order: 'asc' as const }
    const folded = await this.history.fold(base)
    const items = await withFileIds(this.store, owner, base.sessionId, paginate(folded.items, page).data)
    return { ...session, session, items, turns: paginate(folded.turns, page).data }
  }

  private async streamEvents(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const row = await this.requireSession(res, owner, sessionId)
    if (!row) return
    writeSSEHeaders(res)
    const header = req.headers['last-event-id']
    const raw = Array.isArray(header) ? header[0] : header
    const parsed = raw === undefined || raw === '' ? undefined : Number(raw)
    const lastId = parsed === undefined ? undefined : Number.isFinite(parsed) ? parsed : 0

    let open = true
    const write = (evt: OAISessionEvent, sseId: number | undefined): void => {
      if (open) writeEvent(res, evt.type, evt, sseId)
    }
    if (lastId === undefined) {
      const unsubscribe = this.sessionRegistry.subscribe(sessionId, write)
      req.on('close', () => {
        open = false
        unsubscribe()
      })
      const session = this.sessionRegistry.getOAISession(sessionId) ?? sessionFromRow(row)
      const type = session.status === 'requires_action'
        ? 'agent.session.requires_action'
        : session.status === 'in_progress'
          ? 'agent.session.in_progress'
          : session.status === 'failed' ? 'agent.session.failed' : 'agent.session.idle'
      write({ type, event_id: mintEventId(), session }, undefined)
      return
    }

    // Subscribe before folding: frames produced while the log is read are buffered, then flushed after the replayed ones.
    let replaying = true
    const buffered: Array<{ evt: OAISessionEvent; sseId: number | undefined }> = []
    const unsubscribe = this.sessionRegistry.subscribe(sessionId, (evt, sseId) => {
      if (replaying) buffered.push({ evt, sseId })
      else write(evt, sseId)
    })
    req.on('close', () => {
      open = false
      unsubscribe()
    })
    let lastWritten = lastId
    try {
      for (const frame of await this.history.wireEvents(baseOf(row), lastId)) {
        write(frame.event, frame.id)
        lastWritten = frame.id
      }
    } catch (error: unknown) {
      unsubscribe()
      open = false
      this.ctx.logger.warn(`agents-api: replay of ${sessionId} failed: ${errorMessage(error)}`)
      res.end()
      return
    }
    for (const { evt, sseId } of buffered) {
      if (sseId !== undefined && sseId <= lastWritten) continue
      write(evt, sseId)
      if (sseId !== undefined) lastWritten = sseId
    }
    // Pending approvals are not in the log, so replay cannot show them: tell this client once.
    const live = this.sessionRegistry.getOAISession(sessionId)
    if (live !== undefined && (live.status === 'requires_action' || live.required_actions.some(action => action.type === 'approval'))) {
      write({ type: 'agent.session.requires_action', event_id: mintEventId(), session: live }, undefined)
    }
    replaying = false
  }

  /**
   * Record a status change in the session index. Writes for one session run in
   * the order the statuses were produced; a failed write is logged and never
   * thrown into the Session event listener that produced it.
   * @param sessionId - session id.
   * @param status - new status.
   * @param error - error text for `failed`, else `null`.
   */
  recordStatus(sessionId: string, status: SessionStatus, error: string | null): void {
    const store = this.#store
    if (store === undefined) return
    const previous = this.statusWrites.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(() => store.sessions.update(sessionId, 'any', { status, lastError: error }))
      .then(() => undefined, (failure: unknown) => {
        this.ctx.logger.warn(`agents-api: status write for ${sessionId} failed: ${errorMessage(failure)}`)
      })
    this.statusWrites.set(sessionId, next)
  }

  /**
   * Show the session's pending approvals and questions, and write the status
   * that follows from them.
   * @param sessionId - session id.
   * @param actions - all pending `approval` actions.
   */
  setInteractionActions(sessionId: string, actions: readonly OAIRequiredAction[]): void {
    const change = this.sessionRegistry.setInteractionActions(sessionId, actions)
    if (change !== undefined) this.recordStatus(sessionId, change.status, change.error)
  }

  /**
   * Resolves when every status write requested so far has finished.
   * @returns a promise that never rejects.
   */
  async statusWritesSettled(): Promise<void> {
    await Promise.all([...this.statusWrites.values()])
  }

  /**
   * Project one Session event of a live session: fan its frames out and write
   * the status it produced.
   * @param sessionId - session id.
   * @param event - committed Session event.
   */
  applySessionEvent(sessionId: string, event: SessionEvent): void {
    if ((event.type as string) === 'agent-preset/selected') this.commandsApi.invalidate()
    const step = this.sessionRegistry.apply(sessionId, event)
    if (step?.status) this.recordStatus(sessionId, step.status.status, step.status.error)
  }

  /**
   * Model route a session's agent starts with: the profile default, or the
   * first provider that lists the model.
   * @param agent - session agent.
   */
  private async agentOptionsFor(agent: OAIAgent): Promise<{ provider: string; model: string; reasoningEffort?: NonNullable<ReturnType<Context['agentDefaultModel']['currentSelection']>['reasoningEffort']> }> {
    const defaults = this.ctx.agentDefaultModel.currentSelection()
    const provider = await providerForModel(this.ctx, agent.model, defaults.provider)
    const effort = agent.reasoning?.effort
    const reasoningEffort = effort == null ? defaults.reasoningEffort : ReasoningEffortId(effort)
    return {
      provider,
      model: agent.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }

  /** @returns what skill installs need; the store is read at call time (it opens after the gateway). */
  installDeps(): InstallDeps {
    const gateway = this
    return {
      get store() { return gateway.store },
      root: this.skillsRoot,
      reserved: () => new Set(this.builtinSkills().map(b => b.name)),
      invalidate: owner => { this.skillInvalidations.invalidate(owner) },
      builtins: () => this.builtinSkills(),
    }
  }

  /** Delete skills left in review for more than a day. */
  async sweepSkills(): Promise<void> {
    try {
      await sweepStaged(this.installDeps(), Math.floor(Date.now() / 1000))
    } catch (error: unknown) {
      this.ctx.logger.warn(`agents-api: skill sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * @param value - a request's `skills` field.
   * @returns an error message, or `undefined` when valid.
   */
  validateSkills(value: unknown): string | undefined {
    return validateSkillSelection(value, new Set(this.builtinSkills().map(b => b.name)))
  }

  /**
   * @param body - agent create or update body.
   * @returns an error message for Agentry's extension fields (`skills`, `apps`, `send_policy`), or `undefined`.
   */
  validateAgentExtensions(body: { skills?: unknown; apps?: unknown; send_policy?: unknown }): string | undefined {
    const policy = body.send_policy
    if (policy !== undefined && policy !== null && policy !== 'ask' && policy !== 'auto') return 'send_policy must be "ask", "auto", or null'
    return this.validateSkills(body.skills) ?? validateAppGrants(body.apps)
  }

  /**
   * Register the agent-scoped `agentry` skill provider. It re-reads the saved
   * agent's selection on every catalog read, so edits apply to live sessions;
   * an agent that is not saved (the default chat) gets the default-chat set.
   * @param agentCtx - agent-scoped context.
   * @param agentId - session agent id.
   * @param owner - session owner.
   */
  private mountAgentrySkills(agentCtx: Context, agentId: string, owner: OwnerId): void {
    const registry = (agentCtx as { get?: (name: string) => unknown }).get?.call(agentCtx, 'skills') as
      { registerProvider?: (create: (control: SkillProviderControl) => SkillProvider) => () => void } | undefined
    if (typeof registry?.registerProvider !== 'function') return
    const create = createAgentrySkillProvider({
      root: this.skillsRoot,
      resolve: async () => resolveAgentSkills({ agent: await this.store.agents.get(owner, agentId), owner, store: this.store, builtins: this.builtinSkills() }),
    })
    const unregister = registry.registerProvider((control) => {
      const forget = this.skillInvalidations.add(owner, control.invalidate)
      control.signal.addEventListener('abort', forget, { once: true })
      return create(control)
    })
    ;(agentCtx as { effect?: (fn: () => () => void) => void }).effect?.(() => unregister)
  }

  /**
   * Mount the session's preset: `agentry`, or for a session on an Agentry
   * Sandbox environment that sandbox's preset (every tool runs inside it),
   * held for the agent's lifetime.
   */
  private async mountSessionPreset(agentCtx: Context, owner: OwnerId, environment: OAIEnvironmentConfig | undefined): Promise<void> {
    const environmentId = environment?.type === 'sandbox' ? environment.environment_id : undefined
    const record = environmentId === undefined ? undefined : await this.store.environments.get(owner, environmentId)
    if (environmentId !== undefined && record === undefined) throw new Error(`environment ${environmentId} no longer exists; this session cannot run`)
    if (record === undefined || record.provider === 'local') {
      await mountDefaultPreset(agentCtx)
      return
    }
    // Never fall back to the host for a non-local environment: an unroutable session fails.
    const sandboxId = record.provider_metadata['sandbox_id']
    if (sandboxId === undefined) throw new Error(`environment ${record.id} has no sandbox (${record.status}${record.error ? `: ${record.error}` : ''}); this session cannot run`)
    if (this.sandboxPresets === undefined) throw new Error('Agentry Sandbox sessions need an agent preset registry')
    const workspace = record.provider_metadata['workspace_directory']
    if (workspace === undefined) throw new Error(`environment ${record.id} has no workspace path`)
    const lease = await this.sandboxPresets.acquire(owner, sandboxId, workspace)
    ;(agentCtx as { effect?: (fn: () => () => void) => void }).effect?.(() => () => { void lease[Symbol.asyncDispose]() })
    await mountDefaultPreset(agentCtx, lease.presetId)
  }

  /**
   * Agent composition shared by create and resume.
   * @param resolved - session agent.
   * @param pending - the session's parked function calls.
   * @param cwd - session working directory.
   * @returns the `agents.create` / `agents.resume` setup callback.
   */
  private buildAgentSetup(resolved: OAIAgent, pending: PendingFunctionCalls, cwd: string, owner: OwnerId, environment?: OAIEnvironmentConfig): AgentSetup {
    const functionTools = resolved.tools.filter(
      (tool): tool is OAIFunctionTool => tool.type === 'function',
    )
    return async (agentCtx) => {
      await this.mountSessionPreset(agentCtx, owner, environment)
      this.mountAgentrySkills(agentCtx, resolved.id, owner)
      mountAgentInstructions(agentCtx, resolved.instructions, resolved.name)
      // Mounted before the mask so an agent's `host_tools` can hide the agent tools.
      mountAgentTools(agentCtx, {
        owner,
        store: this.store,
        defaultModel: resolved.model,
        // What the agent can really call: its own scope (preset tools plus this session's MCP and wire tools).
        // Without the agent, the default preset's catalog (the model-facing tools are not in the global registry).
        listTools: async (agent) => maskHostCatalog(
          (agent !== undefined
            ? this.ctx.tools.schemas(agent as Parameters<Context['tools']['schemas']>[0])
            : await this.hostToolSchemas()
          ).map(schema => ({ name: schema.name, description: schema.description })),
          resolved.host_tools,
        ),
        callerGrants: effectiveGrants(resolved),
        builtinSkills: () => new Set(this.builtinSkills().map(b => b.name)),
        checkModel: async (model) => {
          try {
            await this.ctx.llm.resolveCallConfig({ ...(await this.agentOptionsFor({ ...resolved, model })) })
            return undefined
          } catch {
            return `model "${model}" is not available`
          }
        },
      })
      // The user's isolated sandboxes, when Agentry Sandbox is configured.
      const sandboxProvider = this.sandboxes.get('sandbox') as AgentrySandboxProvider | undefined
      if (sandboxProvider?.api !== undefined) {
        mountSandboxTools(agentCtx, {
          owner,
          store: this.store,
          provider: sandboxProvider,
          cwd,
          provision: (raw, inline) => this.provisionEnvironment(owner, raw, inline),
          destroy: (record) => this.destroyEnvironment(record),
          describe: (record) => this.environmentJson(owner, record),
          ...(environment?.type === 'sandbox' && typeof environment['environment_id'] === 'string' ? { currentEnvironmentId: environment['environment_id'] } : {}),
        })
      }
      mountSkillTools(agentCtx, {
        owner,
        deps: this.installDeps(),
        agentId: async () => (await this.store.agents.get(owner, resolved.id))?.id,
        ...(this.skillsGithub ? { github: this.skillsGithub } : {}),
      })
      applyHostToolsRestrict(agentCtx, resolved.host_tools)
      mountScheduleGuidance(agentCtx)
      mountFunctionTools(agentCtx, functionTools, pending)
      await mountMcpTools(agentCtx, mcpToolsFrom(resolved.tools), cwd)
      mountComposio(agentCtx, {
        grants: effectiveGrants(resolved),
        approvalVerbs: new Set(this.composio.approvalVerbs),
        approvalSlugs: new Set(this.composio.approvalSlugs),
        sendPolicy: resolved.send_policy ?? 'ask',
        serverLabel: this.composio.serverLabel,
      })
      mountComposioAppTools(agentCtx, { serverLabel: this.composio.serverLabel, grants: effectiveGrants(resolved) })
    }
  }

  /**
   * Rebuild the agent of a session that is not live in this process: fold its
   * Session log into a projector, register it, then resume the agent. Frame ids
   * after the resume continue from the fold, so they equal what a later replay
   * assigns. The session index row is updated to the status the fold ends in.
   * @param row - session index row with a stored setup.
   * @throws when the log cannot be read or the agent cannot be resumed; nothing stays registered.
   */
  async resumeSession(row: SessionIndexRow): Promise<void> {
    const config = configOf(row)
    const cwd = await this.history.workspace(row.id)
    if (cwd === undefined) throw new Error('the session log has no working directory')
    const projector = await this.history.fold(baseOf(row))
    const pending = new PendingFunctionCalls()
    this.sessionRegistry.register(projector, cwd)
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(row.id),
        agentOptions: await this.agentOptionsFor(config.agent),
        setup: this.buildAgentSetup(config.agent, pending, cwd, row.ownerId, config.environment),
      })
      if (await this.store.sessions.get(row.id, 'any') === undefined) {
        // Deleted while the resume was in flight: undo it.
        this.sessionRegistry.delete(row.id)
        await handle.dispose().catch(() => undefined)
        return
      }
      this.handles.set(row.id, handle)
      this.pendingBySession.set(row.id, pending)
    } catch (error: unknown) {
      this.sessionRegistry.delete(row.id)
      throw error
    }
    this.recordStatus(row.id, projector.status, projector.error)
  }

  /**
   * Make sure the session has a live agent, resuming it from its log after a restart.
   * @param row - session index row.
   * @throws AgentsApiRequestError 409 `session_not_resumable` when the row has no stored setup.
   */
  private async ensureLive(row: SessionIndexRow): Promise<void> {
    // The resume registers its projector only after reading the log, so an in-flight attempt is checked first.
    const inFlight = this.resuming.get(row.id)
    if (inFlight !== undefined) {
      await inFlight
      return
    }
    if (this.sessionRegistry.get(row.id) !== undefined) return
    if (row.body === null) {
      throw new AgentsApiRequestError(`Session "${row.id}" ${NO_STORED_CONFIG} and cannot be continued`, 409, 'session_not_resumable')
    }
    const attempt = this.resumeSession(row).finally(() => {
      this.resuming.delete(row.id)
    })
    this.resuming.set(row.id, attempt)
    await attempt
  }

  /**
   * Live agent of a session this API owns, resuming it from its Session log
   * with its stored setup when it is not live. Concurrent calls share one resume.
   * @param sessionId - DSH session id, for example from `schedule/resolve-agent`.
   * @returns the agent, or `undefined` when no index row has this id.
   * @throws AgentsApiRequestError 409 `session_not_resumable` when the row has no stored setup.
   * @throws StoreUnavailableError when the store is unavailable.
   * @throws when the resume fails, or the session was deleted while it resumed.
   */
  async agentFor(sessionId: string): Promise<Agent | undefined> {
    const row = await this.store.sessions.get(sessionId, 'any')
    if (row === undefined) return undefined
    await this.ensureLive(row)
    const agent = this.handles.get(row.id)?.agent ?? this.ctx.agents.get(SessionId(row.id))
    if (agent === undefined) throw new Error(`Session "${row.id}" has no live agent`)
    return agent
  }

  private async listItems(res: ServerResponse, url: URL, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const row = await this.requireSession(res, owner, routeParam(params, 'session_id'))
    if (!row) return
    const page = await this.history.items(baseOf(row), listQuery(url))
    json(res, 200, { ...page, data: await withFileIds(this.store, owner, row.id, page.data) })
  }

  private async listTurns(res: ServerResponse, url: URL, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const row = await this.requireSession(res, owner, routeParam(params, 'session_id'))
    if (!row) return
    json(res, 200, await this.history.turns(baseOf(row), listQuery(url)))
  }

  private async getTurn(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const turnId = routeParam(params, 'turn_id')
    const row = await this.requireSession(res, owner, routeParam(params, 'session_id'))
    if (!row) return
    const turn = await this.history.turn(baseOf(row), turnId)
    if (!turn) {
      notFound(res, `Turn "${turnId}" not found`)
      return
    }
    json(res, 200, turn)
  }

  /**
   * The session agent: the owner's saved agent with `agent` fields overlaid, or the inline `agent`.
   * @param body - session body.
   * @param owner - owner whose saved agents are searched.
   * @returns the resolved agent.
   * @throws AgentsApiRequestError 404 for an unknown `agent_id`, 400 when neither `agent` nor `agent_id` is usable.
   */
  private async resolveSessionAgent(body: CreateSessionParams, owner: OwnerId): Promise<OAIAgent> {
    if (typeof body.agent_id === 'string' && body.agent_id !== '') {
      const saved = await this.store.agents.get(owner, body.agent_id)
      if (!saved) throw new AgentsApiRequestError(`Agent "${body.agent_id}" not found`, 404, 'resource_not_found')
      return body.agent ? overlayAgent(saved, body.agent) : saved
    }
    if (body.agent) {
      if (typeof body.agent.model !== 'string' || body.agent.model === '') {
        throw new AgentsApiRequestError('Field "agent.model" is required when agent_id is omitted', 400, 'bad_request')
      }
      return materializeAgent({ ...body.agent, model: body.agent.model })
    }
    throw new AgentsApiRequestError('Field "agent" or "agent_id" is required', 400, 'bad_request')
  }

  private async resolveSessionWorkspace(
    environment: OAIEnvironmentConfig | undefined,
    owner: OwnerId,
    sessionId: string,
  ): Promise<{ cwd: string; environment: OAIEnvironmentConfig }> {
    if (environment?.type === 'self_hosted' && environment.workspace_directory) {
      if (!isAbsolute(environment.workspace_directory)) {
        throw new Error('environment.workspace_directory must be an absolute path')
      }
      return { cwd: environment.workspace_directory, environment }
    }
    if (environment?.type === 'local') {
      if (!environment.workspace_directory || !isAbsolute(environment.workspace_directory)) {
        throw new Error('environment.workspace_directory must be an absolute path')
      }
      return { cwd: environment.workspace_directory, environment }
    }
    if (environment?.type === 'sandbox' || (environment?.type === 'openai_hosted' && wantsHostedEnvironment(environment))) {
      return this.sandboxWorkspace(owner, sessionId, environment)
    }
    const cwd = await this.defaultWorkspace(owner, sessionId)
    if (environment === undefined || environment.type === 'none') {
      return { cwd, environment: { type: 'local', workspace_directory: cwd } }
    }
    return { cwd, environment }
  }

  /**
   * A session on a sandbox environment. `sandbox` with an `environment_id` attaches that environment;
   * otherwise (`openai_hosted` with a template id or inline fields, or `sandbox` with a `template_id`)
   * an environment is provisioned through the template's provider, else the default. The provider must
   * be able to run the agent's tools (`exec`) and apply every requested template field.
   */
  private async sandboxWorkspace(
    owner: OwnerId,
    sessionId: string,
    spec: OAISandboxEnvironment | OAIOpenAIHostedEnvironment,
  ): Promise<{ cwd: string; environment: OAIEnvironmentConfig }> {
    const bad = (message: string, code: string, status: 400 | 404 = 400) => new AgentsApiRequestError(message, status, code)
    const needsExec = (provider: SandboxProvider) => {
      if (!provider.capabilities.exec) throw bad(`sandbox provider "${provider.kind}" cannot run an agent's tools, so it cannot back a session`, 'sandbox_exec_unavailable')
    }
    if (spec.type === 'sandbox' && spec.environment_id !== undefined) {
      const record = await this.store.environments.get(owner, spec.environment_id)
      if (record === undefined) throw bad(`environment not found: ${spec.environment_id}`, 'resource_not_found', 404)
      const provider = this.sandboxes.get(record.provider)
      if (provider === undefined) throw bad(`sandbox provider "${record.provider}" is not available`, 'bad_request')
      needsExec(provider)
      if (record.status === 'failed') throw new AgentsApiRequestError(`environment ${record.id} failed${record.error ? `: ${record.error}` : ''}; create a new one`, 409, 'environment_failed')
      const directory = record.provider_metadata['workspace_directory']
      if (directory === undefined) throw bad(`environment ${record.id} has no host workspace`, 'sandbox_exec_unavailable')
      // DSH checks a session's working directory on this host too, so a short workspace such as /workspace must exist here as well.
      if (!(await stat(directory).then((info) => info.isDirectory(), () => false))) {
        throw bad(`this sandbox's workspace is ${directory}, which must also exist as a folder on the Agentry API host. Create it there (for example: sudo mkdir ${directory} && sudo chown "$USER" ${directory}) or create a new sandbox, which then uses a path that exists.`, 'sandbox_workspace_missing')
      }
      return { cwd: directory, environment: { type: 'sandbox', environment_id: record.id } }
    }
    const templateId = spec.type === 'sandbox' ? spec.template_id : typeof spec.environment_template_id === 'string' ? spec.environment_template_id : undefined
    const template = templateId === undefined ? undefined : await this.templateFor(owner, templateId)
    if (templateId !== undefined && template === undefined) throw bad(`template not found: ${templateId}`, 'resource_not_found', 404)
    const inline = spec.type === 'openai_hosted' ? parseTemplateInput(spec) : { config: {} }
    if ('error' in inline) throw bad(inline.error, 'bad_request')
    let provider: SandboxProvider
    try {
      const name = ('provider' in inline ? inline.provider : undefined) ?? template?.provider
      provider = name !== undefined ? this.sandboxes.require(name) : this.sandboxes.default()
    } catch (error: unknown) {
      throw bad(errorMessage(error), 'bad_request')
    }
    needsExec(provider)
    const config = { ...normalizeTemplateConfig(template?.config ?? {}), ...inline.config }
    const unsupported = unsupportedFields(config, provider)
    if (unsupported.length > 0) throw bad(`sandbox provider "${provider.kind}" cannot apply template fields: ${unsupported.join(', ')}`, 'sandbox_template_unsupported')
    const id = `env_${randomUUID().replaceAll('-', '')}`
    let created: Awaited<ReturnType<SandboxProvider['create']>>
    try {
      created = await provider.create(owner, id, { session_id: sessionId, template: config })
    } catch (error: unknown) {
      throw bad(errorMessage(error), 'bad_request')
    }
    if (created.status === 'failed') {
      await provider.destroy({ id, object: 'environment', status: 'failed', provider: provider.kind, provider_metadata: { ...created.handle }, created_at: 0 } as EnvironmentRecord).catch(() => {})
      throw new AgentsApiRequestError(`the sandbox could not be created${created.error ? `: ${created.error}` : ''}`, 409, 'environment_failed')
    }
    const record: EnvironmentRecord = {
      id,
      object: 'environment',
      status: created.status,
      provider: provider.kind,
      provider_metadata: provider.kind === 'local' ? { workspace_directory: created.workspacePath } : { ...created.handle },
      created_at: Math.floor(Date.now() / 1000),
      ...(templateId !== undefined ? { template_id: templateId } : {}),
      session_id: sessionId,
      ...(created.error !== undefined ? { error: created.error } : {}),
    }
    await this.store.environments.create(owner, record)
    return { cwd: created.workspacePath, environment: { type: 'sandbox', environment_id: id } }
  }

  private async defaultWorkspace(owner: OwnerId, sessionId: string): Promise<string> {
    const dir = join(this.workspacesRoot, directorySegment(owner, 'owner'), sessionId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  private async applyInputEvent(owner: OwnerId, row: SessionIndexRow, evt: OAIInputEvent): Promise<void> {
    const sessionId = row.id
    switch (evt.type) {
      case 'agent.session.input.message': {
        const text = userTextFromInput(evt.input)
        const fileIds = fileIdsFromInput(evt.input)
        await this.ingest.validate(owner, fileIds)
        if (evt.model != null || evt.reasoning?.effort !== undefined) {
          const fresh = await this.store.sessions.get(sessionId, owner)
          if (fresh === undefined) throw new AgentsApiRequestError(`Session "${sessionId}" not found`, 404, 'resource_not_found')
          await this.changeSettings(fresh, owner, {
            agent: {
              ...(evt.model == null ? {} : { model: evt.model }),
              ...(evt.reasoning?.effort === undefined ? {} : { reasoning: { effort: evt.reasoning.effort } }),
            },
          })
        }
        const attached = fileIds.length === 0
          ? undefined
          : await this.attachFiles(owner, sessionId, fileIds, configOf((await this.store.sessions.get(sessionId, owner)) ?? row).agent)
        if (text || attached !== undefined) await this.triggerTurn(SessionId(sessionId), text ?? '', attached)
        return
      }
      case 'agent.session.input.approval_response': {
        const response = parseApprovalResponse(evt)
        if (this.approvals.answer(sessionId, response.id, response.decision, response.payload) === 'not_found') {
          throw new AgentsApiRequestError(`No pending approval "${response.id}"`, 404, 'approval_not_found')
        }
        return
      }
      case 'agent.session.input.cancel': {
        this.approvals.cancelAll(sessionId)
        this.pendingBySession.get(sessionId)?.rejectAll(new Error('turn cancelled'))
        const agent = this.ctx.agents.get(SessionId(sessionId))
        agent?.cancel({ kind: 'user' }, { keepInbox: true })
        return
      }
      case 'agent.session.input.tool_result': {
        this.applyToolResult(sessionId, evt)
        return
      }
      case 'agent.session.input.function_call_output': {
        const output = typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output)
        this.applyToolResult(sessionId, {
          type: 'agent.session.input.tool_result',
          turn_id: evt.turn_id ?? this.sessionRegistry.getCurrentTurnId(sessionId) ?? '',
          call_id: evt.call_id,
          success: true,
          output,
        })
        return
      }
      default:
        return
    }
  }

  private applyToolResult(sessionId: string, evt: OAIToolResultInputEvent): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending?.has(evt.call_id)) {
      throw new AgentsApiRequestError(
        `No pending function call with call_id "${evt.call_id}"`,
        400,
        'unknown_call_id',
      )
    }
    if (evt.turn_id) {
      const current = this.sessionRegistry.getCurrentTurnId(sessionId)
      if (current !== undefined && current !== evt.turn_id) {
        throw new AgentsApiRequestError(
          `turn_id "${evt.turn_id}" does not match the open turn "${current}"`,
          400,
          'turn_mismatch',
        )
      }
    }
    const outcome = evt.success
      ? {
        success: true as const,
        output: typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output),
      }
      : { success: false as const, error: evt.error }
    if (!pending.complete(evt.call_id, outcome)) {
      throw new AgentsApiRequestError(
        `No pending function call with call_id "${evt.call_id}"`,
        400,
        'unknown_call_id',
      )
    }
  }

  private async createTemplate(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    const parsed = parseTemplateInput(await readBody(req))
    if ('error' in parsed) {
      badRequest(res, parsed.error)
      return
    }
    // The template's provider (an extension field), else the default. Unsupported fields are stored, not rejected.
    let provider: SandboxProvider
    try {
      provider = parsed.provider !== undefined ? this.sandboxes.require(parsed.provider) : this.sandboxes.default()
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
      return
    }
    const template: EnvironmentTemplate = {
      id: `tpl_${randomUUID().replaceAll('-', '')}`,
      object: 'environment.template',
      name: parsed.name ?? '',
      provider: provider.kind,
      config: parsed.config,
      created_at: Math.floor(Date.now() / 1000),
    }
    json(res, 201, toSdkTemplate(await this.store.templates.create(owner, template), provider))
  }

  /** A template by id: a built-in one, or one of the owner's. */
  private async templateFor(owner: OwnerId, id: string): Promise<EnvironmentTemplate | undefined> {
    return builtinTemplate(id) ?? await this.store.templates.get(owner, id)
  }

  private async listTemplates(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const query = listQuery(url)
    const page = await this.store.templates.list(owner, query)
    // The built-in templates lead the first page (and only it); they need the isolated sandbox provider.
    const builtins = query.after === undefined && this.sandboxes.get('sandbox') !== undefined ? [...BUILTIN_TEMPLATES] : []
    json(res, 200, { ...page, data: [...builtins, ...page.data].map(template => ({
      ...toSdkTemplate(template, this.sandboxes.get(template.provider)),
      ...(isBuiltinTemplateId(template.id) ? { built_in: true } : {}),
    })) })
  }

  private async getTemplate(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const template = await this.templateFor(owner, routeParam(params, 'template_id'))
    if (!template) {
      notFound(res, 'template not found')
      return
    }
    json(res, 200, { ...toSdkTemplate(template, this.sandboxes.get(template.provider)), ...(isBuiltinTemplateId(template.id) ? { built_in: true } : {}) })
  }

  private async updateTemplate(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const templateId = routeParam(params, 'template_id')
    if (isBuiltinTemplateId(templateId)) {
      badRequest(res, 'built-in templates cannot be changed; make your own template instead')
      return
    }
    const existing = await this.store.templates.get(owner, templateId)
    if (!existing) {
      notFound(res, 'template not found')
      return
    }
    const parsed = parseTemplateInput(await readBody(req))
    if ('error' in parsed) {
      badRequest(res, parsed.error)
      return
    }
    let provider = this.sandboxes.get(existing.provider)
    if (parsed.provider !== undefined) {
      try {
        provider = this.sandboxes.require(parsed.provider)
      } catch (error: unknown) {
        badRequest(res, errorMessage(error))
        return
      }
    }
    // Fields in the body replace the stored ones; the rest stay (an old stored layout is mapped first).
    const updated = await this.store.templates.update(owner, templateId, {
      ...existing,
      ...(parsed.name !== undefined ? { name: parsed.name ?? '' } : {}),
      ...(provider !== undefined ? { provider: provider.kind } : {}),
      config: { ...normalizeTemplateConfig(existing.config), ...parsed.config },
      updated_at: Math.floor(Date.now() / 1000),
    })
    if (!updated) {
      notFound(res, 'template not found')
      return
    }
    json(res, 200, toSdkTemplate(updated, provider))
  }

  private async deleteTemplate(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const templateId = routeParam(params, 'template_id')
    if (isBuiltinTemplateId(templateId)) {
      badRequest(res, 'built-in templates cannot be deleted')
      return
    }
    if (!await this.store.templates.delete(owner, templateId)) {
      notFound(res, 'template not found')
      return
    }
    json(res, 200, { id: templateId, object: 'agent.environment.template.deleted', deleted: true })
  }

  private async createEnvironment(req: IncomingMessage, res: ServerResponse, owner: OwnerId): Promise<void> {
    try {
      json(res, 201, await this.provisionEnvironment(owner, await readBody(req)))
    } catch (error: unknown) {
      if (error instanceof AgentsApiRequestError) {
        writeRequestError(res, error)
        return
      }
      throw error
    }
  }

  /**
   * Creates an environment for `owner` (the create route and the agent's `sandbox_create`): the requested
   * provider, else the template's, else the default. `inline` is template config used when no template is named.
   * @returns the environment's wire form. Throws AgentsApiRequestError (400) for a bad request.
   */
  async provisionEnvironment(owner: OwnerId, raw: Record<string, unknown>, inline?: EnvironmentTemplateConfig): Promise<SdkEnvironment> {
    const fail = (message: string, code = 'bad_request'): never => { throw new AgentsApiRequestError(message, 400, code) }
    const body = raw as { template_id?: string; session_id?: string; image?: string; provider?: string; name?: unknown; place?: unknown }
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length > 80)) fail('Field "name" must be a string of at most 80 characters')
    if (body.place !== undefined && (typeof body.place !== 'string' || body.place.trim() === '')) fail('Field "place" must be a non-empty string')
    const input: CreateEnvironmentInput = {
      ...(typeof body.place === 'string' ? { place: body.place.trim() } : {}),
      ...(typeof body.template_id === 'string' ? { template_id: body.template_id } : {}),
      ...(typeof body.session_id === 'string' ? { session_id: body.session_id } : {}),
      ...(typeof body.image === 'string' ? { image: body.image } : {}),
      ...(typeof body.name === 'string' && body.name.trim() !== '' ? { name: body.name.trim() } : {}),
    }
    let templateProvider: string | undefined
    if (input.template_id !== undefined) {
      const template = await this.templateFor(owner, input.template_id)
      if (template === undefined) return fail(`template not found: ${input.template_id}`)
      input.template = template.config
      templateProvider = template.provider
    } else if (inline !== undefined) {
      input.template = inline
    }
    if (input.session_id !== undefined && await this.store.sessions.get(input.session_id, owner) === undefined) fail(`session not found: ${input.session_id}`)
    // The requested provider, else the template's, else the default. A provider that is not registered (for example one that was removed) answers 400.
    let provider!: SandboxProvider
    try {
      const requested = typeof body.provider === 'string' && body.provider.trim() !== '' ? body.provider.trim() : templateProvider
      provider = requested !== undefined ? this.sandboxes.require(requested) : this.sandboxes.default()
    } catch (error: unknown) {
      fail(errorMessage(error))
    }
    if (input.place !== undefined && provider.kind !== 'sandbox') fail(`sandbox provider "${provider.kind}" has no places; "place" applies to the sandbox provider only`)
    // A template the provider cannot fully apply is stored, but nothing is provisioned from it: never ignore fields silently.
    const unsupported = input.template === undefined ? [] : unsupportedFields(input.template, provider)
    if (unsupported.length > 0) fail(`sandbox provider "${provider.kind}" cannot apply template fields: ${unsupported.join(', ')}`, 'sandbox_template_unsupported')
    const id = `env_${randomUUID().replaceAll('-', '')}`
    let created!: Awaited<ReturnType<SandboxProvider['create']>>
    try {
      created = await provider.create(owner, id, input)
    } catch (error: unknown) {
      fail(errorMessage(error))
    }
    const record: EnvironmentRecord = {
      id,
      object: 'environment',
      status: created.status,
      provider: provider.kind,
      provider_metadata: { ...(provider.kind === 'local' ? { workspace_directory: created.workspacePath } : { ...created.handle }), ...(input.name !== undefined ? { name: input.name } : {}) },
      created_at: Math.floor(Date.now() / 1000),
      ...(input.template_id !== undefined ? { template_id: input.template_id } : {}),
      ...(input.session_id !== undefined ? { session_id: input.session_id } : {}),
      ...(created.error !== undefined ? { error: created.error } : {}),
    }
    try {
      await this.store.environments.create(owner, record)
    } catch (error: unknown) {
      await provider.destroy(record).catch((destroyError: unknown) => {
        this.ctx.logger.warn(`agents-api: environment ${id} was not recorded and could not be destroyed: ${errorMessage(destroyError)}`)
      })
      throw error
    }
    return this.environmentJson(owner, record)
  }

  private async listEnvironments(res: ServerResponse, url: URL, owner: OwnerId): Promise<void> {
    const page = await this.store.environments.list(owner, listQuery(url))
    json(res, 200, { ...page, data: await Promise.all(page.data.map(record => this.environmentJson(owner, record))) })
  }

  /** Read the backend status and store it when it changed. */
  private async getEnvironment(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    let status: EnvironmentStatus
    let error: string | undefined
    try {
      const provider = this.sandboxes.get(record.provider)
      if (provider === undefined) throw new Error(`sandbox provider "${record.provider}" is not available`)
      status = await provider.status(record)
    } catch (statusError: unknown) {
      status = 'failed'
      error = errorMessage(statusError)
    }
    if (status === record.status && error === undefined) {
      json(res, 200, await this.environmentJson(owner, record))
      return
    }
    const { error: _previous, ...rest } = record
    const next: EnvironmentRecord = {
      ...rest,
      status,
      updated_at: Math.floor(Date.now() / 1000),
      ...(error !== undefined ? { error } : status === 'failed' && record.error !== undefined ? { error: record.error } : {}),
    }
    json(res, 200, await this.environmentJson(owner, await this.store.environments.update(owner, record.id, next) ?? next))
  }

  /**
   * Start, stop or reset an environment's sandbox (Agentry Sandbox only; `local` has no lifecycle).
   * Answers the environment as `GET` would, or the service's refusal with its status (429 quota, 503 down).
   */
  private async environmentAction(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId, action: 'start' | 'stop' | 'reset'): Promise<void> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    const provider = this.sandboxes.get(record.provider) as Partial<AgentrySandboxProvider> | undefined
    const sandboxId = record.provider_metadata['sandbox_id']
    if (provider?.api === undefined || sandboxId === undefined) {
      json(res, 409, { error: { type: 'invalid_request_error', code: 'environment_not_startable', message: 'This environment does not start or stop.' } })
      return
    }
    const body = action === 'reset' ? await readBody(req).catch(() => ({})) : {}
    const api = provider.api(owner)
    try {
      if (action === 'start') await api.start(sandboxId)
      else if (action === 'stop') await api.stop(sandboxId)
      else await api.reset(sandboxId, { keepWorkspace: (body as { keep_workspace?: unknown }).keep_workspace !== false })
    } catch (e: unknown) {
      const status = e instanceof SandboxApiError && e.status >= 400 ? e.status : 502
      json(res, status, { error: { type: 'invalid_request_error', code: e instanceof SandboxApiError ? e.code : 'sandbox_error', message: errorMessage(e) } })
      return
    }
    if (action !== 'start') this.terminals.closeEnvironment(record.id)
    if (action === 'reset') forgetWorkspaceAlias(sandboxId)
    await this.getEnvironment(res, params, owner)
  }

  /** The sandbox behind a terminal route's environment, or the error response already sent. */
  private async terminalTarget(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<{ record: EnvironmentRecord; provider: AgentrySandboxProvider; sandboxId: string } | undefined> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return undefined
    }
    const provider = this.sandboxes.get(record.provider) as Partial<AgentrySandboxProvider> | undefined
    const sandboxId = record.provider_metadata['sandbox_id']
    if (provider?.api === undefined || sandboxId === undefined) {
      json(res, 409, { error: { type: 'invalid_request_error', code: 'environment_no_terminal', message: 'This environment has no terminal; only sandboxes do.' } })
      return undefined
    }
    return { record, provider: provider as AgentrySandboxProvider, sandboxId }
  }

  private terminalError(res: ServerResponse, error: unknown): void {
    if (error instanceof TerminalError) json(res, error.status, { error: { type: 'invalid_request_error', code: error.code, message: error.message } })
    else if (error instanceof SandboxApiError) json(res, error.status >= 400 ? error.status : 502, { error: { type: 'invalid_request_error', code: error.code, message: errorMessage(error) } })
    else json(res, 502, { error: { type: 'invalid_request_error', code: 'terminal_unavailable', message: errorMessage(error) } })
  }

  private async openTerminal(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const target = await this.terminalTarget(res, params, owner)
    if (!target) return
    const body = await readBody(req).catch(() => ({})) as { cols?: unknown; rows?: unknown }
    try {
      const api = target.provider.api(owner)
      await api.start(target.sandboxId)
      // The shell starts in the sandbox's workspace, like sandbox_exec and a chat on this environment; ~ holds installs.
      const directory = target.record.provider_metadata['workspace_directory']
      const envd = api.envd(target.sandboxId)
      const workspace = directory ? await workspaceOf(target.sandboxId, envd, directory) : undefined
      const id = await this.terminals.open(owner, target.record.id, envd, { ...(workspace ? { cwd: workspace } : {}), cols: body.cols, rows: body.rows })
      json(res, 200, { id, object: 'environment.terminal', environment_id: target.record.id })
    } catch (error) {
      this.terminalError(res, error)
    }
  }

  private async streamTerminal(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!await this.store.environments.get(owner, environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    let detach: (() => void) | undefined
    try {
      writeSSEHeaders(res)
      const open = (): boolean => !res.writableEnded && !res.destroyed
      detach = this.terminals.attach(owner, environmentId, routeParam(params, 'terminal_id'), (event) => {
        if (!open()) return
        if (event.kind === 'output') writeEvent(res, 'output', { data: Buffer.from(event.data).toString('base64') })
        else writeEvent(res, 'exit', { code: event.code })
      })
    } catch (error) {
      if (!res.headersSent) this.terminalError(res, error)
      else res.end()
      return
    }
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n') }, 20_000)
    req.on('close', () => {
      clearInterval(ping)
      detach?.()
    })
  }

  private async terminalCall(req: IncomingMessage | undefined, res: ServerResponse, params: Record<string, string>, owner: OwnerId, action: 'input' | 'resize' | 'close'): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    if (!await this.store.environments.get(owner, environmentId)) {
      notFound(res, 'environment not found')
      return
    }
    const id = routeParam(params, 'terminal_id')
    try {
      const body = req ? await readBody(req).catch(() => ({})) as { data?: unknown; cols?: unknown; rows?: unknown } : {}
      if (action === 'input') await this.terminals.input(owner, environmentId, id, body.data)
      else if (action === 'resize') await this.terminals.resize(owner, environmentId, id, body.cols, body.rows)
      else this.terminals.close(owner, environmentId, id)
      json(res, 200, { id, object: 'environment.terminal', ...(action === 'close' ? { deleted: true } : {}) })
    } catch (error) {
      this.terminalError(res, error)
    }
  }

  private async deleteEnvironment(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const environmentId = routeParam(params, 'environment_id')
    const record = await this.store.environments.get(owner, environmentId)
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    await this.destroyEnvironment(record)
    await this.store.environments.delete(owner, environmentId)
    json(res, 200, { id: environmentId, object: 'environment.deleted', deleted: true })
  }

  /**
   * Destroy and forget every environment of `owner` attached to a session.
   * @param owner - session owner.
   * @param sessionId - deleted session.
   */
  private async deleteEnvironmentsForSession(owner: OwnerId, sessionId: string): Promise<void> {
    const attached: EnvironmentRecord[] = []
    let after: string | undefined
    for (;;) {
      const page = await this.store.environments.list(owner, { limit: 100, order: 'asc', ...(after === undefined ? {} : { after }) })
      attached.push(...page.data.filter(env => env.session_id === sessionId))
      if (!page.has_more || page.last_id === null) break
      after = page.last_id
    }
    for (const env of attached) {
      await this.destroyEnvironment(env)
      await this.store.environments.delete(owner, env.id)
    }
  }

  /**
   * Remove an environment's backend. A record whose provider is not registered (for example a
   * removed one) has no backend to clean: log it and let the caller drop the record.
   */
  private async destroyEnvironment(record: EnvironmentRecord): Promise<void> {
    this.terminals.closeEnvironment(record.id)
    forgetWorkspaceAlias(record.provider_metadata['sandbox_id'] ?? '')
    const provider = this.sandboxes.get(record.provider)
    if (provider === undefined) {
      this.ctx.logger.warn(`agents-api: environment ${record.id} uses sandbox provider "${record.provider}", which is not registered; removing the record without cleaning a backend`)
      return
    }
    const sandboxId = record.provider_metadata['sandbox_id']
    if (sandboxId !== undefined) await this.sandboxPresets?.evict(sandboxId)
    await provider.destroy(record)
  }

  /** The wire form of an environment: the SDK `agent.environment`, with the resources of its template when it still exists. */
  private async environmentJson(owner: OwnerId, record: EnvironmentRecord): Promise<SdkEnvironment> {
    const provider = this.sandboxes.get(record.provider) as Partial<AgentrySandboxProvider> | undefined
    const [template, sandbox] = await Promise.all([
      record.template_id === undefined ? undefined : this.templateFor(owner, record.template_id),
      typeof provider?.describe === 'function' ? provider.describe(record) : undefined,
    ])
    const out = toSdkEnvironment(record, template)
    const name = record.provider_metadata['name']
    return { ...out, ...(name !== undefined ? { name } : {}), ...(sandbox !== undefined ? { sandbox } : {}) }
  }

  /** The provider behind a record, or a 400 answer when it is not registered. */
  private providerOr400(res: ServerResponse, record: EnvironmentRecord): SandboxProvider | undefined {
    const provider = this.sandboxes.get(record.provider)
    if (provider === undefined) badRequest(res, `sandbox provider "${record.provider}" is not available`)
    return provider
  }

  private async writeEnvironmentFile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    const write = parseFileWrite(await readBody(req))
    if ('error' in write) {
      badRequest(res, write.error)
      return
    }
    if (write.kind === 'file_id') {
      badRequest(res, 'a file referenced by file_id cannot be copied into a live environment yet; send it inline as {"type":"inline","path","data"}')
      return
    }
    const provider = this.providerOr400(res, record)
    if (provider === undefined) return
    try {
      await provider.writeFile(record, write.path, write.bytes)
      const file: SdkEnvironmentFile = { object: 'agent.environment.file', environment_id: record.id, path: absoluteFilePath(write.path), size_bytes: write.bytes.length }
      json(res, 201, file)
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async listEnvironmentFiles(res: ServerResponse, url: URL, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    const query = parseFileListQuery(url)
    if ('error' in query) {
      badRequest(res, query.error)
      return
    }
    const provider = this.providerOr400(res, record)
    if (provider === undefined) return
    try {
      const page = selectFilePage(await provider.listFiles(record), query)
      // Sizes are read for the page only.
      const data: SdkEnvironmentFile[] = await Promise.all(page.items.map(async relative => ({
        object: 'agent.environment.file' as const,
        environment_id: record.id,
        path: absoluteFilePath(relative),
        size_bytes: (await provider.readFile(record, relative)).length,
      })))
      json(res, 200, { object: 'list', data, has_more: page.has_more, ...(page.next !== undefined ? { next: page.next } : {}) })
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async readEnvironmentFile(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const record = await this.store.environments.get(owner, routeParam(params, 'environment_id'))
    if (!record) {
      notFound(res, 'environment not found')
      return
    }
    const filePath = params['path'] ?? ''
    if (filePath.trim() === '') {
      badRequest(res, 'file path is required')
      return
    }
    const provider = this.providerOr400(res, record)
    if (provider === undefined) return
    try {
      const bytes = await provider.readFile(record, filePath)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(Buffer.from(bytes))
    } catch (error: unknown) {
      badRequest(res, errorMessage(error))
    }
  }

  private async listArtifacts(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!await this.requireSession(res, owner, sessionId)) return
    // A sandbox session's files live in the sandbox, whatever artifact store is configured.
    const sandbox = await this.sandboxOfSession(owner, sessionId)
    if (sandbox !== undefined) {
      try {
        json(res, 200, { object: 'list', data: await sandbox.provider.listEntries(sandbox.record) })
      } catch (e: unknown) {
        json(res, 503, { error: { type: 'server_error', code: 'sandbox_unavailable', message: errorMessage(e) } })
      }
      return
    }
    if (this.artifacts !== undefined) {
      json(res, 200, { object: 'list', data: await listS3Artifacts(this.artifacts, sessionId) })
      return
    }
    const workspace = await this.workspaceOf(res, sessionId)
    if (workspace === undefined) return
    json(res, 200, { object: 'list', data: await listWorkspaceArtifacts(workspace) })
  }

  private async listDeliverables(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    const row = await this.requireSession(res, owner, sessionId)
    if (!row) return
    // A running session can present more files at any moment; otherwise the log is fixed until the row changes.
    const live = this.sessionRegistry.getOAISession(sessionId)?.status
    const version = live === 'in_progress' || live === 'requires_action' ? undefined : `${String(row.updatedAt.getTime())}:${row.status}`
    const data = await this.deliverablesCache.get(sessionId, version, async () => {
      const workspace = this.sessionRegistry.get(sessionId)?.workspace ?? await this.history.workspace(sessionId)
      const root = workspace === undefined ? undefined : `${workspace.replace(/\/+$/, '')}/`
      return (await this.history.deliverables(sessionId)).map(entry =>
        root !== undefined && entry.path.startsWith(root) ? { ...entry, path: entry.path.slice(root.length) } : entry)
    })
    json(res, 200, { object: 'list', data })
  }

  private async getArtifact(res: ServerResponse, params: Record<string, string>, owner: OwnerId, download: boolean): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!await this.requireSession(res, owner, sessionId)) return
    const rawPath = params['path'] ?? ''
    if (sanitizeRelativePath(rawPath) === undefined) {
      badRequest(res, 'artifact path escapes the session workspace')
      return
    }
    let body: Awaited<ReturnType<typeof getS3Artifact>>
    const sandbox = await this.sandboxOfSession(owner, sessionId)
    if (sandbox !== undefined) {
      try {
        const size = await sandbox.provider.fileSize(sandbox.record, rawPath)
        if (size !== undefined && size > MAX_ARTIFACT_BYTES) {
          json(res, 413, { error: { type: 'invalid_request_error', code: 'file_too_large', message: `artifacts over ${String(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB are not served` } })
          return
        }
        body = size === undefined ? undefined : Buffer.from(await sandbox.provider.readFile(sandbox.record, rawPath))
      } catch (e: unknown) {
        if (/invalid workspace path/.test(errorMessage(e))) { badRequest(res, 'artifact path escapes the session workspace'); return }
        json(res, 503, { error: { type: 'server_error', code: 'sandbox_unavailable', message: errorMessage(e) } })
        return
      }
    } else if (this.artifacts !== undefined) {
      body = await getS3Artifact(this.artifacts, sessionId, rawPath)
    } else {
      const workspace = await this.workspaceOf(res, sessionId)
      if (workspace === undefined) return
      body = await getWorkspaceArtifact(workspace, rawPath)
    }
    if (body === undefined) {
      notFound(res, 'artifact not found')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', artifactContentType(rawPath))
    res.setHeader('Content-Disposition', artifactContentDisposition(rawPath, download))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.end(body)
  }

  /**
   * Working directory of a session: the live one, else the Session log header's.
   * @param res - response that receives a 404 when neither is known.
   * @param sessionId - session id.
   * @returns the absolute directory, or `undefined` after a 404 was written.
   */
  private async workspaceOf(res: ServerResponse, sessionId: string): Promise<string | undefined> {
    const workspace = this.sessionRegistry.get(sessionId)?.workspace ?? await this.history.workspace(sessionId)
    if (workspace === undefined) notFound(res, `Session "${sessionId}" has no workspace`)
    return workspace
  }

  private async listSubagents(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const sessionId = routeParam(params, 'session_id')
    if (!await this.requireSession(res, owner, sessionId)) return
    json(res, 200, {
      object: 'list',
      data: this.sessionRegistry.listSubagents(sessionId).map(projectSubagent),
    })
  }

  private async getSubagent(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const located = await this.requireSubagent(res, params, owner)
    if (!located) return
    json(res, 200, projectSubagent(located.child))
  }

  private async listSubagentTurns(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const located = await this.requireSubagent(res, params, owner)
    if (!located) return
    json(res, 200, { object: 'list', data: this.sessionRegistry.listChildTurns(located.sessionId, located.subagentId) ?? [] })
  }

  private async getSubagentTurn(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const located = await this.requireSubagent(res, params, owner)
    if (!located) return
    const turn = this.sessionRegistry.getChildTurn(located.sessionId, located.subagentId, routeParam(params, 'turn_id'))
    if (!turn) {
      notFound(res, 'turn not found')
      return
    }
    json(res, 200, turn)
  }

  private async listSubagentItems(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const located = await this.requireSubagent(res, params, owner)
    if (!located) return
    json(res, 200, { object: 'list', data: this.sessionRegistry.listChildItems(located.sessionId, located.subagentId) ?? [] })
  }

  private async listSubagentTurnItems(res: ServerResponse, params: Record<string, string>, owner: OwnerId): Promise<void> {
    const located = await this.requireSubagent(res, params, owner)
    if (!located) return
    const turnId = routeParam(params, 'turn_id')
    if (!this.sessionRegistry.getChildTurn(located.sessionId, located.subagentId, turnId)) {
      notFound(res, 'turn not found')
      return
    }
    const items = (this.sessionRegistry.listChildItems(located.sessionId, located.subagentId) ?? [])
      .filter(item => item.turn_id === turnId)
    json(res, 200, { object: 'list', data: items })
  }

  private async requireSubagent(
    res: ServerResponse,
    params: Record<string, string>,
    owner: OwnerId,
  ): Promise<{ sessionId: string; subagentId: string; child: SubagentState } | undefined> {
    const sessionId = routeParam(params, 'session_id')
    const subagentId = routeParam(params, 'subagent_id')
    if (!await this.requireSession(res, owner, sessionId)) return undefined
    const child = this.sessionRegistry.getSubagent(sessionId, subagentId)
    if (!child) {
      notFound(res, 'subagent not found')
      return undefined
    }
    return { sessionId, subagentId, child }
  }

  /**
   * Check the file ids of every message event in a batch before any event is applied.
   * @param owner - authenticated caller.
   * @param batch - input events of one request.
   * @throws AgentsApiRequestError as `AttachmentIngest.validate`, 400 `duplicate_file_id` when two events use one id, or 400 `unsupported_content_part`.
   */
  private async validateBatchFiles(owner: OwnerId, batch: readonly OAIInputEvent[]): Promise<void> {
    const seen = new Set<string>()
    for (const evt of batch) {
      if (evt.type !== 'agent.session.input.message') continue
      const ids = fileIdsFromInput(evt.input)
      for (const id of ids) {
        if (seen.has(id)) throw new AgentsApiRequestError('The same file id is used more than once', 400, 'duplicate_file_id')
        seen.add(id)
      }
      await this.ingest.validate(owner, ids)
    }
  }

  /**
   * Attach staged files to a session's next message.
   * @param owner - authenticated caller.
   * @param sessionId - session the message goes to.
   * @param fileIds - staged file ids.
   * @param agent - the session agent, to decide whether images go to the model as images.
   * @returns the blocks, note, and commit and rollback callbacks.
   * @throws AgentsApiRequestError as `AttachmentIngest.attach`.
   */
  private async attachFiles(owner: OwnerId, sessionId: string, fileIds: readonly string[], agent: OAIAgent): Promise<AttachedFiles> {
    const cwd = this.sessionRegistry.get(sessionId)?.workspace ?? await this.history.workspace(sessionId)
    if (cwd === undefined) throw new AgentsApiRequestError(`Session "${sessionId}" has no workspace`, 409, 'uploads_unsafe')
    const sandbox = await this.sandboxOfSession(owner, sessionId)
    return this.ingest.attach({
      owner, sessionId, cwd, ids: fileIds, supportsImages: () => this.routeAcceptsImages(agent),
      ...(sandbox === undefined ? {} : { copy: (name: string, source: AsyncIterable<Uint8Array>) => copyIntoSandboxUploads(sandbox.provider, sandbox.record, name, source) }),
    })
  }

  /** Whether a session environment is an Agentry Sandbox environment. */
  private async sandboxEnvironmentOf(owner: OwnerId, environment: OAIEnvironmentConfig | undefined): Promise<boolean> {
    if (environment?.type !== 'sandbox' || environment.environment_id === undefined) return false
    const record = await this.store.environments.get(owner, environment.environment_id)
    return record?.provider === 'sandbox' && record.provider_metadata['sandbox_id'] !== undefined
  }

  /**
   * The Agentry Sandbox a session runs in, when its environment is one: its workspace lives
   * there, not on host disk (the host path is an empty placeholder).
   */
  private async sandboxOfSession(owner: OwnerId, sessionId: string): Promise<{ provider: AgentrySandboxProvider; record: EnvironmentRecord } | undefined> {
    const row = await this.store.sessions.get(sessionId, owner)
    const environment = row === undefined ? undefined : configOf(row).environment
    if (environment?.type !== 'sandbox' || environment.environment_id === undefined) return undefined
    const record = await this.store.environments.get(owner, environment.environment_id)
    if (record === undefined || record.provider_metadata['sandbox_id'] === undefined) return undefined
    const provider = this.sandboxes.get(record.provider) as Partial<AgentrySandboxProvider> | undefined
    if (typeof provider?.listEntries !== 'function') return undefined
    return { provider: provider as AgentrySandboxProvider, record }
  }

  /**
   * Whether the session's model route takes images: its `inputModalities` lists `image`, or lists nothing (the
   * permissive rule DSH's own prompt path applies). A failed lookup counts as no.
   * @param agent - session agent.
   */
  private async routeAcceptsImages(agent: OAIAgent): Promise<boolean> {
    try {
      const { provider, model } = await this.agentOptionsFor(agent)
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      return info.inputModalities === undefined || info.inputModalities.includes('image')
    } catch (error: unknown) {
      this.ctx.logger.warn(`agents-api: could not resolve model modalities: ${errorMessage(error)}`)
      return false
    }
  }

  private triggerTurn(sessionId: string, userText: string, attached?: AttachedFiles): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const agent = this.ctx.agents.get(SessionId(sessionId))
        if (!agent) throw new Error(`Agent "${sessionId}" is not running`)
        const message = createUserMessage({
          content: [
            ...(userText === '' ? [] : [{ type: 'text' as const, text: userText }]),
            ...(attached === undefined ? [] : [...attached.blocks, { type: 'text' as const, text: attached.note }]),
          ],
          source: { kind: 'user' },
        })
        const status = this.sessionRegistry.get(sessionId)?.projector.status
        if (status === 'in_progress' || status === 'requires_action') {
          agent.steer(message)
        } else {
          agent.followup(message)
        }
      } catch (error) {
        void (attached?.rollback() ?? Promise.resolve()).then(() => {
          reject(error instanceof Error ? error : new Error(errorMessage(error)))
        })
        return
      }
      void (attached?.commit() ?? Promise.resolve()).then(() => {
        resolve()
      })
    })
  }
}

/**
 * Provider that owns `model`. The profile default is used when it lists the
 * model, or when no catalog is available. Otherwise the first configured
 * provider that lists the id is used, so a CoreWork model string is not sent
 * to an unrelated default route.
 * @param ctx - host context that may expose `llm`.
 * @param model - model id from the session agent.
 * @param fallback - `agentDefaultModel` provider.
 */
async function providerForModel(ctx: Context, model: string, fallback: string): Promise<string> {
  return (await lookUpModel(ctx, model, fallback)).provider
}

/**
 * Find the provider that lists a model, and whether the model is known at all.
 * `known` is `false` only when every provider's list was read and none had the
 * model; it is `undefined` when the lists cannot say (no `llm` service, or a
 * provider failed to list).
 * @param ctx - host context.
 * @param model - model id.
 * @param fallback - `agentDefaultModel` provider.
 */
async function lookUpModel(ctx: Context, model: string, fallback: string): Promise<{ provider: string; known: boolean | undefined }> {
  const get = (ctx as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return { provider: fallback, known: undefined }
  let llm: {
    listProviders?: () => ReadonlyArray<{ id: string }>
    listModels?: (provider: string) => Promise<ReadonlyArray<{ id: string }>>
  } | undefined
  try {
    llm = get.call(ctx, 'llm') as typeof llm
  } catch {
    return { provider: fallback, known: undefined }
  }
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { provider: fallback, known: undefined }
  }
  const ids = llm.listProviders().map(provider => provider.id)
  const ordered = ids.includes(fallback) ? [fallback, ...ids.filter(id => id !== fallback)] : ids
  let complete = ordered.length > 0
  for (const provider of ordered) {
    let models: ReadonlyArray<{ id: string }>
    try {
      models = await llm.listModels(provider)
    } catch {
      complete = false
      continue
    }
    if (models.some(row => row.id === model)) return { provider, known: true }
  }
  return { provider: fallback, known: complete ? false : undefined }
}

/**
 * Mount the profile's default agent preset so the session sees its tools.
 * A profile without `agentPresets` keeps the global tool layer.
 * @param agentCtx - agent-scoped context from `agents.create` setup.
 */
async function mountDefaultPreset(agentCtx: Context, id: string = AGENTRY_PRESET_ID): Promise<void> {
  const get = (agentCtx as { get?: (name: string) => unknown }).get
  if (typeof get !== 'function') return
  let presets: { mount?: (ctx: Context, id?: string) => Promise<unknown> } | undefined
  try {
    presets = get.call(agentCtx, 'agentPresets') as typeof presets
  } catch {
    return
  }
  if (presets === undefined || typeof presets.mount !== 'function') return
  await presets.mount(agentCtx, id)
}

/**
 * Accept CoreAgent's event list, a single input event, or a bare `{ input }`.
 * @param body - POST /events JSON.
 */
function inputEventsFromBody(body: Record<string, unknown>): OAIInputEvent[] {
  if (Array.isArray(body['events'])) return body['events'] as OAIInputEvent[]
  const type = body['type']
  if (typeof type === 'string' && type.startsWith('agent.session.input.')) {
    return [body as unknown as OAIInputEvent]
  }
  if ('input' in body) {
    return [{ type: 'agent.session.input.message', input: body['input'] } as OAIInputEvent]
  }
  return []
}

/** Keys of a hosted environment that ask for something to be provisioned (a template or inline template fields). */
const HOSTED_FIELDS = ['environment_template_id', 'files', 'env', 'network', 'packages', 'plugins', 'skills', 'setup_commands', 'capability_directories', 'provider', 'image'] as const

/** Whether an `openai_hosted` environment names a template or inline fields; a bare one provisions nothing. */
function wantsHostedEnvironment(environment: OAIOpenAIHostedEnvironment): boolean {
  return HOSTED_FIELDS.some(field => environment[field] !== undefined && environment[field] !== null)
}

/**
 * Hide Host catalog rows outside a session's saved `host_tools` mask.
 * @param rows - full catalog.
 * @param hostTools - allow and deny lists from the session agent.
 */
function maskHostCatalog<T extends { name: string }>(
  rows: T[],
  hostTools: OAIHostToolsConfig | null | undefined,
): T[] {
  if (!hostTools) return rows
  let out = rows
  if (hostTools.allow !== undefined && hostTools.allow !== null && hostTools.allow.length > 0) {
    const allow = new Set(hostTools.allow)
    out = out.filter(row => allow.has(row.name))
  }
  if (hostTools.deny !== undefined && hostTools.deny !== null && hostTools.deny.length > 0) {
    const deny = new Set(hostTools.deny)
    out = out.filter(row => !deny.has(row.name))
  }
  return out
}

/**
 * Wire shape for a subagent. Turns and items stay on their own routes.
 * @param child - stored child.
 */
function projectSubagent(child: SubagentState): Omit<SubagentState, 'turns' | 'items' | 'currentTurnId'> {
  return {
    id: child.id,
    object: child.object,
    session_id: child.session_id,
    parent_session_id: child.parent_session_id,
    status: child.status,
    created_at: child.created_at,
    ...(child.closed_at !== undefined ? { closed_at: child.closed_at } : {}),
  }
}

/**
 * Write the 503 answered while the store is opening, failed, or rejecting calls.
 * @param res - outgoing response.
 * @param message - outage detail.
 */
function storeUnavailable(res: ServerResponse, message: string): void {
  json(res, 503, { error: { type: 'server_error', message, code: 'store_unavailable' } })
}
