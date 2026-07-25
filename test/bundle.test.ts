import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * These tests execute the committed `dist/index.js` — the artefact GitHub
 * actually runs — rather than importing `src/`.
 *
 * Reason: ncc's tree-shaking dropped zod's English locale registration, and every
 * validation message in the bundle degraded to a bare "Invalid input" while the
 * unit tests kept passing against the unbundled source. Anything whose
 * correctness depends on surviving bundling has to be checked here.
 *
 * Only fake credentials are ever passed in. `core.setSecret` masks values by
 * emitting `::add-mask::`, which the GitHub runner strips but a local shell does
 * not — a real token given to this harness would be printed in cleartext.
 */

const BUNDLE = path.resolve('dist/index.js')
const dirs: string[] = []

const EVENT_PAYLOAD = JSON.stringify({
  pull_request: {
    number: 1,
    title: 'Bundle harness',
    draft: false,
    html_url: 'https://github.com/octo/demo/pull/1',
    head: { sha: '0123456789abcdef0123456789abcdef01234567' },
    base: { ref: 'main' },
    labels: []
  },
  repository: { name: 'demo', owner: { login: 'octo' } }
})

interface RunResult {
  status: number
  output: string
}

/** Run the bundle against a workspace containing `config`, and capture its log. */
function runBundle(config: string): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-review-bundle-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, '.claude-review.yml'), config, 'utf8')
  writeFileSync(path.join(dir, 'event.json'), EVENT_PAYLOAD, 'utf8')
  writeFileSync(path.join(dir, 'output.txt'), '', 'utf8')

  try {
    const stdout = execFileSync(process.execPath, [BUNDLE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
        GITHUB_WORKSPACE: dir,
        GITHUB_OUTPUT: path.join(dir, 'output.txt'),
        GITHUB_REPOSITORY: 'octo/demo',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_RUN_ID: '1',
        INPUT_ANTHROPIC_API_KEY: 'fake-key-never-real',
        INPUT_GITHUB_TOKEN: 'fake-token-never-real'
      }
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('the committed bundle', () => {
  it('exists', () => {
    expect(existsSync(BUNDLE), `${BUNDLE} is missing — run "npm run build".`).toBe(true)
  })

  it('reports an unknown config key by name, not as a bare "Invalid input"', () => {
    const result = runBundle('max_comment: 5\n')

    expect(result.status).toBe(1)
    expect(result.output).toContain('Unrecognized key')
    expect(result.output).toContain('max_comment')
  })

  it('reports an out-of-range value with the offending key and the limit', () => {
    const result = runBundle('token_budget: 10\n')

    expect(result.status).toBe(1)
    expect(result.output).toContain('token_budget')
    expect(result.output).toMatch(/1000/)
  })

  it('names the failing rule by index for a nested error', () => {
    const result = runBundle('rules:\n  - id: a\n    description: d\n    severity: critical\n')

    expect(result.status).toBe(1)
    expect(result.output).toContain('rules[0].severity')
  })

  it('fails on config before making any GitHub API call', () => {
    // The fake token would produce a 401 if the run got as far as the network,
    // so a config error here proves validation happens first — a broken config
    // costs nothing and fails fast.
    const result = runBundle('max_comment: 5\n')

    expect(result.output).not.toContain('Bad credentials')
  })
})
