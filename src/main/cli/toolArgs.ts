/**
 * `ftpb <tool> --param value` → tool arguments, typed by the tool's JSON Schema (from tools/list).
 * Numbers, booleans, arrays (repeat the flag or pass a JSON array) and objects (JSON) are converted;
 * a union (`anyOf`, `oneOf`, a type array) takes the most specific type the value reads as, else a
 * string (§10 U1). `--args '<json>'` gives a base object that flags override.
 */

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  description?: string
}

export interface ToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema?: JsonSchema
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/** A mistake in how ftpb was called: exit 2. */
export class UsageError extends Error {}

const squash = (name: string): string => name.replace(/[-_]/g, '').toLowerCase()

/** `timeoutSec` / `dry_run` → `timeout-sec` / `dry-run` */
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

/** `list-directory`, `list_directory`, `listDirectory` → the tool's real name. */
export function resolveName(input: string, names: string[]): string | undefined {
  return names.find((name) => name === input) ?? names.find((n) => squash(n) === squash(input))
}

/** Every type `schema` accepts, from `type`, `anyOf`, `oneOf` or `enum`, without null. */
function typesOf(schema: JsonSchema | undefined): string[] {
  if (!schema) return []
  const types = new Set<string>()
  if (typeof schema.type === 'string') types.add(schema.type)
  for (const type of Array.isArray(schema.type) ? schema.type : []) types.add(type)
  for (const option of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])])
    for (const type of typesOf(option)) types.add(type)
  if (types.size === 0) for (const value of schema.enum ?? []) types.add(typeof value)
  types.delete('null')
  return [...types]
}

/** The one type `schema` accepts, or undefined for a union or no type at all. */
function soleType(schema: JsonSchema | undefined): string | undefined {
  const types = typesOf(schema)
  return types.length === 1 ? types[0] : undefined
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

/**
 * Readers for the non-string types, most specific first: a union takes the first that reads the
 * value. With a string alternative only plain JSON numbers are numbers, so a server named "007"
 * stays a name.
 */
const READERS: Array<[type: string, read: (value: string, strict: boolean) => unknown]> = [
  ['integer', (value, strict) => readNumber(value, strict, true)],
  ['number', (value, strict) => readNumber(value, strict, false)],
  ['boolean', (value) => (value === 'true' ? true : value === 'false' ? false : undefined)],
  ['array', (value) => jsonOf(value, Array.isArray)],
  ['object', (value) => jsonOf(value, isObject)]
]

const FORMS: Record<string, string> = {
  integer: 'an integer',
  number: 'a number',
  boolean: 'true/false',
  array: 'a JSON array',
  object: 'a JSON object'
}

function readNumber(value: string, strict: boolean, integer: boolean): number | undefined {
  if (strict ? !JSON_NUMBER.test(value) : value.trim() === '') return undefined
  const number = Number(value)
  return Number.isNaN(number) || (integer && !Number.isInteger(number)) ? undefined : number
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonOf(value: string, is: (parsed: unknown) => boolean): unknown {
  const parsed = parseJson(value)
  return is(parsed) ? parsed : undefined
}

function convertScalar(flag: string, value: string, schema: JsonSchema | undefined): unknown {
  const types = typesOf(schema)
  if (types.length === 0) {
    // No schema (unlisted tool): use the value as JSON when it parses, else as a string.
    const parsed = parseJson(value)
    return parsed === undefined ? value : parsed
  }
  // string, or a type ftpb has no reader for: the value as it is
  const asString = types.some((type) => !READERS.some(([known]) => known === type))
  for (const [type, read] of READERS) {
    if (!types.includes(type)) continue
    const converted = read(value, asString)
    if (converted !== undefined) return converted
  }
  if (asString) return value
  const forms = READERS.filter(([type]) => types.includes(type)).map(([type]) => FORMS[type])
  throw new UsageError(
    `--${flag} needs ${forms.join(' or ')}, got ${JSON.stringify(value)}. To pass a value ` +
      "exactly, give all parameters as one JSON object: --args '<json>', or --args - to read it " +
      'from stdin.'
  )
}

/** Parse the flags after `ftpb <tool>` against `schema` (undefined: the tool is not listed). */
export function parseToolArgs(argv: string[], schema?: JsonSchema): Record<string, unknown> {
  const properties = schema?.properties ?? {}
  const names = Object.keys(properties)
  let base: Record<string, unknown> = {}
  const flags: Record<string, unknown> = {}

  const resolve = (flag: string): string => {
    if (!schema) return names.find((n) => squash(n) === squash(flag)) ?? camel(flag)
    const name = names.find((n) => n === flag) ?? names.find((n) => squash(n) === squash(flag))
    if (name) return name
    const known = names.map((n) => `--${kebab(n)}`).join(', ') || 'none'
    throw new UsageError(`Unknown parameter --${flag}. Parameters: ${known}.`)
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--') || token === '--') {
      throw new UsageError(
        `Unexpected argument ${JSON.stringify(token)}. Pass parameters as --name value (see --help).`
      )
    }
    const eq = token.indexOf('=')
    const flag = eq < 0 ? token.slice(2) : token.slice(2, eq)
    const inline = eq < 0 ? undefined : token.slice(eq + 1)
    const next = (): string => {
      if (inline !== undefined) return inline
      const value = argv[i + 1]
      if (value === undefined || (value.startsWith('--') && value.length > 2)) {
        throw new UsageError(`--${flag} needs a value.`)
      }
      i++
      return value
    }

    if (flag === 'args') {
      const value = parseJson(next())
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new UsageError('--args needs a JSON object.')
      }
      base = { ...base, ...(value as Record<string, unknown>) }
      continue
    }

    if (flag.startsWith('no-') && inline === undefined) {
      const name = schema ? resolveIfBoolean(flag.slice(3), properties) : camel(flag.slice(3))
      if (name) {
        flags[name] = false
        continue
      }
    }

    const name = resolve(flag)
    const property = properties[name]
    const type = soleType(property)
    if (type === 'boolean' || (!schema && inline === undefined && isFlagEnd(argv[i + 1]))) {
      if (inline !== undefined) flags[name] = convertScalar(flag, inline, { type: 'boolean' })
      else if (argv[i + 1] === 'true' || argv[i + 1] === 'false') flags[name] = argv[++i] === 'true'
      else flags[name] = true
      continue
    }
    const value = next()
    if (type === 'array') {
      // A JSON array is the whole list; anything else (even "[2024] trip.jpg") is one item.
      const list = jsonArray(value)
      const items = list ?? [convertScalar(flag, value, property?.items)]
      const previous = Array.isArray(flags[name]) ? (flags[name] as unknown[]) : []
      flags[name] = [...previous, ...items]
    } else {
      flags[name] = convertScalar(flag, value, property)
    }
  }
  return { ...base, ...flags }
}

