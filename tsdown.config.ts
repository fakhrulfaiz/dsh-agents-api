import { defineConfig } from 'tsdown'

/** Self-contained git-install build: no monorepo project references. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  dts: true,
  clean: true,
  // Peer packages are provided by the dsh profile at runtime.
  external: [
    /^node:/,
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
  ],
})
