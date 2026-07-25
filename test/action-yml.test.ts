import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const actionYmlPath = fileURLToPath(new URL('../action.yml', import.meta.url))
const raw = readFileSync(actionYmlPath, 'utf8')
const action = parse(raw) as {
  name?: string
  description?: string
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>
  outputs?: Record<string, { description?: string }>
  runs?: { using?: string; main?: string }
}

/**
 * The runner evaluates ${{ }} expressions anywhere in action.yml — including
 * inside description strings — and only a narrow set of contexts is available
 * at that point. A `secrets.*` example in a description makes the action fail
 * to load with "Unrecognized named-value: 'secrets'" before any code runs, and
 * that failure is only visible on real infrastructure. These tests catch it in
 * CI instead.
 */
/**
 * Collect every string value in the parsed document. The runner evaluates
 * expressions in values only, so YAML comments are irrelevant — scanning the
 * raw file text would flag the explanatory comment in action.yml itself.
 */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out)
  else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectStrings(value, out)
  }
  return out
}

describe('action.yml expressions', () => {
  const values = collectStrings(action)
  const expressions = values.flatMap(value =>
    [...value.matchAll(/\$\{\{(.+?)\}\}/g)].map(match => match[1]!.trim())
  )

  it('contains no secrets.* expression', () => {
    for (const expression of expressions) {
      expect(expression).not.toMatch(/\bsecrets\./)
    }
  })

  it('uses only contexts that are valid in action metadata', () => {
    // `github`, `inputs`, `env` and `runner` are the contexts available while
    // action metadata is parsed. Anything else is a load-time failure.
    for (const expression of expressions) {
      expect(expression).toMatch(/^(github|inputs|env|runner)\./)
    }
  })

  it('only allows expressions in input defaults, never in descriptions', () => {
    for (const [name, input] of Object.entries(action.inputs ?? {})) {
      expect(input.description, `input "${name}" description`).not.toMatch(/\$\{\{/)
    }
    for (const [name, output] of Object.entries(action.outputs ?? {})) {
      expect(output.description, `output "${name}" description`).not.toMatch(/\$\{\{/)
    }
    expect(action.description).not.toMatch(/\$\{\{/)
  })
})

describe('action.yml contract', () => {
  it('declares the three documented inputs', () => {
    expect(Object.keys(action.inputs ?? {}).sort()).toEqual([
      'anthropic_api_key',
      'config_path',
      'github_token'
    ])
  })

  it('requires only the API key', () => {
    expect(action.inputs?.['anthropic_api_key']?.required).toBe(true)
    expect(action.inputs?.['config_path']?.required).toBe(false)
    expect(action.inputs?.['github_token']?.required).toBe(false)
  })

  it('defaults config_path and github_token', () => {
    expect(action.inputs?.['config_path']?.default).toBe('.claude-review.yml')
    expect(action.inputs?.['github_token']?.default).toBe('${{ github.token }}')
  })

  it('declares the four documented outputs', () => {
    expect(Object.keys(action.outputs ?? {}).sort()).toEqual([
      'cost_usd',
      'findings_count',
      'skipped',
      'verdict'
    ])
  })

  it('every input and output has a description', () => {
    for (const [name, input] of Object.entries(action.inputs ?? {})) {
      expect(input.description, `input "${name}"`).toBeTruthy()
    }
    for (const [name, output] of Object.entries(action.outputs ?? {})) {
      expect(output.description, `output "${name}"`).toBeTruthy()
    }
  })

  it('points at the committed bundle', () => {
    expect(action.runs?.using).toBe('node24')
    expect(action.runs?.main).toBe('dist/index.js')
  })
})
