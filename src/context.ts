import * as github from '@actions/github'

/** A PR carrying this label is skipped entirely (documented in the README). */
export const SKIP_REVIEW_LABEL = 'skip-review'

export interface PullRequestContext {
  owner: string
  repo: string
  number: number
  title: string
  /** Head commit the review comments are anchored to. */
  headSha: string
  baseRef: string
  labels: string[]
  draft: boolean
  htmlUrl: string
  /** Link back to this workflow run, used in the summary comment. */
  runUrl: string
}

interface EventPayloadPullRequest {
  number?: number
  title?: string
  draft?: boolean
  html_url?: string
  head?: { sha?: string }
  base?: { ref?: string }
  labels?: Array<{ name?: string } | string>
}

function normalizeLabels(labels: EventPayloadPullRequest['labels']): string[] {
  if (!Array.isArray(labels)) return []
  const names: string[] = []
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

/**
 * Build the PR context from the workflow event payload.
 *
 * Returns `null` when the workflow was not triggered by a pull request — the
 * caller exits cleanly rather than failing, so the action can be dropped into a
 * workflow with mixed triggers without breaking it.
 */
export function loadPullRequestContext(): PullRequestContext | null {
  const ctx = github.context
  const pr = ctx.payload.pull_request as EventPayloadPullRequest | undefined
  if (!pr || typeof pr.number !== 'number') return null

  const headSha = pr.head?.sha ?? ctx.sha
  const serverUrl = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'
  const runId = process.env['GITHUB_RUN_ID'] ?? ''

  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    number: pr.number,
    title: pr.title ?? `#${pr.number}`,
    headSha,
    baseRef: pr.base?.ref ?? '',
    labels: normalizeLabels(pr.labels),
    draft: pr.draft === true,
    htmlUrl: pr.html_url ?? `${serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/pull/${pr.number}`,
    runUrl: `${serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${runId}`
  }
}

export function hasSkipLabel(pr: PullRequestContext): boolean {
  return pr.labels.some(label => label.toLowerCase() === SKIP_REVIEW_LABEL)
}
