import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../src/config.js'
import { buildRequest, MAX_OUTPUT_TOKENS, ModelApiError, requestReview, toModelApiError } from '../src/model.js'
import { assemblePrompt, FINDINGS_TOOL_NAME } from '../src/prompt.js'
import type { PullRequestContext } from '../src/context.js'
import type { PlannedFile } from '../src/plan.js'

const pr: PullRequestContext = {
  owner: 'octo',
  repo: 'demo',
  number: 7,
  title: 'Add a thing',
  headSha: 'abc1234def',
  baseRef: 'main',
  labels: [],
  draft: false,
  htmlUrl: 'https://github.com/octo/demo/pull/7',
  runUrl: 'https://github.com/octo/demo/actions/runs/1'
}

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n return a'
const files: PlannedFile[] = [
  {
    file: { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, churn: 1, patch: PATCH },
    patch: PATCH,
    estimatedTokens: 100
  }
]

const config = ConfigSchema.parse({})
const prompt = assemblePrompt(pr, config, files)

const dirs: string[] = []
function tempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-review-model-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A Messages API reply carrying one forced tool call. */
function replyWith(input: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: config.model,
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: FINDINGS_TOOL_NAME, input }],
    usage: { input_tokens: 1234, output_tokens: 56 },
    ...overrides
  }
}

describe('buildRequest', () => {
  it('forces the findings tool so the reply cannot be prose', () => {
    const request = buildRequest(prompt, config)

    expect(request.tool_choice).toEqual({ type: 'tool', name: FINDINGS_TOOL_NAME })
    expect(request.tools?.[0]?.name).toBe(FINDINGS_TOOL_NAME)
  })

  it('sends the configured model, the system prompt and one user message', () => {
    const request = buildRequest(prompt, config)

    expect(request.model).toBe(config.model)
    expect(request.system).toBe(prompt.system)
    expect(request.messages).toEqual([{ role: 'user', content: prompt.user }])
    expect(request.max_tokens).toBe(MAX_OUTPUT_TOKENS)
  })
})

describe('requestReview with provider "anthropic"', () => {
  it('returns the tool input and the reported usage', async () => {
    const create = vi.fn().mockResolvedValue(replyWith({ findings: [{ path: 'src/a.ts' }] }))

    const outcome = await requestReview(prompt, config, 'fake-key', { create: create as never })

    expect(outcome.provider).toBe('anthropic')
    expect(outcome.toolInput).toEqual({ findings: [{ path: 'src/a.ts' }] })
    expect(outcome.usage).toEqual({
      inputTokens: 1234,
      outputTokens: 56,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
    expect(outcome.truncated).toBe(false)
  })

  it('flags a reply that ran out of output tokens', async () => {
    const create = vi.fn().mockResolvedValue(replyWith({ findings: [] }, { stop_reason: 'max_tokens' }))

    const outcome = await requestReview(prompt, config, 'fake-key', { create: create as never })

    expect(outcome.truncated).toBe(true)
  })

  it('does not silently report a clean review when the tool was never called', async () => {
    const reply = replyWith({}, { content: [{ type: 'text', text: 'Looks fine to me!' }], stop_reason: 'end_turn' })
    const create = vi.fn().mockResolvedValue(reply)

    const outcome = await requestReview(prompt, config, 'fake-key', { create: create as never })

    expect(outcome.toolInput).toEqual({ findings: [] })
    expect(outcome.note).toContain('no report_findings call')
  })

  it('refuses to run without an API key, and says which provider needs one', async () => {
    await expect(requestReview(prompt, config, '', { create: vi.fn() as never })).rejects.toThrow(
      /anthropic_api_key.*provider is "anthropic"/s
    )
  })

  it('turns an API failure into one readable line', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 }))

    await expect(requestReview(prompt, config, 'fake-key', { create: create as never })).rejects.toThrow(
      ModelApiError
    )
    await expect(requestReview(prompt, config, 'fake-key', { create: create as never })).rejects.toThrow(
      /Model review call failed \(HTTP 401\).*anthropic_api_key input is missing or invalid/s
    )
  })
})

