/**
 * Templates every owner has without creating them: ready setups mostly on the isolated sandbox's standard
 * image (Debian, Python 3.11, Node 24, pnpm, git, pandas and the Office libraries), so each lists only what
 * that image lacks. "Web and browser" is the exception: it names the separate browser image. They are served by
 * the API, not stored per owner: they cannot be edited or deleted, a change here reaches everyone, and they
 * work wherever a template id does (environments, `sandbox_create`).
 */
import type { EnvironmentTemplate } from '../environment-types.ts'
import { BROWSER_SANDBOX_IMAGE } from './browser-image.ts'

const at = 1_795_000_000

const builtin = (key: string, name: string, config: EnvironmentTemplate['config']): EnvironmentTemplate => ({
  id: `tpl_builtin_${key}`,
  object: 'environment.template',
  name,
  provider: 'sandbox',
  config,
  created_at: at,
})

export const BUILTIN_TEMPLATES: readonly EnvironmentTemplate[] = [
  builtin('data_science', 'Data science', { packages: { python: ['matplotlib', 'seaborn', 'scipy', 'scikit-learn'], system: [], npm: [] } }),
  builtin('web_scraping', 'Web and scraping', { packages: { python: ['requests', 'beautifulsoup4', 'httpx'], system: [], npm: [] } }),
  builtin('web_browser', 'Web and browser', { image: BROWSER_SANDBOX_IMAGE }),
  builtin('node_typescript', 'Node and TypeScript', { packages: { python: [], system: [], npm: ['typescript', 'tsx'] } }),
  builtin('offline', 'Offline', { network: { access: 'disabled' } }),
]

export const isBuiltinTemplateId = (id: string): boolean => id.startsWith('tpl_builtin_')

/** The built-in template `id`, or undefined. */
export const builtinTemplate = (id: string): EnvironmentTemplate | undefined => BUILTIN_TEMPLATES.find((t) => t.id === id)
