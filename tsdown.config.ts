import { defineConfig } from 'tsdown'

// Every `@deepseek-ai/*` import and `@aws-sdk/client-s3` is a peer dependency
// supplied by the host DSH install, so the bundle must not inline them. `pg` is
// a runtime dependency installed beside the package. Migration files are read
// at runtime from `lib/migrations`, next to the bundle (see src/store/migrate.ts).
export default defineConfig({
  entry: { index: 'src/index.ts', 'sandbox-runtime': 'src/sandbox/remote/plugin.ts', 'working-directory': 'src/working-directory.ts' },
  format: 'esm',
  platform: 'node',
  outDir: 'lib',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@aws-sdk\//, /^node:/, /^pg$/],
    // The Agentry Sandbox client ships as TypeScript source (a linked package); bundle it and its RPC runtime.
    alwaysBundle: [/^@agentry\/sandbox/, /^@connectrpc\//, /^@bufbuild\//, /^zod/],
  },
  copy: [{ from: 'src/store/migrations/*.sql', to: 'lib/migrations' }],
})
