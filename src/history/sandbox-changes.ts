/**
 * Per-turn changed files for sandbox chats. DSH's `workspace-changes`
 * recorder runs git and reads files through the Host's own `subprocess` and
 * `fs`, so it never sees a sandbox's workspace. This recorder does the same
 * job inside the sandbox through envd: a shadow repository at
 * `/tmp/agentry-changes/<session>.git` (the user's own `.git` is never
 * touched) snapshots the workspace with `git add -A` + `write-tree` at turn
 * start and end, `diff-tree --numstat` lists the changes, `git diff` serves
 * one file's hunks.
 *
 * Summaries live in this process's memory (lost on restart); the snapshots
 * live in the sandbox's `/tmp` (gone after Stop or Reset, when diffs answer
 * 404). A failure logs one line and leaves the turn without a summary.
 */
import { parseNumstat, parseUnifiedDiff } from './numstat.ts'
import type { ChangesSummary, FileDiff } from './turn-changes.ts'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** Output went over the cap and was cut. */
  truncated?: boolean
}

/** Where a session's commands run, or `undefined` for a session that is not on a sandbox. */
export interface SandboxTarget {
  /** Workspace directory inside the sandbox. */
  dir: string
  exec(script: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>
}

export interface SandboxChangesDeps {
  target(sessionId: string): Promise<SandboxTarget | undefined>
  warn(message: string): void
  /** Files listed per summary (the total still counts all); DSH's default is 500. */
  maxFiles?: number
  /** Diff output above this is served as `oversized`; DSH's default is 2 MB. */
  maxDiffBytes?: number
}

interface TurnRecord {
  before: string
  after: string
  summary: ChangesSummary
}

interface SessionState {
  chain: Promise<void>
  open?: { turnId: string; turn: number; before?: string } | undefined
  turns: Map<string, TurnRecord>
  /** Turn numbers handed out to records (the wire does not use them). */
  counter: number
}

/** Shell-quote one argument. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Shadow repository location for a session (ids are reduced to a safe name). */
export const shadowDir = (sessionId: string): string => `/tmp/agentry-changes/${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.git`

const env = (sessionId: string, dir: string): string => {
  const g = shadowDir(sessionId)
  return `export GIT_DIR=${sq(g)} GIT_WORK_TREE=${sq(dir)} GIT_INDEX_FILE=${sq(`${g}/agentry-index`)} GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0`
}

/** The snapshot script: create the shadow repository once, stage everything, print the tree id. */
export function snapshotScript(sessionId: string, dir: string): string {
  const g = shadowDir(sessionId)
  return [
    'set -e',
    `cd ${sq(dir)}`,
    `if [ ! -d ${sq(g)} ]; then mkdir -p /tmp/agentry-changes && git init -q --bare ${sq(g)}; fi`,
    // Rewritten every time so shadow repositories made before `.browser/` was excluded pick it up too.
    `mkdir -p ${sq(`${g}/info`)} && printf '%s\\n' node_modules/ __pycache__/ .venv/ /.browser/ > ${sq(`${g}/info/exclude`)}`,
    env(sessionId, dir),
    'git -c core.autocrlf=false -c core.safecrlf=false add -A --ignore-errors -- . >/dev/null 2>&1 || true',
    'git write-tree',
  ].join('\n')
}

const TREE = /^[0-9a-f]{40,64}$/

export class SandboxChanges {
  private readonly sessions = new Map<string, SessionState>()
  private readonly maxFiles: number
  private readonly maxDiffBytes: number

