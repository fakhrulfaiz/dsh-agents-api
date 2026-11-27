/**
 * `browser_recording_start` and `browser_recording_stop`: the agent records what its browser shows into a video
 * in the workspace (`recordings/<name>.webm`, with `<name>.cursor.jsonl` for the pointer). Registered by
 * `gateway.ts` `mountBrowser()` right after the browser MCP, so only where the browser tools are (a sandbox
 * chat whose agent has the browser on, or auto with a sandbox image that has it).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BrowserRecordingError, type BrowserRecorder, type RecordingResult, type RecordingTarget } from './sandbox/browser-recording.ts'

export const BROWSER_RECORDING_START = 'browser_recording_start'
export const BROWSER_RECORDING_STOP = 'browser_recording_stop'

/** Guidance added to the browser section while the recording tools are present. */
export const BROWSER_RECORDING_GUIDANCE = [
  '- Recording (`browser_recording_start`, `browser_recording_stop`): record only when the user asks for a video or a recording. Open the page first, start before the steps, stop when done, and mention the file path (recordings/<name>.webm) in your answer. A recording stops by itself at the end of your turn, after 15 minutes or at 200 MB.',
].join('\n')

function tool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args: unknown) {
      try {
        return JSON.stringify(await run((args ?? {}) as Record<string, unknown>))
      } catch (error) {
        if (error instanceof BrowserRecordingError) return JSON.stringify({ error: error.code, message: error.message })
        throw error
      }
    },
  } as ToolDefinition
}

/** The earlier recording that stopped by itself, to report with this result. */
function withEarlier(recorder: BrowserRecorder, sessionId: string, value: Record<string, unknown>): Record<string, unknown> {
  const earlier: RecordingResult | undefined = recorder.takeAutoStopped(sessionId)
  return earlier === undefined ? value : { ...value, earlier_recording: earlier }
}

/**
 * Registers the two recording tools on an agent scope.
 * @param target - the session's recording target (its relay starter and workspace).
 */
export function mountBrowserRecordingTools(agentCtx: Context, recorder: BrowserRecorder, target: RecordingTarget): void {
  const sessionId = target.sessionId
  const tools = [
    tool(
      BROWSER_RECORDING_START,
      'Start recording a video of what your web browser shows (the page you last opened). Use only when the user asks for a video or recording. Open the page first. The video is saved in the workspace under recordings/ when you call browser_recording_stop (or at the end of your turn).',
      {
        type: 'object',
        properties: { name: { type: 'string', maxLength: 80, description: 'File name without extension, such as "signup-form". Default: recording-<date-time>.' } },
        additionalProperties: false,
      },
      async (args) => {
        const name = typeof args['name'] === 'string' ? args['name'] : undefined
        const started = await recorder.start(target, name)
        return withEarlier(recorder, sessionId, { recording: true, ...started, ...recorder.limits })
      },
    ),
    tool(
      BROWSER_RECORDING_STOP,
      'Stop the browser recording and save the video. Answers with its workspace path, length and size; mention the path to the user.',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        if (!recorder.recording(sessionId)) {
          const earlier = recorder.takeAutoStopped(sessionId)
          if (earlier !== undefined) return { ...earlier, note: `The recording had already stopped (${earlier.reason}).` }
        }
        const result = await recorder.stop(sessionId)
        return withEarlier(recorder, sessionId, { ...result })
      },
    ),
  ]
  for (const definition of tools) agentCtx.tools.register(definition)
}
