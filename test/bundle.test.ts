import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

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

const FIXTURE_PATCH = [
  '@@ -1,4 +1,6 @@',
  ' export function total(items) {',
  '-  return items.count',
  '+  let sum = 0',
  '+  for (let i = 0; i <= items.length; i++) sum += items[i]',
  '+  return sum',
  ' }'
].join('\n')

/**
 * A stand-in for the GitHub REST API.
 *
 * `@actions/github` builds its Octokit against `GITHUB_API_URL`, so pointing that
 * at this server lets the real bundle run its whole pipeline — config, diff,
 * budget, prompt assembly, position mapping — with no network and no credentials.
 */
let server: Server
let apiUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('content-type', 'application/json')

    if (url.startsWith('/repos/octo/demo/pulls/1/files')) {
      res.end(
        JSON.stringify([
          { filename: 'src/total.js', status: 'modified', additions: 3, deletions: 1, patch: FIXTURE_PATCH },
          { filename: 'package-lock.json', status: 'modified', additions: 900, deletions: 4, patch: '@@ -1 +1 @@\n+x' },
          { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 }
        ])
      )
      return
    }
    if (url.startsWith('/repos/octo/demo/pulls/1')) {
      res.end(JSON.stringify({ number: 1, changed_files: 3, additions: 903, deletions: 5 }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ message: 'Not Found' }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

interface RunResult {
  status: number
  output: string
  workspace: string
}

interface RunOptions {
  /** Extra files to drop into the workspace, keyed by repo-relative path. */
  files?: Record<string, string>
  /** Point the bundle at the stub API so it gets past the GitHub calls. */
  withApi?: boolean
  apiKey?: string
}

/**
 * Run the bundle against a workspace containing `config`, and capture its log.
 *
 * Asynchronous on purpose: the stub API server shares this process's event loop,
 * so a synchronous `execFileSync` would block the very thread that has to answer
 * the child's HTTP requests, and the two would deadlock.
 */
async function runBundle(config: string, options: RunOptions = {}): Promise<RunResult> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-review-bundle-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, '.claude-review.yml'), config, 'utf8')
  writeFileSync(path.join(dir, 'event.json'), EVENT_PAYLOAD, 'utf8')
  writeFileSync(path.join(dir, 'output.txt'), '', 'utf8')
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    writeFileSync(path.join(dir, name), contents, 'utf8')
  }

  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
    GITHUB_WORKSPACE: dir,
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    GITHUB_REPOSITORY: 'octo/demo',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_RUN_ID: '1',
    INPUT_GITHUB_TOKEN: 'fake-token-never-real'
  }
  if (options.apiKey !== undefined) env['INPUT_ANTHROPIC_API_KEY'] = options.apiKey
  if (options.withApi) env['GITHUB_API_URL'] = apiUrl

  return new Promise<RunResult>(resolve => {
    execFile(process.execPath, [BUNDLE], { encoding: 'utf8', env }, (error, stdout, stderr) => {
      const status = (error as { code?: number } | null)?.code ?? 0
      resolve({ status, output: `${stdout}${stderr}`, workspace: dir })
    })
  })
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

  it('reports an unknown config key by name, not as a bare "Invalid input"', async () => {
    const result = await runBundle('max_comment: 5\n', { apiKey: 'fake-key-never-real' })

    expect(result.status).toBe(1)
    expect(result.output).toContain('Unrecognized key')
    expect(result.output).toContain('max_comment')
  })

  it('reports an out-of-range value with the offending key and the limit', async () => {
    const result = await runBundle('token_budget: 10\n', { apiKey: 'fake-key-never-real' })

    expect(result.status).toBe(1)
    expect(result.output).toContain('token_budget')
    expect(result.output).toMatch(/1000/)
  })

  it('names the failing rule by index for a nested error', async () => {
    const result = await runBundle('rules:\n  - id: a\n    description: d\n    severity: critical\n', {
      apiKey: 'fake-key-never-real'
    })

    expect(result.status).toBe(1)
    expect(result.output).toContain('rules[0].severity')
  })

  it('fails on config before making any GitHub API call', async () => {
    // No stub API is wired up here, so any GitHub call would fail loudly. A
    // config error instead proves validation happens first — a broken config
    // costs nothing and fails fast.
    const result = await runBundle('max_comment: 5\n', { apiKey: 'fake-key-never-real' })

    expect(result.output).not.toContain('Bad credentials')
  })
})

