import { defineConfig } from 'tsdown'

// Every `@deepseek-ai/*` import and `@aws-sdk/client-s3` is a peer dependency
// supplied by the host DSH install, so the bundle must not inline them.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  outDir: 'lib',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, /^@aws-sdk\//, /^node:/] },
})
