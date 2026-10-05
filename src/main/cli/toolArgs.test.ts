import { describe, expect, it } from 'vitest'
import { UsageError, parseToolArgs, toolHelp, type JsonSchema } from './toolArgs'

/** Shapes zod's toJSONSchema gives for unions: anyOf with constraints, a type array without. */
const schema: JsonSchema = {
  type: 'object',
  properties: {
    server: {
      anyOf: [
        { type: 'integer', exclusiveMinimum: 0 } as JsonSchema,
        { type: 'string', minLength: 1 } as JsonSchema
      ]
    },
    size: { type: ['number', 'string'] },
    mode: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }] },
    count: { type: ['integer', 'null'] },
    either: { anyOf: [{ type: 'integer' }, { type: 'boolean' }] },
    filter: { anyOf: [{ type: 'object' }, { type: 'string' }] },
    ids: { type: 'array', items: { type: ['integer', 'string'] } }
  }
}

const parse = (...argv: string[]): Record<string, unknown> => parseToolArgs(argv, schema)

/** The UsageError message parseToolArgs throws for `argv`. */
function usage(argv: string[], against: JsonSchema = schema): string {
  try {
    parseToolArgs(argv, against)
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError)
    return (err as Error).message
  }
  throw new Error(`no usage error for ${argv.join(' ')}`)
}

describe('parseToolArgs with union schemas', () => {
  it('takes the most specific type that parses, else a string', () => {
    // covers: Test-691
    expect(
      parse(
        ...['--server', '7', '--size', '2.5', '--mode', 'false', '--count', '3'],
        ...['--either', 'true', '--filter', '{"min":1}']
      )
    ).toEqual({ server: 7, size: 2.5, mode: false, count: 3, either: true, filter: { min: 1 } })
    expect(
      parse(...['--server', 'Pixel phone', '--size', 'big', '--mode', 'auto', '--either', '2'])
    ).toEqual({ server: 'Pixel phone', size: 'big', mode: 'auto', either: 2 })
    expect(parse('--size', '1e3', '--filter', '{not json')).toEqual({
      size: 1000,
      filter: '{not json'
    })
  })

  it('keeps a value that is not a plain JSON number a string when a string is allowed', () => {
    // covers: Test-691
    for (const value of ['007', ' 1', '1.5', '0x10', 'Infinity', '1 ', ''])
      expect(parse('--server', value)).toEqual({ server: value })
    expect(parse('--server', '-3')).toEqual({ server: -3 })
  })

  it('converts each item of an array of unions', () => {
    // covers: Test-691
    expect(parse('--ids', '3', '--ids', 'abc', '--ids=007', '--ids', '[4,"x"]')).toEqual({
      ids: [3, 'abc', '007', 4, 'x']
    })
  })

  it('shows every accepted type of a union in --help', () => {
    // covers: Test-691
    const help = toolHelp({ name: 'demo', inputSchema: schema })

    expect(help).toMatch(/--server <integer\|string>/)
    expect(help).toMatch(/--size <number\|string>/)
    expect(help).toMatch(/--count <integer>/)
    expect(help).toMatch(/--ids <integer\|string> \(repeatable\)/)
  })
})

describe('parseToolArgs usage errors', () => {
  it('names the accepted forms and the --args - alternative', () => {
    // covers: Test-692
    const single: JsonSchema = {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        ratio: { type: 'number' },
        recursive: { type: 'boolean' },
        filter: { type: 'object' }
      }
    }

    const messages = [
      usage(['--limit', '2.5'], single),
      usage(['--ratio', 'half'], single),
      usage(['--recursive=maybe'], single),
      usage(['--filter', '[1]'], single),
      usage(['--either', 'maybe']),
      usage(['--count', 'x'])
    ]

    expect(messages.map((m) => m.slice(0, m.indexOf(', got')))).toEqual([
      '--limit needs an integer',
      '--ratio needs a number',
      '--recursive needs true/false',
      '--filter needs a JSON object',
      '--either needs an integer or true/false',
      '--count needs an integer'
    ])
    for (const message of messages) expect(message).toContain('--args -')
  })
})
