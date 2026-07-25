import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasSkipLabel, loadPullRequestContext, SKIP_REVIEW_LABEL } from '../src/context.js'

// `vi.mock` is hoisted above the imports, so the module under test sees this stub.
const contextMock = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  sha: 'fallbacksha0000000000000000000000000000',
  repo: { owner: 'octo', repo: 'demo' }
}))

vi.mock('@actions/github', () => ({
  get context() {
    return contextMock
  }
}))

function pullRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pull_request: {
      number: 42,
      title: 'Add rate limiting',
      draft: false,
      html_url: 'https://github.com/octo/demo/pull/42',
      head: { sha: 'abc1234def5678000000000000000000000000' },
      base: { ref: 'main' },
      labels: [{ name: 'enhancement' }],
      ...overrides
    }
  }
}

beforeEach(() => {
  contextMock.payload = {}
  process.env['GITHUB_SERVER_URL'] = 'https://github.com'
  process.env['GITHUB_RUN_ID'] = '987654'
})

describe('loadPullRequestContext', () => {
  it('returns null when the event is not a pull request', () => {
    contextMock.payload = { push: { ref: 'refs/heads/main' } }
    expect(loadPullRequestContext()).toBeNull()
  })

  it('returns null when the payload has no PR number', () => {
    contextMock.payload = { pull_request: { title: 'no number' } }
    expect(loadPullRequestContext()).toBeNull()
  })

  it('maps the payload onto the context object', () => {
    contextMock.payload = pullRequestPayload()

    const pr = loadPullRequestContext()

    expect(pr).not.toBeNull()
    expect(pr?.owner).toBe('octo')
    expect(pr?.repo).toBe('demo')
    expect(pr?.number).toBe(42)
    expect(pr?.title).toBe('Add rate limiting')
    expect(pr?.headSha).toBe('abc1234def5678000000000000000000000000')
    expect(pr?.baseRef).toBe('main')
    expect(pr?.labels).toEqual(['enhancement'])
    expect(pr?.draft).toBe(false)
  })

  it('builds a run URL from the workflow environment', () => {
    contextMock.payload = pullRequestPayload()
    expect(loadPullRequestContext()?.runUrl).toBe('https://github.com/octo/demo/actions/runs/987654')
  })

  it('falls back to the context sha when head.sha is absent', () => {
    contextMock.payload = pullRequestPayload({ head: undefined })
    expect(loadPullRequestContext()?.headSha).toBe(contextMock.sha)
  })

  it('accepts labels given as plain strings', () => {
    contextMock.payload = pullRequestPayload({ labels: ['skip-review', 'bug'] })
    expect(loadPullRequestContext()?.labels).toEqual(['skip-review', 'bug'])
  })

  it('tolerates missing or malformed labels', () => {
    contextMock.payload = pullRequestPayload({ labels: undefined })
    expect(loadPullRequestContext()?.labels).toEqual([])

    contextMock.payload = pullRequestPayload({ labels: [{}, { name: '' }, { name: 'ok' }] })
    expect(loadPullRequestContext()?.labels).toEqual(['ok'])
  })
})

describe('hasSkipLabel', () => {
  it('detects the skip label', () => {
    contextMock.payload = pullRequestPayload({ labels: [{ name: SKIP_REVIEW_LABEL }] })
    expect(hasSkipLabel(loadPullRequestContext()!)).toBe(true)
  })

  it('is case-insensitive', () => {
    contextMock.payload = pullRequestPayload({ labels: [{ name: 'Skip-Review' }] })
    expect(hasSkipLabel(loadPullRequestContext()!)).toBe(true)
  })

  it('is false when the label is absent', () => {
    contextMock.payload = pullRequestPayload({ labels: [{ name: 'enhancement' }] })
    expect(hasSkipLabel(loadPullRequestContext()!)).toBe(false)
  })

  it('does not match a label that merely contains the text', () => {
    contextMock.payload = pullRequestPayload({ labels: [{ name: 'do-not-skip-review-please' }] })
    expect(hasSkipLabel(loadPullRequestContext()!)).toBe(false)
  })
})