describe('the committed bundle, running the full pipeline', () => {
  it('assembles a real prompt in dry-run mode with no API key at all', async () => {
    const result = await runBundle('provider: dry-run\ndry_run_path: prompt.txt\n', { withApi: true })

    expect(result.status).toBe(0)
    expect(result.output).toContain('no model was called')

    // The whole point of dry-run: the prompt is a reviewable artefact.
    const prompt = readFileSync(path.join(result.workspace, 'prompt.txt'), 'utf8')
    expect(prompt).toContain('### src/total.js')
    expect(prompt).toContain('report_findings')
    // Position mapping survives bundling. The removed line takes no number, so
    // the first added line is head line 2 and the closing brace is head line 5.
    expect(prompt).toMatch(/^\s+2 \|\+  let sum = 0$/m)
    expect(prompt).toMatch(/^\s+\|-  return items\.count$/m)
    expect(prompt).toMatch(/^\s+5 \| \}$/m)
  })

  it('applies ignore globs and binary detection before assembling the prompt', async () => {
    const result = await runBundle('provider: dry-run\ndry_run_path: prompt.txt\n', { withApi: true })
    const prompt = readFileSync(path.join(result.workspace, 'prompt.txt'), 'utf8')

    expect(prompt).not.toContain('package-lock.json')
    expect(prompt).not.toContain('assets/logo.png')
    expect(prompt).toContain('1 file(s) follow')
  })

  it('maps replayed findings onto diff lines and reports a verdict', async () => {
    const fixture = JSON.stringify({
      findings: [
        {
          path: 'src/total.js',
          line: 3,
          severity: 'error',
          rule_id: 'correctness',
          message: 'This loop reads one past the end of the array.'
        },
        {
          path: 'src/total.js',
          line: 999,
          severity: 'warn',
          rule_id: 'clarity',
          message: 'Cites a line that is not in the diff.'
        }
      ]
    })
    const result = await runBundle('provider: fixture\nfixture_path: findings.json\n', {
      withApi: true,
      files: { 'findings.json': fixture }
    })

    expect(result.status).toBe(0)
    expect(result.output).toContain('ERROR src/total.js:3 [correctness]')
    expect(result.output).toContain('Findings dropped (unmappable-line): 1')

    const outputs = readFileSync(path.join(result.workspace, 'output.txt'), 'utf8')
    expect(outputs).toMatch(/verdict<<.*\nrequest_changes/)
    expect(outputs).toMatch(/findings_count<<.*\n1/)
  })

  it('fails the check only when the repository opted in to blocking merges', async () => {
    const fixture = JSON.stringify([
      {
        path: 'src/total.js',
        line: 4,
        severity: 'error',
        rule_id: 'correctness',
        message: 'Off by one.'
      }
    ])
    const config = 'provider: fixture\nfixture_path: findings.json\nfail_on_request_changes: true\n'
    const result = await runBundle(config, { withApi: true, files: { 'findings.json': fixture } })

    expect(result.status).toBe(1)
    expect(result.output).toContain('fail_on_request_changes is enabled')
  })

  it('requires an API key only for the provider that actually calls the API', async () => {
    const result = await runBundle('provider: anthropic\n', { withApi: true })

    expect(result.status).toBe(1)
    expect(result.output).toContain('required when provider is "anthropic"')
  })
})