describe('toModelApiError', () => {
  it('names the configured model when the model does not exist', () => {
    const error = toModelApiError(Object.assign(new Error('not_found'), { status: 404 }), 'claude-nope')

    expect(error.message).toContain('No such model as "claude-nope"')
    expect(error.status).toBe(404)
  })

  it('explains a rate limit as recoverable', () => {
    expect(toModelApiError(Object.assign(new Error('rate'), { status: 429 }), 'm').message).toContain('re-run it')
  })

  it('handles an error with no status at all', () => {
    const error = toModelApiError(new Error('socket hang up'), 'm')

    expect(error.status).toBeUndefined()
    expect(error.message).toContain('socket hang up')
  })
})

describe('requestReview with provider "dry-run"', () => {
  it('writes the assembled prompt and calls no model', async () => {
    const workspace = tempWorkspace()
    const dryRun = ConfigSchema.parse({ provider: 'dry-run', dry_run_path: 'out/prompt.txt' })
    const create = vi.fn()

    const outcome = await requestReview(prompt, dryRun, '', { workspace, create: create as never })

    expect(create).not.toHaveBeenCalled()
    expect(outcome.usage).toBeNull()
    expect(outcome.toolInput).toEqual({ findings: [] })

    const written = readFileSync(path.join(workspace, 'out/prompt.txt'), 'utf8')
    expect(written).toContain(prompt.system)
    expect(written).toContain(prompt.user)
    expect(written).toContain(FINDINGS_TOOL_NAME)
  })

  it('refuses to write outside the workspace', async () => {
    const workspace = tempWorkspace()
    const escaping = ConfigSchema.parse({ provider: 'dry-run', dry_run_path: '../escaped.txt' })

    await expect(requestReview(prompt, escaping, '', { workspace })).rejects.toThrow(
      /dry_run_path must stay inside the repository/
    )
  })
})

describe('requestReview with provider "fixture"', () => {
  function withFixture(contents: string): { workspace: string } {
    const workspace = tempWorkspace()
    writeFileSync(path.join(workspace, 'findings.json'), contents, 'utf8')
    return { workspace }
  }

  const fixtureConfig = ConfigSchema.parse({ provider: 'fixture', fixture_path: 'findings.json' })

  it('replays findings from the file without calling a model', async () => {
    const { workspace } = withFixture(JSON.stringify({ findings: [{ path: 'src/a.ts', line: 2 }] }))
    const create = vi.fn()

    const outcome = await requestReview(prompt, fixtureConfig, '', { workspace, create: create as never })

    expect(create).not.toHaveBeenCalled()
    expect(outcome.toolInput).toEqual({ findings: [{ path: 'src/a.ts', line: 2 }] })
    expect(outcome.usage).toBeNull()
  })

  it('accepts a bare array as the findings list', async () => {
    const { workspace } = withFixture(JSON.stringify([{ path: 'src/a.ts', line: 2 }]))

    const outcome = await requestReview(prompt, fixtureConfig, '', { workspace })

    expect(outcome.toolInput).toEqual({ findings: [{ path: 'src/a.ts', line: 2 }] })
  })

  it('replays usage when the fixture carries it, so the cost readout can be exercised', async () => {
    const { workspace } = withFixture(
      JSON.stringify({ findings: [], usage: { input_tokens: 9000, output_tokens: 250 } })
    )

    const outcome = await requestReview(prompt, fixtureConfig, '', { workspace })

    expect(outcome.usage).toEqual({
      inputTokens: 9000,
      outputTokens: 250,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
  })

  it('names the file when it is missing', async () => {
    const workspace = tempWorkspace()

    await expect(requestReview(prompt, fixtureConfig, '', { workspace })).rejects.toThrow(
      /Could not read the findings fixture "findings.json"/
    )
  })

  it('names the file when it is not valid JSON', async () => {
    const { workspace } = withFixture('{ not json')

    await expect(requestReview(prompt, fixtureConfig, '', { workspace })).rejects.toThrow(
      /findings.json" is not valid JSON/
    )
  })
})