  constructor(private readonly deps: SandboxChangesDeps) {
    this.maxFiles = deps.maxFiles ?? 500
    this.maxDiffBytes = deps.maxDiffBytes ?? 2 * 1024 * 1024
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { chain: Promise.resolve(), turns: new Map(), counter: 0 }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private enqueue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const state = this.state(sessionId)
    state.chain = state.chain.then(work).catch((error: unknown) => {
      this.deps.warn(`agents-api: sandbox changes for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return state.chain
  }

  private async snapshot(sessionId: string, target: SandboxTarget): Promise<string> {
    const out = await target.exec(snapshotScript(sessionId, target.dir), { timeoutMs: 30_000 })
    const tree = out.stdout.trim().split('\n').pop() ?? ''
    if (out.code !== 0 || !TREE.test(tree)) throw new Error(`snapshot failed (exit ${String(out.code)}): ${out.stderr.trim().slice(0, 200)}`)
    return tree
  }

  /**
   * A top-level turn started: take the baseline snapshot (sessions not on a sandbox are ignored).
   * @param sessionId - session id.
   * @param turnId - `turn_<seq of turn/start>`.
   */
  start(sessionId: string, turnId: string): void {
    const state = this.state(sessionId)
    const open: NonNullable<SessionState['open']> = { turnId, turn: ++state.counter }
    state.open = open
    void this.enqueue(sessionId, async () => {
      const target = await this.deps.target(sessionId)
      if (target === undefined) {
        this.sessions.delete(sessionId)
        return
      }
      open.before = await this.snapshot(sessionId, target)
    })
  }

  /** Queues a wait for `work` (a file still being written, such as a browser recording) before the next snapshot. */
  hold(sessionId: string, work: Promise<unknown>): void {
    if (!this.sessions.has(sessionId)) return
    void this.enqueue(sessionId, async () => { await work.catch(() => {}) })
  }

  /** The open turn ended: take the end snapshot and keep the summary when anything changed. */
  end(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    const open = state?.open
    if (state === undefined || open === undefined) return
    state.open = undefined
    void this.enqueue(sessionId, async () => {
      if (open.before === undefined) return
      const target = await this.deps.target(sessionId)
      if (target === undefined) return
      const after = await this.snapshot(sessionId, target)
      if (after === open.before) return
      const out = await target.exec(`${env(sessionId, target.dir)}\ngit diff-tree -r -z --numstat --no-renames ${open.before} ${after}`, { timeoutMs: 30_000 })
      if (out.code !== 0 || out.truncated) throw new Error(`diff-tree failed (exit ${String(out.code)})`)
      const entries = parseNumstat(out.stdout).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      if (entries.length === 0) return
      state.turns.set(open.turnId, {
        before: open.before,
        after,
        summary: {
          turn: open.turn,
          files: entries.slice(0, this.maxFiles).map(entry => ({ path: entry.path, display: entry.path, added: entry.added, deleted: entry.deleted, ...(entry.binary ? { binary: true as const } : {}) })),
          total: entries.length,
          added: entries.reduce((sum, entry) => sum + entry.added, 0),
          deleted: entries.reduce((sum, entry) => sum + entry.deleted, 0),
        },
      })
    })
  }

  /** Resolves when the session's queued snapshots have settled (tools wait on it so a snapshot never races an edit). */
  settled(sessionId: string): Promise<void> {
    return this.sessions.get(sessionId)?.chain ?? Promise.resolve()
  }

  /** Whether this recorder handles the session (it has seen a sandbox turn for it). */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** @returns the turn's summary after pending work settles, or `undefined`. */
  async summary(sessionId: string, turnId: string): Promise<ChangesSummary | undefined> {
    await this.settled(sessionId)
    return this.sessions.get(sessionId)?.turns.get(turnId)?.summary
  }

  /** @returns turn ids with a summary, oldest first. */
  async list(sessionId: string): Promise<Array<{ turnId: string; summary: ChangesSummary }>> {
    await this.settled(sessionId)
    return [...this.sessions.get(sessionId)?.turns ?? []].map(([turnId, record]) => ({ turnId, summary: record.summary }))
  }

  /**
   * One listed file's comparison, read from the snapshots in the sandbox.
   * @returns the diff, or `undefined` when the turn, the index or the snapshots are gone.
   */
  async diff(sessionId: string, turnId: string, index: number, signal: AbortSignal): Promise<FileDiff | undefined> {
    await this.settled(sessionId)
    const record = this.sessions.get(sessionId)?.turns.get(turnId)
    const file = record?.summary.files[index]
    if (record === undefined || file === undefined) return undefined
    if (file.binary) return { kind: 'binary', path: file.path, display: file.display }
    const target = await this.deps.target(sessionId)
    if (target === undefined) return undefined
    const out = await target.exec(
      `${env(sessionId, target.dir)}\ngit diff --no-color --no-ext-diff --no-renames -U3 ${record.before} ${record.after} -- ${sq(file.path)}`,
      { timeoutMs: 30_000, signal },
    )
    if (out.truncated || out.stdout.length > this.maxDiffBytes) return { kind: 'oversized', path: file.path, display: file.display }
    // The snapshots are gone (sandbox stopped or reset): nothing to compare.
    if (out.code !== 0) return undefined
    const parsed = parseUnifiedDiff(out.stdout)
    if (parsed.binary) return { kind: 'binary', path: file.path, display: file.display }
    return { kind: 'text', path: file.path, display: file.display, before: parsed.before, after: parsed.after, hunks: parsed.hunks, coarse: false }
  }

  /** Drop a session's records (it was deleted). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
