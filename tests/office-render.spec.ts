/** Office preview helpers: extension detection, error mapping, missing-font header. */
import { describe, expect, it } from 'vitest'
import { MAX_OFFICE_INPUT_BYTES, missingFontsHeader, officeExtension, renderError } from '../src/render/office.ts'

describe('officeExtension', () => {
  it('reads the last extension, case-insensitively', () => {
    expect(officeExtension('a/B.PPTX')).toBe('pptx')
    expect(officeExtension('x.tar.docx')).toBe('docx')
    for (const ext of ['doc', 'xls', 'xlsx', 'ppt']) expect(officeExtension(`f.${ext}`)).toBe(ext)
  })
  it('is undefined for other files', () => {
    expect(officeExtension('a.pdf')).toBeUndefined()
    expect(officeExtension('noext')).toBeUndefined()
    expect(officeExtension('dir.docx/file')).toBeUndefined()
  })
})

describe('renderError', () => {
  it.each([
    ['input-too-large', 413, 'file_too_large'],
    ['output-too-large', 413, 'file_too_large'],
    ['invalid-document', 422, 'invalid_document'],
    ['unsupported-format', 422, 'invalid_document'],
    ['timeout', 504, 'render_timeout'],
    ['busy', 503, 'render_busy'],
    ['unavailable', 503, 'render_unavailable'],
    ['source-changed', 409, 'source_changed'],
    ['failed', 500, 'render_failed'],
    ['something-else', 500, 'render_failed'],
  ])('%s -> %i %s', (code, status, wire) => {
    const mapped = renderError(code)
    expect(mapped).toMatchObject({ status, code: wire })
    expect(mapped.message).not.toMatch(/LibreOffice|engine/i)
  })
})

describe('missingFontsHeader', () => {
  it('joins encoded names', () => {
    expect(missingFontsHeader(['Calibri', 'Noto Sans CJK'])).toBe('Calibri,Noto%20Sans%20CJK')
  })
  it('is undefined for none', () => {
    expect(missingFontsHeader([])).toBeUndefined()
  })
})

it('caps input at 50 MB', () => {
  expect(MAX_OFFICE_INPUT_BYTES).toBe(50 * 1024 * 1024)
})
