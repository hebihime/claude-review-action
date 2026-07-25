import { describe, expect, it } from 'vitest'
import {
  extractFingerprint,
  isResolved,
  listReviewComments,
  markerFor,
  planComments,
  renderCommentBody,
  renderResolvedBody,
  syncComments,
  type ExistingComment
} from '../src/comments.js'
import { fingerprintOf, type MappedFinding } from '../src/findings.js'
import type { Octokit } from '../src/github.js'
import type { PullRequestContext } from '../src/context.js'

const PR: PullRequestContext = {
  owner: 'octo',
  repo: 'demo',
  number: 7,
  title: 'Add a parser',
  headSha: 'f'.repeat(40),
  baseRef: 'main',
  labels: [],
  draft: false,
  htmlUrl: 'https://github.com/octo/demo/pull/7',
  runUrl: 'https://github.com/octo/demo/actions/runs/1'
}

function finding(overrides: Partial<MappedFinding> = {}): MappedFinding {
  const path = overrides.path ?? 'src/a.ts'
  const line = overrides.line ?? 12
  const ruleId = overrides.ruleId ?? 'correctness'
  return {
    path,
    line,
    side: 'RIGHT',
    position: 4,
    severity: 'error',
    modelSeverity: 'error',
    ruleId,
    message: 'This loop reads one past the end.',
    onContextLine: false,
    fingerprint: fingerprintOf(path, line, ruleId),
    ...overrides
  }
}

function existingFor(f: MappedFinding, overrides: Partial<ExistingComment> = {}): ExistingComment {
  return {
    id: 100,
    nodeId: 'NODE_100',
    path: f.path,
    line: f.line,
    body: renderCommentBody(f),
    fingerprint: f.fingerprint,
    ...overrides
  }
}

const reviewed = (...paths: string[]): ReadonlySet<string> => new Set(paths.length ? paths : ['src/a.ts'])

describe('the idempotency marker', () => {
  it('is the sha1 of path, line and rule id, in the format the spec fixes', () => {
    const f = finding()
    expect(markerFor(f.fingerprint)).toBe(`<!-- claude-review:v1:${fingerprintOf('src/a.ts', 12, 'correctness')} -->`)
    expect(extractFingerprint(renderCommentBody(f))).toBe(f.fingerprint)
  })

  it('is not confused by the resolved marker, which is a different shape', () => {
    const resolved = renderResolvedBody(renderCommentBody(finding()), 'gone')
    expect(isResolved(resolved)).toBe(true)
    // The fingerprint has to survive resolution or the finding can never come back.
    expect(extractFingerprint(resolved)).toBe(finding().fingerprint)
  })

  it('finds nothing in a comment written by a human', () => {
    expect(extractFingerprint('Nice work, but see line 4.')).toBeNull()
    expect(isResolved('Nice work.')).toBe(false)
  })
})

describe('renderCommentBody', () => {
  it('renders the same bytes for the same finding, so a re-run has nothing to update', () => {
    expect(renderCommentBody(finding())).toBe(renderCommentBody(finding()))
  })

  it('leads with the severity and rule, and carries the message', () => {
    const body = renderCommentBody(finding({ severity: 'warn', ruleId: 'error-handling' }))
    expect(body).toContain('**Warning** · `error-handling`')
    expect(body).toContain('This loop reads one past the end.')
  })

  it('renders a suggestion as a committable suggestion block', () => {
    const body = renderCommentBody(finding({ suggestion: '  return sum' }))
    expect(body).toContain('```suggestion\n  return sum\n```')
  })

  it('lengthens the fence when the suggestion itself contains backticks', () => {
    const body = renderCommentBody(finding({ suggestion: 'const md = `a ``` b`' }))
    // A three-backtick fence would close on the run inside the code and spill the
    // rest of the suggestion into the comment as prose.
    expect(body).toContain('````suggestion')
    expect(body).toContain('const md = `a ``` b`')
  })
})

describe('renderResolvedBody', () => {
  it('keeps the original text rather than destroying a thread that may have replies', () => {
    const body = renderResolvedBody(renderCommentBody(finding()), 'gone')
    expect(body).toContain('no longer reported')
    expect(body).toContain('<details><summary>Original comment</summary>')
    expect(body).toContain('This loop reads one past the end.')
  })

  it('says something different when the comment was superseded rather than fixed', () => {
    expect(renderResolvedBody(renderCommentBody(finding()), 'superseded')).toContain('could not be re-anchored')
  })
})

