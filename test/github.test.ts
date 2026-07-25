import { afterEach, describe, expect, it } from 'vitest'
import { callGitHub, GitHubApiError, toGitHubApiError } from '../src/github.js'
import { registerSecret, resetSecretsForTesting } from '../src/redact.js'

afterEach(() => {
  resetSecretsForTesting()
})

describe('toGitHubApiError', () => {
  it('names the action and the status code', () => {
    const err = toGitHubApiError('fetch pull request #7', { status: 404, message: 'Not Found' })
    expect(err).toBeInstanceOf(GitHubApiError)
    expect(err.status).toBe(404)
    expect(err.message).toContain('Failed to fetch pull request #7 (HTTP 404): Not Found.')
  })

  it('adds a permission hint for 403', () => {
    const err = toGitHubApiError('post review comment', { status: 403, message: 'Resource not accessible' })
    expect(err.message).toContain('pull-requests: write')
  })

  it('adds a diff-anchoring hint for 422', () => {
    const err = toGitHubApiError('post review comment', { status: 422, message: 'Unprocessable' })
    expect(err.message).toContain('not part of the diff')
  })

  it('prefers the response body message over the generic one', () => {
    const err = toGitHubApiError('list files', {
      status: 422,
      message: 'Validation Failed',
      response: { data: { message: 'pull_request_review_thread.line must be part of the diff' } }
    })
    expect(err.message).toContain('line must be part of the diff')
  })

  it('handles an error with no status', () => {
    const err = toGitHubApiError('list files', new Error('socket hang up'))
    expect(err.status).toBeUndefined()
    expect(err.message).toBe('Failed to list files: socket hang up.')
  })

  it('redacts secrets that appear in the API error text', () => {
    registerSecret('ghp_0123456789abcdefghij')
    const err = toGitHubApiError('list files', {
      status: 401,
      message: 'Bad credentials for ghp_0123456789abcdefghij'
    })
    expect(err.message).not.toContain('ghp_0123456789abcdefghij')
    expect(err.message).toContain('***')
  })
})

describe('callGitHub', () => {
  it('passes through the resolved value', async () => {
    await expect(callGitHub('do a thing', async () => 42)).resolves.toBe(42)
  })

  it('wraps a rejection in a GitHubApiError', async () => {
    const failing = async (): Promise<never> => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }
    await expect(callGitHub('fetch pull request #3', failing)).rejects.toBeInstanceOf(GitHubApiError)
  })
})
