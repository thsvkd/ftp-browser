/**
 * `ftpb <tool> --param value` → tool arguments, typed by the tool's JSON Schema (from tools/list).
 * Numbers, booleans, arrays (repeat the flag or pass a JSON array) and objects (JSON) are converted;
 * `--args '<json>'` gives a base object that flags override.
 */

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  anyOf?: JsonSchema[]
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

function typeOf(schema: JsonSchema | undefined): string | undefined {
  if (!schema) return undefined
  const { type } = schema
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.find((t) => t !== 'null')
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      const found = typeOf(option)
      if (found && found !== 'null') return found
    }
  }
  if (schema.enum?.length) return typeof schema.enum[0]
  return undefined
}

function parseJson(flag: string, value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new UsageError(`--${flag} needs JSON, got ${JSON.stringify(value)}.`)
  }
}

function convertScalar(flag: string, value: string, schema: JsonSchema | undefined): unknown {
  const type = typeOf(schema)
  if (type === 'number' || type === 'integer') {
    const number = value.trim() === '' ? NaN : Number(value)
    if (Number.isNaN(number) || (type === 'integer' && !Number.isInteger(number))) {
      throw new UsageError(
        `--${flag} needs ${type === 'integer' ? 'an integer' : 'a number'}, got ${JSON.stringify(value)}.`
      )
    }
    return number
  }
  if (type === 'boolean') {
    if (value === 'true' || value === 'false') return value === 'true'
    throw new UsageError(`--${flag} is true or false, got ${JSON.stringify(value)}.`)
  }
  if (type === 'object' || type === 'array') return parseJson(flag, value)
  if (type === undefined) {
    // No schema (unlisted tool): use the value as JSON when it parses, else as a string.
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
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
      const value = parseJson(flag, next())
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
    const type = typeOf(property)
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
  return name && typeOf(properties[name]) === 'boolean' ? name : undefined
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
  const type = typeOf(schema)
  if (schema?.enum?.length) return `<${schema.enum.map(String).join('|')}>`
  if (type === 'array') {
    const itemType = typeOf(schema?.items)
    return itemType === 'object' || itemType === 'array' || !itemType
      ? '<json>'
      : `${placeholder(schema?.items)} (repeatable)`
  }
  if (type === 'object') return '<json>'
  return `<${type ?? 'value'}>`
}

/** `ftpb <tool> --help`: what it does, its tier and policy, and one line per flag. */
export function toolHelp(tool: ToolInfo): string {
  const properties = tool.inputSchema?.properties ?? {}
  const required = new Set(tool.inputSchema?.required ?? [])
  const rows = Object.entries(properties).map(([name, schema]) => {
    const usage =
      typeOf(schema) === 'boolean' ? `--${kebab(name)}` : `--${kebab(name)} ${placeholder(schema)}`
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