describe('planComments', () => {
  it('creates a comment for a finding that has never been posted', () => {
    const plan = planComments([finding()], [], reviewed())
    expect(plan.posts).toEqual([{ action: 'create', finding: finding() }])
    expect(plan.resolves).toEqual([])
  })

  it('leaves an unchanged finding completely alone', () => {
    const f = finding()
    const plan = planComments([f], [existingFor(f)], reviewed())
    expect(plan.posts.map(p => p.action)).toEqual(['unchanged'])
    expect(plan.resolves).toEqual([])
  })

  it('tolerates the CRLF line endings GitHub may hand back', () => {
    const f = finding()
    const stored = existingFor(f, { body: renderCommentBody(f).replace(/\n/g, '\r\n') })
    expect(planComments([f], [stored], reviewed()).posts[0]?.action).toBe('unchanged')
  })

  it('updates in place when only the message changed', () => {
    const before = finding()
    const after = finding({ message: 'Rewritten explanation.' })
    const plan = planComments([after], [existingFor(before)], reviewed())
    expect(plan.posts[0]?.action).toBe('update')
    expect(plan.posts[0]?.existing?.id).toBe(100)
  })

  it('resolves a comment whose finding is gone', () => {
    const stale = existingFor(finding())
    const plan = planComments([], [stale], reviewed())
    expect(plan.posts).toEqual([])
    expect(plan.resolves).toEqual([{ existing: stale, reason: 'gone' }])
  })

  it('does not resolve a comment twice', () => {
    const stale = existingFor(finding(), { body: renderResolvedBody(renderCommentBody(finding()), 'gone') })
    expect(planComments([], [stale], reviewed()).resolves).toEqual([])
  })

  it('revives a resolved comment when the finding comes back', () => {
    const f = finding()
    const stale = existingFor(f, { body: renderResolvedBody(renderCommentBody(f), 'gone') })
    const plan = planComments([f], [stale], reviewed())
    expect(plan.posts[0]?.action).toBe('revive')
    expect(plan.resolves).toEqual([])
  })

  it('leaves comments on a file that was not reviewed this run', () => {
    // The whole point: a file dropped by the token budget produces no findings,
    // which is not evidence that its findings were fixed. Resolving here would
    // un-resolve on the next run with spare budget, and the comments would flap.
    const stale = existingFor(finding({ path: 'src/dropped.ts' }))
    expect(planComments([], [stale], reviewed('src/a.ts')).resolves).toEqual([])
  })

  it('treats a moved finding as a new comment and resolves the old one', () => {
    // The marker is path + line + rule by specification, so a finding that slides
    // to a new line is a different fingerprint. Both halves have to happen.
    const before = finding({ line: 12 })
    const after = finding({ line: 30 })
    const plan = planComments([after], [existingFor(before)], reviewed())
    expect(plan.posts.map(p => p.action)).toEqual(['create'])
    expect(plan.resolves.map(r => r.reason)).toEqual(['gone'])
  })

  it('re-posts a finding whose comment GitHub could no longer anchor, and marks the stale copy', () => {
    const f = finding()
    const outdated = existingFor(f, { line: null })
    const plan = planComments([f], [outdated], reviewed())
    expect(plan.posts.map(p => p.action)).toEqual(['create'])
    expect(plan.resolves).toEqual([{ existing: outdated, reason: 'superseded' }])
  })

  it('converges on one comment per finding when an earlier run duplicated it', () => {
    const f = finding()
    const first = existingFor(f, { id: 100, nodeId: 'NODE_100' })
    const second = existingFor(f, { id: 200, nodeId: 'NODE_200' })
    const plan = planComments([f], [second, first], reviewed())
    expect(plan.posts.map(p => p.existing?.id)).toEqual([100])
    expect(plan.resolves.map(r => r.existing.id)).toEqual([200])
  })
})

