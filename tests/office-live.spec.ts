/** Live spike: DSH's Office-to-PDF provider converts a real deck on this machine (AGENTRY_LIVE_OFFICE=1). */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import OfficeToPdf, { OfficeSourceKey } from '@deepseek-ai/dsh-office-to-pdf'
import { afterAll, expect, it } from 'vitest'

const live = process.env['AGENTRY_LIVE_OFFICE'] === '1'
const ctx = new Context()
afterAll(async () => { await ctx.fiber.dispose() })

it.skipIf(!live)('converts a pptx to PDF with the profile provider', async () => {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/office/color-blocks.pptx', import.meta.url)))
  await ctx.plugin(OfficeToPdf, {})
  const started = Date.now()
  const result = await ctx.officeToPdf.convert({ extension: 'pptx', priority: 'foreground', source: {
    key: OfficeSourceKey('spike:color-blocks.pptx'), version: `${String(bytes.length)}:0`, bytes: bytes.length,
    read: async () => ({ bytes, version: `${String(bytes.length)}:0` }),
  } })
  console.info(`office spike: ${String(Date.now() - started)} ms, ${String(result.pdf.byteLength)} PDF bytes, missing fonts: ${result.missingFonts.join(', ') || 'none'}`)
  expect(new TextDecoder().decode(result.pdf.subarray(0, 5))).toBe('%PDF-')
}, 180_000)
