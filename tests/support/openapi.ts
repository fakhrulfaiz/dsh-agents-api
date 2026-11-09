/**
 * Loads `openapi/agentry.yaml` and validates JSON bodies against the schemas it
 * declares for an operation.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import { parse } from 'yaml'

type Json = Record<string, unknown>

/** Absolute path of the published contract. */
export const SPEC_PATH = fileURLToPath(new URL('../../openapi/agentry.yaml', import.meta.url))

/**
 * @returns the parsed OpenAPI document.
 */
export function loadSpec(): Json {
  return parse(readFileSync(SPEC_PATH, 'utf8')) as Json
}

/**
 * Resolve a local `$ref` such as `#/components/responses/NotFound`.
 * @param spec - OpenAPI document.
 * @param node - object that may be a `$ref`.
 * @returns the referenced object, or `node` when it is not a reference.
 */
function deref(spec: Json, node: Json): Json {
  const ref = node['$ref']
  if (typeof ref !== 'string') return node
  let current: unknown = spec
  for (const part of ref.replace(/^#\//, '').split('/')) current = (current as Json)[part]
  return current as Json
}

/** Operation-level schema validator over one spec document. */
export class SpecValidator {
  readonly spec: Json
  readonly #ajv = new Ajv2020({ strict: false, allErrors: true })
  readonly #compiled = new Map<string, ValidateFunction>()

  /**
   * @param spec - parsed OpenAPI document.
   */
  constructor(spec: Json = loadSpec()) {
    this.spec = spec
  }

  /**
   * Compile `schema` with the spec's `components` in scope.
   * @param key - cache key.
   * @param schema - schema node that may use `#/components/...` references.
   */
  #compile(key: string, schema: Json): ValidateFunction {
    let validate = this.#compiled.get(key)
    if (validate === undefined) {
      validate = this.#ajv.compile({ ...schema, components: this.spec['components'] })
      this.#compiled.set(key, validate)
    }
    return validate
  }

  /**
   * Validate a named component schema.
   * @param name - key under `components.schemas`.
   * @param body - value to check.
   * @returns validation errors, empty when valid.
   */
  schema(name: string, body: unknown): string[] {
    const validate = this.#compile(`schema:${name}`, { $ref: `#/components/schemas/${name}` })
    return validate(body) ? [] : this.#format(validate)
  }

  /**
   * Validate a JSON response body.
   * @param method - HTTP method.
   * @param path - spec path template, for example `/v1/agents/{agent_id}`.
   * @param status - response status.
   * @param body - parsed JSON body.
   * @returns validation errors, empty when valid. A status the operation does not declare is an error.
   */
  response(method: string, path: string, status: number, body: unknown): string[] {
    const operation = ((this.spec['paths'] as Json)[path] as Json | undefined)?.[method.toLowerCase()] as Json | undefined
    if (operation === undefined) return [`no operation ${method} ${path}`]
    const declared = (operation['responses'] as Json)[String(status)] as Json | undefined
    if (declared === undefined) return [`${method} ${path} does not declare ${String(status)}`]
    const schema = (deref(this.spec, declared)['content'] as Json | undefined)?.['application/json'] as Json | undefined
    if (schema === undefined) return [`${method} ${path} ${String(status)} has no application/json body`]
    const validate = this.#compile(`${method} ${path} ${String(status)}`, schema['schema'] as Json)
    return validate(body) ? [] : this.#format(validate)
  }

  /**
   * Validate a JSON request body.
   * @param method - HTTP method.
   * @param path - spec path template.
   * @param body - request body.
   * @returns validation errors, empty when valid.
   */
  request(method: string, path: string, body: unknown): string[] {
    const operation = ((this.spec['paths'] as Json)[path] as Json | undefined)?.[method.toLowerCase()] as Json | undefined
    const content = ((operation?.['requestBody'] as Json | undefined)?.['content'] as Json | undefined)?.['application/json'] as Json | undefined
    if (content === undefined) return [`no request body declared for ${method} ${path}`]
    const validate = this.#compile(`req ${method} ${path}`, content['schema'] as Json)
    return validate(body) ? [] : this.#format(validate)
  }

  #format(validate: ValidateFunction): string[] {
    return (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? ''} ${JSON.stringify(error.params)}`)
  }
}