function jsonArray(value: string): unknown[] | undefined {
  if (!value.trimStart().startsWith('[')) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isFlagEnd(value: string | undefined): boolean {
  return value === undefined || value.startsWith('--')
}

function resolveIfBoolean(
  flag: string,
  properties: Record<string, JsonSchema>
): string | undefined {
  const name = Object.keys(properties).find((n) => squash(n) === squash(flag))
  return name && soleType(properties[name]) === 'boolean' ? name : undefined
}

function camel(flag: string): string {
  return flag.replace(/[-_]([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

export function tierOf(tool: ToolInfo): string {
  const tier = tool._meta?.['ftp-browser/risk']
  if (typeof tier === 'string') return tier
  return tool.annotations?.readOnlyHint === true ? 'R' : '?'
}

export function policyOf(tool: ToolInfo): string {
  const policy = tool._meta?.['ftp-browser/policy']
  if (typeof policy === 'string') return policy
  return tierOf(tool) === 'R' ? 'allow' : '?'
}

function placeholder(schema: JsonSchema | undefined): string {
  const type = soleType(schema)
  if (schema?.enum?.length) return `<${schema.enum.map(String).join('|')}>`
  if (type === 'array') {
    const itemTypes = typesOf(schema?.items)
    return itemTypes.length === 0 || itemTypes.includes('object') || itemTypes.includes('array')
      ? '<json>'
      : `${placeholder(schema?.items)} (repeatable)`
  }
  if (type === 'object') return '<json>'
  // a union shows every type it accepts: <integer|string>
  return `<${typesOf(schema).join('|') || 'value'}>`
}

/** `ftpb <tool> --help`: what it does, its tier and policy, and one line per flag. */
export function toolHelp(tool: ToolInfo): string {
  const properties = tool.inputSchema?.properties ?? {}
  const required = new Set(tool.inputSchema?.required ?? [])
  const rows = Object.entries(properties).map(([name, schema]) => {
    const usage =
      soleType(schema) === 'boolean'
        ? `--${kebab(name)}`
        : `--${kebab(name)} ${placeholder(schema)}`
    const notes = [required.has(name) ? 'required' : '', schema.description ?? '']
      .filter(Boolean)
      .join('  ')
    return [usage, notes] as const
  })
  rows.push(["--args '<json>'", 'all parameters as one JSON object (flags override it)'])
  rows.push([
    '--args -',
    'the same object read from stdin: use it for untrusted strings (remote names)'
  ])
  const width = Math.max(...rows.map(([usage]) => usage.length))
  const lines = [
    `${tool.name}  [tier ${tierOf(tool)}, policy ${policyOf(tool)}]${tool.title ? `  ${tool.title}` : ''}`,
    `Usage: ftpb ${kebab(tool.name)} [--param value ...]   (or: ftpb call ${tool.name} --args '<json>')`,
    '',
    ...(tool.description ? [tool.description, ''] : []),
    'Parameters:',
    ...rows.map(([usage, notes]) => `  ${usage.padEnd(width)}  ${notes}`.trimEnd()),
    '',
    'Exit codes: 0 ok, 1 tool error, 2 usage, 3 refused by FTP Browser (do not retry), 4 app unavailable.'
  ]
  return `${lines.join('\n')}\n`
}
