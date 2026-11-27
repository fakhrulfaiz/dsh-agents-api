/**
 * The user's input to a chat's browser while they have control (take-over in the live view): the wire
 * events of `POST /agents/sessions/{id}/browser/input`, checked and turned into the few CDP commands the
 * relay accepts (`browser-live-relay.ts`). Coordinates are the page's CSS pixels; the client maps them
 * from the frame it shows.
 */

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export type BrowserInputEvent =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; buttons?: number; click_count?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; delta_x: number; delta_y: number; modifiers?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; key_code?: number; text?: string; modifiers?: number }
  | { type: 'text'; text: string }
  | { type: 'resize'; width: number; height: number }

export interface CdpCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent' | 'Input.insertText' | 'Emulation.setDeviceMetricsOverride'
  params: Record<string, unknown>
}

/** Most events in one request. */
export const MAX_INPUT_EVENTS = 50
/** Longest text in one `text` event. */
export const MAX_INPUT_TEXT = 2000
/** Smallest and largest page size a `resize` asks for (CSS pixels). */
export const RESIZE_LIMITS = { minWidth: 320, maxWidth: 1920, minHeight: 240, maxHeight: 1440 } as const

const BUTTONS = new Set(['left', 'middle', 'right'])

function num(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(max, Math.max(min, v))
}

function int(v: unknown, min: number, max: number): number | undefined {
  const n = num(v, min, max)
  return n === undefined ? undefined : Math.round(n)
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
}

/** Checks one wire event; `undefined` when it is malformed. Numbers are clamped to sane ranges. */
export function parseInputEvent(raw: unknown): BrowserInputEvent | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const e = raw as Record<string, unknown>
  const modifiers = int(e['modifiers'], 0, 15)
  const mods = modifiers ? { modifiers } : {}
  switch (e['type']) {
    case 'mouse': {
      const action = e['action']
      const x = num(e['x'], 0, 10_000)
      const y = num(e['y'], 0, 10_000)
      if ((action !== 'move' && action !== 'down' && action !== 'up') || x === undefined || y === undefined) return undefined
      if (e['button'] !== undefined && !BUTTONS.has(e['button'] as string)) return undefined
      const buttons = int(e['buttons'], 0, 31)
      const clicks = int(e['click_count'], 1, 3)
      return {
        type: 'mouse', action, x, y,
        ...(e['button'] !== undefined ? { button: e['button'] as 'left' | 'middle' | 'right' } : {}),
        ...(buttons !== undefined ? { buttons } : {}),
        ...(clicks !== undefined ? { click_count: clicks } : {}),
        ...mods,
      }
    }
    case 'wheel': {
      const x = num(e['x'], 0, 10_000)
      const y = num(e['y'], 0, 10_000)
      const dx = num(e['delta_x'] ?? 0, -10_000, 10_000)
      const dy = num(e['delta_y'] ?? 0, -10_000, 10_000)
      if (x === undefined || y === undefined || dx === undefined || dy === undefined) return undefined
      return { type: 'wheel', x, y, delta_x: dx, delta_y: dy, ...mods }
    }
    case 'key': {
      const action = e['action']
      const key = str(e['key'], 32)
      if ((action !== 'down' && action !== 'up') || key === undefined) return undefined
      const code = str(e['code'], 32)
      const keyCode = int(e['key_code'], 0, 255)
      const text = str(e['text'], 4)
      return {
        type: 'key', action, key,
        ...(code !== undefined ? { code } : {}),
        ...(keyCode !== undefined ? { key_code: keyCode } : {}),
        ...(text !== undefined && action === 'down' ? { text } : {}),
        ...mods,
      }
    }
    case 'text': {
      const text = str(e['text'], MAX_INPUT_TEXT)
      return text === undefined ? undefined : { type: 'text', text }
    }
    case 'resize': {
      const width = int(e['width'], RESIZE_LIMITS.minWidth, RESIZE_LIMITS.maxWidth)
      const height = int(e['height'], RESIZE_LIMITS.minHeight, RESIZE_LIMITS.maxHeight)
      if (width === undefined || height === undefined) return undefined
      return { type: 'resize', width, height }
    }
    default:
      return undefined
  }
}

/**
 * Checks a request's `events`.
 * @returns the events, or an error message for a 400.
 */
export function parseInputEvents(raw: unknown): BrowserInputEvent[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'events must be a non-empty array'
  if (raw.length > MAX_INPUT_EVENTS) return `at most ${String(MAX_INPUT_EVENTS)} events per request`
  const out: BrowserInputEvent[] = []
  for (const [i, item] of raw.entries()) {
    const event = parseInputEvent(item)
    if (event === undefined) return `events[${String(i)}] is not a valid input event`
    out.push(event)
  }
  return out
}

const MOUSE_TYPE = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' } as const

/** The CDP command for one checked event. */
export function toCdpCommand(event: BrowserInputEvent): CdpCommand {
  const modifiers = 'modifiers' in event && event.modifiers !== undefined ? event.modifiers : 0
  switch (event.type) {
    case 'mouse': {
      const button = event.button ?? (event.action === 'move' ? 'none' : 'left')
      const pressed = event.action === 'down' ? ({ left: 1, right: 2, middle: 4, none: 0 } as const)[button] : 0
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: MOUSE_TYPE[event.action], x: event.x, y: event.y, button,
          buttons: event.buttons ?? pressed,
          clickCount: event.action === 'move' ? 0 : event.click_count ?? 1,
          modifiers,
        },
      }
    }
    case 'wheel':
      return { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.delta_x, deltaY: event.delta_y, modifiers } }
    case 'key': {
      const keyCode = event.key_code ?? 0
      const base = { key: event.key, code: event.code ?? '', windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
      if (event.action === 'up') return { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } }
      // A key that types (a letter, Enter's "\r") is a keyDown with text; others (arrows, Backspace) a rawKeyDown.
      return {
        method: 'Input.dispatchKeyEvent',
        params: event.text !== undefined ? { type: 'keyDown', ...base, text: event.text, unmodifiedText: event.text } : { type: 'rawKeyDown', ...base },
      }
    }
    case 'text':
      return { method: 'Input.insertText', params: { text: event.text } }
    case 'resize':
      return { method: 'Emulation.setDeviceMetricsOverride', params: { width: event.width, height: event.height, deviceScaleFactor: 1, mobile: false } }
  }
}
