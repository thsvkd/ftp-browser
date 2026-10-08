/**
 * `ftpb <tool> --param value` → tool arguments, typed by the tool's JSON Schema (from tools/list).
 * Numbers, booleans, arrays (repeat the flag or pass a JSON array) and objects (JSON) are converted;
 * a union (`anyOf`, `oneOf`, a type array) takes the most specific type the value reads as, else a
 * string. `--args '<json>'` gives a base object that flags override.
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
  description?: string
  inputSchema?: JsonSchema
}

/** A mistake in how ftpb was called: exit 2. */
export class UsageError extends Error {}

/** `list-directory`, `list_directory` and `listDirectory` name the same tool or parameter. */
export const squash = (name: string): string => name.replace(/[-_]/g, '').toLowerCase()

/** `timeoutSec` → `timeout-sec` */
function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

/** Every type `schema` accepts, from `type`, `anyOf`, `oneOf` or `enum`, without null. */
function typesOf(schema: JsonSchema | undefined): string[] {
  if (!schema) return []
  const types = new Set<string>([schema.type ?? []].flat())
  for (const option of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])])
    for (const type of typesOf(option)) types.add(type)
  if (types.size === 0) for (const value of schema.enum ?? []) types.add(typeof value)
  types.delete('null')
  return [...types]
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v)

/** How a usage error names each non-string type. */
const FORMS: Record<string, string> = {
  integer: 'an integer',
  number: 'a number',
  boolean: 'true/false',
  array: 'a JSON array',
  object: 'a JSON object'
}

/**
 * A flag value as the schema's types allow: the JSON value when it parses as one of them (`7`,
 * `true`, `{"a":1}`), else the text when a string is allowed, so "007", " 1" or "Pixel phone"
 * stay names. Otherwise a usage error that names the accepted forms.
 */
function convert(flag: string, value: string, schema: JsonSchema | undefined): unknown {
  const types = typesOf(schema)
  const parsed = value === value.trim() ? parseJson(value) : undefined
  const parsedTypes = Array.isArray(parsed)
    ? ['array']
    : Number.isInteger(parsed)
      ? ['integer', 'number']
      : isObject(parsed)
        ? ['object']
        : [typeof parsed]
  if (parsedTypes.some((t) => t !== 'string' && types.includes(t))) return parsed
  if (types.length === 0 || types.some((t) => !(t in FORMS))) return value
  throw new UsageError(
    `--${flag} needs ${types.map((t) => FORMS[t]).join(' or ')}, got ${JSON.stringify(value)}. ` +
      "To pass a value exactly, give all parameters as one JSON object: --args '<json>', or " +
      '--args - to read it from stdin.'
  )
}

/** Parse the flags after `ftpb <tool>` against the tool's input schema. */
export function parseToolArgs(argv: string[], schema: JsonSchema = {}): Record<string, unknown> {
  const properties = schema.properties ?? {}
  const find = (flag: string): string | undefined =>
    Object.keys(properties).find((n) => n === flag || squash(n) === squash(flag))
  const isBoolean = (name: string | undefined): boolean =>
    name !== undefined && typesOf(properties[name]).join() === 'boolean'
  let base: Record<string, unknown> = {}
  const flags: Record<string, unknown> = {}

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
      if (!isObject(value)) throw new UsageError('--args needs a JSON object.')
      base = { ...base, ...(value as Record<string, unknown>) }
      continue
    }
    if (flag.startsWith('no-') && inline === undefined && isBoolean(find(flag.slice(3)))) {
      flags[find(flag.slice(3))!] = false
      continue
    }
    const name = find(flag)
    if (!name) {
      const known = Object.keys(properties).map((n) => `--${kebab(n)}`)
      throw new UsageError(
        `Unknown parameter --${flag}. Parameters: ${known.join(', ') || 'none'}.`
      )
    }
    const property = properties[name]
    if (isBoolean(name)) {
      // --overwrite, --overwrite true, --overwrite=false
      if (inline !== undefined) flags[name] = convert(flag, inline, property)
      else if (argv[i + 1] === 'true' || argv[i + 1] === 'false') flags[name] = argv[++i] === 'true'
      else flags[name] = true
      continue
    }
    const value = next()
    if (typesOf(property).join() === 'array') {
      // A JSON array is the whole list; anything else (even "[2024] trip.jpg") is one item.
      const list = value.trimStart().startsWith('[') ? parseJson(value) : undefined
      const items = Array.isArray(list) ? list : [convert(flag, value, property.items)]
      flags[name] = [...((flags[name] as unknown[] | undefined) ?? []), ...items]
    } else {
      flags[name] = convert(flag, value, property)
    }
  }
  return { ...base, ...flags }
}

function placeholder(schema: JsonSchema): string {
  const types = typesOf(schema)
  if (schema.enum?.length) return `<${schema.enum.map(String).join('|')}>`
  if (types.join() === 'array') {
    const items = typesOf(schema.items)
    return items.length === 0 || items.includes('object') || items.includes('array')
      ? '<json>'
      : `${placeholder(schema.items!)} (repeatable)`
  }
  if (types.join() === 'object') return '<json>'
  // a union shows every type it accepts: <integer|string>
  return `<${types.join('|') || 'value'}>`
}

/** `ftpb <tool> --help`: what the tool does (its first line is the risk) and one line per flag. */
export function toolHelp(tool: ToolInfo): string {
  const properties = tool.inputSchema?.properties ?? {}
  const required = new Set(tool.inputSchema?.required ?? [])
  const rows = Object.entries(properties).map(([name, schema]) => {
    const isFlag = typesOf(schema).join() === 'boolean'
    const usage = `--${kebab(name)}${isFlag ? '' : ` ${placeholder(schema)}`}`
    const notes = [required.has(name) ? 'required' : '', schema.description ?? '']
    return [usage, notes.filter(Boolean).join('  ')] as const
  })
  rows.push(["--args '<json>'", 'all parameters as one JSON object (flags override it)'])
  rows.push([
    '--args -',
    'the same object read from stdin: use it for untrusted strings (remote names)'
  ])
  const width = Math.max(...rows.map(([usage]) => usage.length))
  return [
    `ftpb ${kebab(tool.name)}`,
    '',
    ...(tool.description ? [tool.description, ''] : []),
    'Parameters:',
    ...rows.map(([usage, notes]) => `  ${usage.padEnd(width)}  ${notes}`.trimEnd()),
    '',
    'Output is JSON. Exit codes: 0 ok, 1 tool error, 2 usage, 4 FTP Browser unavailable.',
    ''
  ].join('\n')
}