/** A minimal Octokit that records calls; nothing here touches the network. */
function stubOctokit(overrides: { fail?: (name: string) => unknown } = {}): {
  octokit: Octokit
  calls: Array<{ name: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const record = (name: string) => async (args: Record<string, unknown>) => {
    calls.push({ name, args })
    const failure = overrides.fail?.(name)
    if (failure) throw failure
    return { data: {} }
  }
  const octokit = {
    rest: {
      pulls: {
        createReviewComment: record('create'),
        updateReviewComment: record('update')
      }
    },
    graphql: async (query: string, args: Record<string, unknown>) => {
      calls.push({ name: query.includes('unminimize') ? 'unminimize' : 'minimize', args })
      return {}
    }
  } as unknown as Octokit
  return { octokit, calls }
}

describe('syncComments', () => {
  it('creates, updates and resolves in one pass, and counts each', async () => {
    const kept = finding({ line: 12 })
    const changed = finding({ line: 20, message: 'New text.' })
    const fresh = finding({ line: 33 })
    const gone = existingFor(finding({ line: 44 }), { id: 300, nodeId: 'NODE_300' })

    const plan = planComments(
      [kept, changed, fresh],
      [existingFor(kept), existingFor(finding({ line: 20 }), { id: 200, nodeId: 'NODE_200' }), gone],
      reviewed()
    )
    const { octokit, calls } = stubOctokit()
    const result = await syncComments(octokit, PR, plan)

    expect(result).toMatchObject({ created: 1, updated: 1, unchanged: 1, resolved: 1, revived: 0, failures: [] })
    expect(calls.map(c => c.name)).toEqual(['update', 'create', 'update', 'minimize'])
  })

  it('anchors a new comment to the head commit with line and side', async () => {
    const { octokit, calls } = stubOctokit()
    await syncComments(octokit, PR, planComments([finding()], [], reviewed()))

    expect(calls[0]?.args).toMatchObject({
      owner: 'octo',
      repo: 'demo',
      pull_number: 7,
      commit_id: PR.headSha,
      path: 'src/a.ts',
      line: 12,
      side: 'RIGHT'
    })
  })

  it('expands a revived comment instead of leaving it collapsed', async () => {
    const f = finding()
    const stale = existingFor(f, { body: renderResolvedBody(renderCommentBody(f), 'gone') })
    const { octokit, calls } = stubOctokit()
    const result = await syncComments(octokit, PR, planComments([f], [stale], reviewed()))

    expect(result.revived).toBe(1)
    expect(calls.map(c => c.name)).toEqual(['update', 'unminimize'])
  })

  it('keeps posting the rest of the review when GitHub rejects one anchor', async () => {
    let seen = 0
    const { octokit } = stubOctokit({
      fail: name => (name === 'create' && seen++ === 0 ? Object.assign(new Error('bad anchor'), { status: 422 }) : null)
    })
    const plan = planComments([finding({ line: 12 }), finding({ line: 30 })], [], reviewed())
    const result = await syncComments(octokit, PR, plan)

    expect(result.created).toBe(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.detail).toContain('HTTP 422')
  })

  it('gives up immediately on a failure that will repeat for every comment', async () => {
    // A 403 is about the token, not the comment. Retrying it twenty times would
    // fill the log with the same line and hide the one thing worth reading.
    const { octokit, calls } = stubOctokit({
      fail: () => Object.assign(new Error('Resource not accessible by integration'), { status: 403 })
    })
    const plan = planComments([finding({ line: 12 }), finding({ line: 30 })], [], reviewed())

    await expect(syncComments(octokit, PR, plan)).rejects.toThrow('pull-requests: write')
    expect(calls).toHaveLength(1)
  })

  it('does not fail the run when the comment cannot be collapsed', async () => {
    const stale = existingFor(finding())
    const octokit = {
      rest: { pulls: { updateReviewComment: async () => ({ data: {} }) } },
      graphql: async () => {
        throw new Error('minimizeComment is not supported here')
      }
    } as unknown as Octokit

    const result = await syncComments(octokit, PR, planComments([], [stale], reviewed()))
    expect(result.resolved).toBe(1)
    expect(result.collapseNote).toContain('not supported')
  })
})

describe('listReviewComments', () => {
  it('claims comments by their marker, not by who posted them', async () => {
    const mine = renderCommentBody(finding())
    const octokit = {
      paginate: async () => [
        { id: 1, node_id: 'A', path: 'src/a.ts', line: 12, body: mine, user: { login: 'someone-else' } },
        { id: 2, node_id: 'B', path: 'src/a.ts', line: 3, body: 'A human wrote this.', user: { login: 'bot' } },
        { id: 3, node_id: 'C', path: 'src/a.ts', line: null, body: mine }
      ],
      rest: { pulls: { listReviewComments: {} } }
    } as unknown as Octokit

    const found = await listReviewComments(octokit, PR)
    expect(found.map(c => c.id)).toEqual([1, 3])
    expect(found[1]?.line).toBeNull()
  })
})
