import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.js'
import { RESOLVED_MARKER } from '../src/comments.js'
import type { PullRequestContext } from '../src/context.js'
import type { MappedFinding, SelectionResult } from '../src/findings.js'
import type { Octokit } from '../src/github.js'
import type { ReviewOutcome } from '../src/model.js'
import type { PlannedFile, ReviewPlan, SkippedFile } from '../src/plan.js'
import { renderSummary, summaryCostOutput, syncSummary, SUMMARY_MARKER, type SummaryInput } from '../src/summary.js'

const PR: PullRequestContext = {
  owner: 'octo',
  repo: 'demo',
  number: 7,
  title: 'Add a parser',
  headSha: 'abcdef1234567890abcdef1234567890abcdef12',
  baseRef: 'main',
  labels: [],
  draft: false,
  htmlUrl: 'https://github.com/octo/demo/pull/7',
  runUrl: 'https://github.com/octo/demo/actions/runs/42'
}

function finding(overrides: Partial<MappedFinding> = {}): MappedFinding {
  return {
    path: 'src/a.ts',
    line: 12,
    side: 'RIGHT',
    position: 4,
    severity: 'error',
    modelSeverity: 'error',
    ruleId: 'correctness',
    message: 'Off by one.',
    onContextLine: false,
    fingerprint: 'f'.repeat(40),
    ...overrides
  }
}

function plannedFile(path: string): PlannedFile {
  return {
    file: { path, status: 'modified', additions: 4, deletions: 1, churn: 5, patch: '@@ -1 +1 @@' },
    patch: '@@ -1 +1 @@',
    estimatedTokens: 100
  }
}

function plan(overrides: Partial<ReviewPlan> = {}): ReviewPlan {
  return {
    files: [plannedFile('src/a.ts')],
    skipped: [],
    estimatedTokens: 1_500,
    baseTokens: 1_400,
    tokenBudget: 150_000,
    budgetExhausted: false,
    ...overrides
  }
}

function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    provider: 'anthropic',
    toolInput: { findings: [] },
    usage: { inputTokens: 2_431, outputTokens: 512, cacheReadTokens: 0, cacheCreationTokens: 0 },
    truncated: false,
    ...overrides
  }
}

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  const selection: SelectionResult = overrides.selection ?? { selected: [], suppressed: [] }
  return {
    pr: PR,
    config: ConfigSchema.parse({}),
    verdict: 'approve',
    selection,
    mappedCount: selection.selected.length,
    dropped: [],
    plan: plan(),
    outcome: outcome(),
    comments: { created: 0, updated: 0, unchanged: 0, resolved: 0, revived: 0, failures: [] },
    ...overrides
  }
}

