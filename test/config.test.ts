import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  DEFAULT_MODEL,
  DEFAULT_RULES,
  loadConfig,
  parseConfig,
  severityRank
} from '../src/config.js'

const workspaces: string[] = []

/** A throwaway checkout directory; loadConfig resolves relative to one. */
function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-review-config-'))
  workspaces.push(dir)
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }
  return dir
}

afterEach(() => {
  while (workspaces.length > 0) {
    const dir = workspaces.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('severityRank', () => {
  it('orders nit < warn < error', () => {
    expect(severityRank('nit')).toBeLessThan(severityRank('warn'))
    expect(severityRank('warn')).toBeLessThan(severityRank('error'))
  })
})

describe('parseConfig defaults', () => {
  it('fills in every default from an empty mapping', () => {
    const config = parseConfig('{}')

    expect(config.rules).toEqual(DEFAULT_RULES)
    expect(config.ignore_paths).toEqual([])
    expect(config.use_default_ignores).toBe(true)
    expect(config.min_severity_to_comment).toBe('warn')
    expect(config.max_comments).toBe(20)
    expect(config.token_budget).toBe(150_000)
    expect(config.model).toBe(DEFAULT_MODEL)
    expect(config.provider).toBe('anthropic')
    expect(config.verdict).toEqual({ request_changes_on: 'error', approve_when_clean: true })
    expect(config.fail_on_request_changes).toBe(false)
  })

  it('treats a comments-only file as defaults rather than an error', () => {
    expect(parseConfig('# nothing here yet\n').model).toBe(DEFAULT_MODEL)
  })

  it('fills in the untouched half of a partially specified verdict block', () => {
    const config = parseConfig('verdict:\n  approve_when_clean: false\n')

    expect(config.verdict).toEqual({ request_changes_on: 'error', approve_when_clean: false })
  })

  it('keeps fail_on_request_changes off unless the repo opts in', () => {
    expect(parseConfig('fail_on_request_changes: true').fail_on_request_changes).toBe(true)
  })
})

describe('parseConfig validation', () => {
  it('rejects an unknown severity and names the exact path', () => {
    const yaml = 'rules:\n  - id: a\n    description: d\n    severity: critical\n'

    expect(() => parseConfig(yaml)).toThrow(ConfigError)
    expect(() => parseConfig(yaml)).toThrow(/rules\[0\]\.severity/)
  })

  it('rejects an unknown top-level key instead of ignoring the typo', () => {
    expect(() => parseConfig('ignore_path:\n  - "docs/**"\n')).toThrow(/Unrecognized key.*ignore_path/s)
  })

  it('rejects duplicate rule ids, pointing at both occurrences', () => {
    const yaml = [
      'rules:',
      '  - id: dup',
      '    description: first',
      '    severity: warn',
      '  - id: DUP',
      '    description: second',
      '    severity: error'
    ].join('\n')

    expect(() => parseConfig(yaml)).toThrow(/duplicate rule id "DUP".*rules\[0\]/s)
  })

  it('rejects a rule id that cannot go in a comment marker', () => {
    const yaml = 'rules:\n  - id: "bad id!"\n    description: d\n    severity: warn\n'

    expect(() => parseConfig(yaml)).toThrow(/rules\[0\]\.id/)
  })

  it('rejects a token budget below the floor', () => {
    expect(() => parseConfig('token_budget: 10')).toThrow(/token_budget/)
  })

  it('rejects a non-integer max_comments', () => {
    expect(() => parseConfig('max_comments: 2.5')).toThrow(/max_comments/)
  })

  it('requires fixture_path when the provider is fixture', () => {
    expect(() => parseConfig('provider: fixture')).toThrow(/fixture_path/)
    expect(parseConfig('provider: fixture\nfixture_path: findings.json\n').fixture_path).toBe('findings.json')
  })

  it('accepts the dry-run provider without any extra keys', () => {
    expect(parseConfig('provider: dry-run').dry_run_path).toBe('claude-review-prompt.txt')
  })

  it('rejects a base_url that is not a URL', () => {
    expect(() => parseConfig('base_url: not-a-url')).toThrow(/base_url/)
    expect(parseConfig('base_url: https://gateway.example.com').base_url).toBe('https://gateway.example.com')
  })

  it('reports every problem in one error rather than one per run', () => {
    const yaml = 'max_comments: 0\ntoken_budget: 5\nmodel: ""\n'

    const message = (() => {
      try {
        parseConfig(yaml)
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()

    expect(message).toMatch(/max_comments/)
    expect(message).toMatch(/token_budget/)
    expect(message).toMatch(/model/)
  })

  it('explains a YAML syntax error instead of leaking a parser stack', () => {
    expect(() => parseConfig('rules:\n  - id: a\n   description: bad indent\n')).toThrow(/not valid YAML/)
  })

  it('rejects a file that is a list rather than a mapping', () => {
    expect(() => parseConfig('- one\n- two\n')).toThrow(/must contain a YAML mapping/)
  })
})

describe('loadConfig', () => {
  it('reads the config from the workspace', () => {
    const workspace = makeWorkspace({ [DEFAULT_CONFIG_PATH]: 'max_comments: 5\n' })

    const loaded = loadConfig(DEFAULT_CONFIG_PATH, workspace)

    expect(loaded.source).toBe(DEFAULT_CONFIG_PATH)
    expect(loaded.config.max_comments).toBe(5)
  })

  it('falls back to defaults when the default path is absent', () => {
    const loaded = loadConfig(DEFAULT_CONFIG_PATH, makeWorkspace())

    expect(loaded.source).toBeNull()
    expect(loaded.config.rules).toEqual(DEFAULT_RULES)
  })

  it('fails when an explicitly configured path is absent', () => {
    const workspace = makeWorkspace()

    expect(() => loadConfig('.github/review.yml', workspace)).toThrow(ConfigError)
    expect(() => loadConfig('.github/review.yml', workspace)).toThrow(/actions\/checkout/)
  })

  it('reads a config from a subdirectory', () => {
    const workspace = makeWorkspace({ '.github/review.yml': 'model: claude-sonnet-5\n' })

    expect(loadConfig('.github/review.yml', workspace).config.model).toBe('claude-sonnet-5')
  })

  it('refuses a path that escapes the workspace', () => {
    expect(() => loadConfig('../outside.yml', makeWorkspace())).toThrow(/inside the repository/)
  })

  it('names the config file in a validation failure', () => {
    const workspace = makeWorkspace({ '.github/review.yml': 'max_comments: 0\n' })

    expect(() => loadConfig('.github/review.yml', workspace)).toThrow(/\.github\/review\.yml is not valid/)
  })
})

describe('the example config shipped in this repo', () => {
  it('parses and matches the built-in defaults', () => {
    // The committed .claude-review.yml is documentation. If it drifts from the
    // schema, every user who copies it starts from a broken file.
    const loaded = loadConfig(DEFAULT_CONFIG_PATH, process.cwd())

    expect(loaded.source).toBe(DEFAULT_CONFIG_PATH)
    expect(loaded.config.rules).toEqual(DEFAULT_RULES)
    expect(loaded.config.model).toBe(DEFAULT_MODEL)
  })

  it('is value-for-value identical to running with no config file at all', () => {
    // The README says deleting the file changes nothing. Comparing the whole
    // object rather than a few keys is what makes that sentence true: a default
    // changed in the schema and not in the example — or the reverse — fails here
    // instead of surprising someone who copied the example and expected the
    // documented behaviour.
    const shipped = loadConfig(DEFAULT_CONFIG_PATH, process.cwd()).config
    expect(shipped).toEqual(parseConfig(''))
  })
})
