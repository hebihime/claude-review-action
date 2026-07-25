import * as github from '@actions/github'
import { redact } from './redact.js'

export type Octokit = ReturnType<typeof github.getOctokit>

export function createOctokit(token: string): Octokit {
  return github.getOctokit(token)
}

/**
 * A GitHub API failure that already carries enough context to be printed as a
 * single readable log line. `index.ts` prints `error.message` and nothing else,
 * so a 403 shows up as an actionable sentence rather than an Octokit stack trace.
 */
export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError'

  constructor(
    readonly action: string,
    readonly status: number | undefined,
    message: string
  ) {
    super(message)
  }
}

interface OctokitErrorShape {
  status?: number
  message?: string
  response?: { data?: { message?: string } }
}

/** Permission hints for the status codes an Action realistically hits. */
function hintFor(status: number | undefined): string {
  switch (status) {
    case 401:
      return ' The github_token is missing or invalid.'
    case 403:
      return ' The token lacks the required permission, or the API rate limit is exhausted. This action needs "permissions: pull-requests: write" and "contents: read".'
    case 404:
      return ' The resource does not exist, or the token cannot see it (a fork PR using the default GITHUB_TOKEN is read-only).'
    case 422:
      return ' GitHub rejected the request body — most often a review comment anchored to a line that is not part of the diff.'
    default:
      return ''
  }
}

export function toGitHubApiError(action: string, error: unknown): GitHubApiError {
  const err = error as OctokitErrorShape
  const status = typeof err?.status === 'number' ? err.status : undefined
  const detail = err?.response?.data?.message ?? err?.message ?? String(error)
  const statusText = status === undefined ? '' : ` (HTTP ${status})`
  return new GitHubApiError(
    action,
    status,
    redact(`Failed to ${action}${statusText}: ${detail}.${hintFor(status)}`)
  )
}

/**
 * Wrap every Octokit call so failures surface as one readable line.
 * Usage: `await callGitHub('fetch pull request #12', () => octokit.rest.pulls.get(...))`
 */
export async function callGitHub<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw toGitHubApiError(action, error)
  }
}