describe('renderSummary', () => {
  it('carries the fixed marker that makes it findable on a re-run', () => {
    expect(renderSummary(input())).toContain(SUMMARY_MARKER)
  })

  it('leads with the verdict', () => {
    expect(renderSummary(input({ verdict: 'approve' }))).toContain('## ✅ Claude review: APPROVE')
    expect(renderSummary(input({ verdict: 'comment' }))).toContain('## 💬 Claude review: COMMENT')
    expect(renderSummary(input({ verdict: 'request_changes' }))).toContain('## 🛑 Claude review: REQUEST CHANGES')
  })

  it('counts findings by severity, commented and not', () => {
    const body = renderSummary(
      input({
        verdict: 'request_changes',
        selection: {
          selected: [finding(), finding({ line: 20, severity: 'warn' })],
          suppressed: [{ finding: finding({ line: 30, severity: 'nit' }), reason: 'below-min-severity' }]
        },
        mappedCount: 3
      })
    )

    expect(body).toContain('| Error | 1 | 0 |')
    expect(body).toContain('| Warning | 1 | 0 |')
    expect(body).toContain('| Nit | 0 | 1 |')
  })

  it('names the config key that held a finding back', () => {
    const body = renderSummary(
      input({
        selection: {
          selected: [],
          suppressed: [{ finding: finding({ severity: 'nit' }), reason: 'below-min-severity' }]
        }
      })
    )

    expect(body).toContain('min_severity_to_comment: warn')
  })

  it('says plainly that a cap-suppressed finding still counts towards the verdict', () => {
    // Otherwise the table reads as absolution: the twenty-first error is still an
    // error, it just did not get a comment.
    const body = renderSummary(
      input({
        verdict: 'request_changes',
        selection: {
          selected: [],
          suppressed: [{ finding: finding(), reason: 'over-max-comments' }]
        }
      })
    )

    expect(body).toContain('max_comments: 20')
    expect(body).toContain('**do** count towards the verdict')
  })

  it('reports findings that could not be anchored, rather than letting them vanish', () => {
    const body = renderSummary(
      input({ dropped: [{ reason: 'unmappable-line', detail: 'src/a.ts:99 — not part of the diff' }] })
    )

    expect(body).toContain('1 finding(s) cited a line that is not part of the diff')
  })

  it('warns when the reply was truncated, because the findings list is then incomplete', () => {
    expect(renderSummary(input({ outcome: outcome({ truncated: true }) }))).toContain("model's reply hit its output limit")
  })

  it('reports the token usage and a dollar cost from it', () => {
    const body = renderSummary(input())

    expect(body).toContain('2,431 input · 512 output')
    // 2431 in at $1/Mtok + 512 out at $5/Mtok = $0.004991.
    expect(body).toContain('$0.0050')
    expect(body).toContain('`claude-haiku-4-5` via provider `anthropic`')
  })

  it('breaks out cache tokens only when there are any', () => {
    expect(renderSummary(input())).not.toContain('cache read')
    const cached = renderSummary(
      input({
        outcome: outcome({
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 2_000, cacheCreationTokens: 1_000 }
        })
      })
    )
    expect(cached).toContain('(2,000 cache read, 1,000 cache write)')
  })

  it('says nothing was spent when no model was called, which is not the same as an unknown cost', () => {
    const body = renderSummary(
      input({ config: ConfigSchema.parse({ provider: 'fixture', fixture_path: 'f.json' }), outcome: outcome({ provider: 'fixture', usage: null }) })
    )

    expect(body).toContain('did not call the API')
    expect(body).toContain('**$0.00** — no model call was made')
  })

  it('refuses to price an unknown model but still prints its exact token counts', () => {
    const body = renderSummary(input({ config: ConfigSchema.parse({ model: 'llm-of-the-week' }) }))

    expect(body).toContain('2,431 input · 512 output')
    expect(body).toContain('no published price on file')
    expect(body).not.toContain('$0.0000')
  })

  it('lists the files it did not review, grouped by reason', () => {
    const skipped: SkippedFile[] = [
      { path: 'package-lock.json', reason: 'ignored', detail: 'matched an ignore pattern' },
      { path: 'assets/logo.png', reason: 'no-patch', detail: 'no text diff available' },
      { path: 'src/big.ts', reason: 'budget', detail: '~9,000 estimated tokens, only ~200 left' }
    ]
    const body = renderSummary(input({ plan: plan({ skipped, budgetExhausted: true }) }))

    expect(body).toContain('3 file(s) were not reviewed')
    expect(body).toContain('**Ignored by pattern** (1)')
    expect(body).toContain('**Token budget exhausted** (1)')
    expect(body).toContain('`src/big.ts` — ~9,000 estimated tokens, only ~200 left')
    expect(body).toContain('**exhausted**')
  })

  it('states that nothing was reviewed rather than implying a clean review', () => {
    const body = renderSummary(input({ plan: plan({ files: [] }), comments: null }))

    expect(body).toContain('No reviewable files in this pull request')
    expect(body).toContain('none — nothing was reviewed')
    // No findings table: there were no findings to have.
    expect(body).not.toContain('| Severity |')
  })

  it('links back to the run and the commit it reviewed', () => {
    const body = renderSummary(input())

    expect(body).toContain('https://github.com/octo/demo/actions/runs/42')
    expect(body).toContain('`abcdef1`')
  })

  it('explains why the action comments instead of submitting a review', () => {
    expect(renderSummary(input())).toContain('can satisfy a required-review rule')
  })
})

describe('summaryCostOutput', () => {
  it('is the same number the comment shows', () => {
    expect(summaryCostOutput(input())).toBe('0.0050')
  })

  it('is zero when no model call was made, and empty when the model has no price', () => {
    expect(summaryCostOutput(input({ outcome: outcome({ provider: 'fixture', usage: null }) }))).toBe('0.00')
    expect(summaryCostOutput(input({ config: ConfigSchema.parse({ model: 'llm-of-the-week' }) }))).toBe('')
  })
})

interface StoredComment {
  id: number
  node_id: string
  body: string
  html_url: string
}

function stubOctokit(existing: StoredComment[] = [], overrides: { fail?: (name: string) => Error | null } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const record = (name: string) => async (args: Record<string, unknown>) => {
    calls.push({ name, args })
    const failure = overrides.fail?.(name)
    if (failure) throw failure
    return { data: { html_url: 'https://github.com/octo/demo/pull/7#issuecomment-1' } }
  }

  const octokit = {
    paginate: async () => existing,
    rest: {
      issues: {
        listComments: {},
        createComment: record('create'),
        updateComment: record('update')
      }
    },
    graphql: async (query: string, args: Record<string, unknown>) => {
      calls.push({ name: query.includes('unminimize') ? 'unminimize' : 'minimize', args })
      return {}
    }
  } as unknown as Octokit

  return { octokit, calls }
}

const stored = (id: number, body: string): StoredComment => ({
  id,
  node_id: `NODE_${id}`,
  body,
  html_url: `https://github.com/octo/demo/pull/7#issuecomment-${id}`
})

describe('syncSummary', () => {
  it('creates the summary when the pull request has none', async () => {
    const { octokit, calls } = stubOctokit([stored(1, 'A human comment.')])
    const result = await syncSummary(octokit, PR, 'BODY')

    expect(result.action).toBe('created')
    expect(calls.map(c => c.name)).toEqual(['create'])
    expect(calls[0]?.args).toMatchObject({ owner: 'octo', repo: 'demo', issue_number: 7, body: 'BODY' })
  })

  it('updates the existing summary in place instead of posting a second one', async () => {
    const { octokit, calls } = stubOctokit([stored(50, `${SUMMARY_MARKER}\nold body`)])
    const result = await syncSummary(octokit, PR, 'BODY')

    expect(result.action).toBe('updated')
    expect(calls.map(c => c.name)).toEqual(['update'])
    expect(calls[0]?.args).toMatchObject({ comment_id: 50, body: 'BODY' })
  })

  it('skips the write when the body has not changed', async () => {
    const body = `${SUMMARY_MARKER}\nsame body`
    const { octokit, calls } = stubOctokit([stored(50, body)])
    const result = await syncSummary(octokit, PR, body)

    expect(result.action).toBe('unchanged')
    expect(calls).toHaveLength(0)
  })

  it('converges on the oldest summary and collapses one a racing run left behind', async () => {
    // Two pushes in quick succession start two runs; both can list before either
    // creates. The oldest must win, or the survivor changes on every run.
    const { octokit, calls } = stubOctokit([
      stored(50, `${SUMMARY_MARKER}\nfirst`),
      stored(90, `${SUMMARY_MARKER}\nsecond`)
    ])
    const result = await syncSummary(octokit, PR, 'BODY')

    expect(result).toMatchObject({ action: 'updated', superseded: 1 })
    expect(calls.map(c => c.name)).toEqual(['update', 'minimize', 'update'])
    expect(calls[0]?.args).toMatchObject({ comment_id: 90 })
    expect(String(calls[0]?.args['body'])).toContain('Superseded')
    expect(calls[1]?.args).toMatchObject({ id: 'NODE_90', classifier: 'OUTDATED' })
    expect(calls[2]?.args).toMatchObject({ comment_id: 50, body: 'BODY' })
  })

  it('leaves an already-superseded duplicate alone on the next run', async () => {
    const { octokit, calls } = stubOctokit([
      stored(50, `${SUMMARY_MARKER}\nfirst`),
      stored(90, `${SUMMARY_MARKER}\n${RESOLVED_MARKER}\nSuperseded`)
    ])
    const result = await syncSummary(octokit, PR, 'BODY')

    expect(result.superseded).toBe(0)
    expect(calls.map(c => c.name)).toEqual(['update'])
  })

  it('fails the run when the summary cannot be posted', async () => {
    // Unlike an inline comment, there is no partial version of this: a missing
    // summary means the readout is gone, and a green check would be a lie.
    const { octokit } = stubOctokit([], {
      fail: () => Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
    })

    await expect(syncSummary(octokit, PR, 'BODY')).rejects.toThrow('pull-requests: write')
  })
})
