import type { PullRequestContext } from './context.js'
import type { MappedFinding } from './findings.js'
import { callGitHub, GitHubApiError, type Octokit } from './github.js'
import type { Severity } from './config.js'

/**
 * Posting findings as inline review comments, idempotently.
 *
 * The hard part is not creating comments, it is the second run. A pull request is
 * re-reviewed on every push, and a reviewer that re-posts the same three comments
 * each time is worse than no reviewer at all. So every comment carries a hidden
 * marker holding the sha1 of `path:line:rule_id`, and a re-run reconciles against
 * it: same marker and same text is left alone, same marker and different text is
 * edited in place, a marker with no matching finding is marked resolved, and only
 * a genuinely new finding creates a comment.
 *
 * The marker is the identity — not the comment author. The action may post as
 * `github-actions[bot]` in one repo and as a PAT's user in another, and a repo can
 * switch between them without orphaning every comment it has already made.
 */

export const MARKER_VERSION = 'v1'

/** `<!-- claude-review:v1:<sha1> -->`, exactly as the spec specifies it. */
export function markerFor(fingerprint: string): string {
  return `<!-- claude-review:${MARKER_VERSION}:${fingerprint} -->`
}

const MARKER_PATTERN = new RegExp(`<!--\\s*claude-review:${MARKER_VERSION}:([0-9a-f]{40})\\s*-->`)

/** Distinct from the fingerprint marker so neither pattern can match the other. */
export const RESOLVED_MARKER = '<!-- claude-review:resolved -->'

export function extractFingerprint(body: string): string | null {
  return MARKER_PATTERN.exec(body)?.[1] ?? null
}

export function isResolved(body: string): boolean {
  return body.includes(RESOLVED_MARKER)
}

function stripMarkers(body: string): string {
  return body.replace(MARKER_PATTERN, '').split(RESOLVED_MARKER).join('').trim()
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warn: 'Warning',
  nit: 'Nit'
}

/**
 * A fence long enough to contain `text`.
 *
 * A suggestion is model output that frequently *is* markdown-adjacent code, and a
 * three-backtick run inside it would close the block early and spill raw markdown
 * into the comment.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The comment body, and the single definition of "has this finding changed".
 *
 * `planComments` compares a freshly rendered body against the one already on
 * GitHub, so anything that varies between runs without the finding changing —
 * a timestamp, a run number, a commit sha — must never appear here. It would make
 * every re-run rewrite every comment.
 */
export function renderCommentBody(finding: MappedFinding): string {
  const parts = [markerFor(finding.fingerprint), `**${SEVERITY_LABEL[finding.severity]}** · \`${finding.ruleId}\``, '', finding.message]

  if (finding.suggestion) {
    const fence = fenceFor(finding.suggestion)
    // A ```suggestion block renders as a one-click committable change. It replaces
    // the line this comment is anchored to, which is exactly the contract the
    // prompt gives the model for the `suggestion` field.
    parts.push('', `${fence}suggestion`, finding.suggestion, fence)
  }

  return parts.join('\n')
}

export type ResolveReason =
  /** The finding was not reported against the current commit. */
  | 'gone'
  /** Another comment now carries this finding against the current diff. */
  | 'superseded'

const RESOLVE_NOTE: Record<ResolveReason, string> = {
  gone: '**Resolved** — this finding is no longer reported for the latest commit.',
  superseded: '**Outdated** — this comment could not be re-anchored to the current diff; a newer comment carries the finding.'
}

/**
 * Rewrite a comment into its resolved form, keeping the fingerprint marker.
 *
 * The original text is folded into a `<details>` rather than deleted: the comment
 * may already have replies, and destroying the thread to tidy up would lose
 * conversation the author cared about. Keeping the marker is what makes a revive
 * possible if the finding comes back on a later push.
 */
export function renderResolvedBody(existingBody: string, reason: ResolveReason): string {
  const fingerprint = extractFingerprint(existingBody)
  const original = stripMarkers(existingBody)

  const lines = fingerprint ? [markerFor(fingerprint)] : []
  lines.push(
    RESOLVED_MARKER,
    RESOLVE_NOTE[reason],
    '',
    '<details><summary>Original comment</summary>',
    '',
    original,
    '',
    '</details>'
  )
  return lines.join('\n')
}

export interface ExistingComment {
  id: number
  /** GraphQL node id, needed to collapse the comment when it is resolved. */
  nodeId: string
  path: string
  /** Null when GitHub could no longer anchor the comment to the current diff. */
  line: number | null
  body: string
  fingerprint: string
}

/**
 * Every review comment on the PR that carries one of our markers, oldest first.
 *
 * Ordered by id so that when two comments somehow share a fingerprint — a partly
 * failed earlier run — the same one wins every time and the extras are collapsed.
 */
export async function listReviewComments(octokit: Octokit, pr: PullRequestContext): Promise<ExistingComment[]> {
  const raw = await callGitHub(`list review comments on pull request #${pr.number}`, () =>
    octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100
    })
  )

  const ours: ExistingComment[] = []
  for (const comment of raw) {
    const body = comment.body ?? ''
    const fingerprint = extractFingerprint(body)
    if (!fingerprint) continue
    ours.push({
      id: comment.id,
      nodeId: comment.node_id,
      path: comment.path,
      line: comment.line ?? null,
      body,
      fingerprint
    })
  }

  return ours.sort((a, b) => a.id - b.id)
}

export type PostAction = 'create' | 'update' | 'unchanged' | 'revive'

export interface PlannedComment {
  action: PostAction
  finding: MappedFinding
  /** The comment to edit. Absent only for `create`. */
  existing?: ExistingComment
}

export interface PlannedResolve {
  existing: ExistingComment
  reason: ResolveReason
}

export interface CommentPlan {
  posts: PlannedComment[]
  resolves: PlannedResolve[]
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim()
}

/**
 * Decide what to do with each finding and each comment already on the PR.
 *
 * `reviewedPaths` is the guard against flapping. A file dropped by the token
 * budget, or newly matched by an ignore glob, produces no findings this run — but
 * that is not evidence its findings were fixed, and resolving its comments would
 * un-resolve them on the next run that has budget to spare. Only a file that was
 * actually sent to the model can have its comments resolved.
 */
export function planComments(
  selected: readonly MappedFinding[],
  existing: readonly ExistingComment[],
  reviewedPaths: ReadonlySet<string>
): CommentPlan {
  const byFingerprint = new Map<string, ExistingComment[]>()
  for (const comment of existing) {
    const bucket = byFingerprint.get(comment.fingerprint)
    if (bucket) bucket.push(comment)
    else byFingerprint.set(comment.fingerprint, [comment])
  }
  // Oldest first, decided here rather than trusted from the caller: when a partly
  // failed run has left two comments on one fingerprint, which of them survives
  // must not depend on the order the API happened to return them in.
  for (const bucket of byFingerprint.values()) bucket.sort((a, b) => a.id - b.id)

  const posts: PlannedComment[] = []
  const resolves: PlannedResolve[] = []
  const claimed = new Set<string>()

  for (const finding of selected) {
    claimed.add(finding.fingerprint)
    const group = byFingerprint.get(finding.fingerprint) ?? []

    // Only a comment GitHub can still place on the diff is worth editing. An
    // outdated one is collapsed under the old commit where nobody will read it,
    // so the finding is re-posted at its current line and the stale copy is
    // marked outdated rather than left to look like live feedback.
    const target = group.find(comment => comment.line !== null)

    for (const comment of group) {
      if (comment === target) continue
      if (isResolved(comment.body)) continue
      resolves.push({ existing: comment, reason: 'superseded' })
    }

    if (!target) {
      posts.push({ action: 'create', finding })
      continue
    }
    if (isResolved(target.body)) {
      posts.push({ action: 'revive', finding, existing: target })
      continue
    }
    posts.push({
      action: normalizeBody(target.body) === normalizeBody(renderCommentBody(finding)) ? 'unchanged' : 'update',
      finding,
      existing: target
    })
  }

  for (const [fingerprint, group] of byFingerprint) {
    if (claimed.has(fingerprint)) continue
    for (const comment of group) {
      if (!reviewedPaths.has(comment.path)) continue
      if (isResolved(comment.body)) continue
      resolves.push({ existing: comment, reason: 'gone' })
    }
  }

  resolves.sort((a, b) => a.existing.id - b.existing.id)
  return { posts, resolves }
}

export interface CommentFailure {
  path: string
  line: number | null
  detail: string
}

export interface SyncResult {
  created: number
  updated: number
  unchanged: number
  resolved: number
  revived: number
  /** Comments GitHub refused with a 422; the rest of the run continued. */
  failures: CommentFailure[]
  /** Set when the collapse-on-resolve step could not run; purely cosmetic. */
  collapseNote?: string
}

/**
 * `minimizeComment` classifiers. RESOLVED and OUTDATED are the two that describe
 * what actually happened, and GitHub renders both as a collapsed comment.
 */
export const CLASSIFIER: Record<ResolveReason, string> = { gone: 'RESOLVED', superseded: 'OUTDATED' }

const MINIMIZE_MUTATION = `mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $id, classifier: $classifier }) { clientMutationId }
}`

const UNMINIMIZE_MUTATION = `mutation($id: ID!) {
  unminimizeComment(input: { subjectId: $id }) { clientMutationId }
}`

/**
 * Collapse or expand a comment. Best effort, by design.
 *
 * This is the only GraphQL in the action, and the rewritten body already says the
 * comment is resolved. If the mutation is unavailable — an older GitHub
 * Enterprise, a token without the scope — the review is still correct, just
 * slightly noisier, and failing the run over presentation would be absurd.
 *
 * Returns the failure message rather than throwing, so the caller can report it
 * once instead of once per comment. Shared with the summary comment, which
 * collapses its own superseded duplicates the same way.
 */
export async function setCollapsed(octokit: Octokit, nodeId: string, classifier: string | null): Promise<string | null> {
  try {
    if (classifier) {
      await octokit.graphql(MINIMIZE_MUTATION, { id: nodeId, classifier })
    } else {
      await octokit.graphql(UNMINIMIZE_MUTATION, { id: nodeId })
    }
    return null
  } catch (error) {
    return (error as Error)?.message ?? String(error)
  }
}

/** True for the failures that are about one comment rather than about the run. */
function isSingleCommentRejection(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 422
}

/**
 * Execute the plan.
 *
 * A 422 is tolerated per comment and nothing else is. GitHub returns 422 when a
 * single comment cannot be anchored — the one failure mode that is about that
 * comment alone, and that should not cost the author the other nine. A 401, 403 or
 * 5xx will fail identically for every comment, so it is raised immediately instead
 * of being repeated `max_comments` times in the log.
 */
export async function syncComments(octokit: Octokit, pr: PullRequestContext, plan: CommentPlan): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, unchanged: 0, resolved: 0, revived: 0, failures: [] }
  let collapseNote: string | null = null

  for (const post of plan.posts) {
    const { finding } = post
    if (post.action === 'unchanged') {
      result.unchanged += 1
      continue
    }

    const body = renderCommentBody(finding)
    const existing = post.existing
    try {
      if (existing) {
        await callGitHub(`update review comment on ${finding.path}:${finding.line}`, () =>
          octokit.rest.pulls.updateReviewComment({
            owner: pr.owner,
            repo: pr.repo,
            comment_id: existing.id,
            body
          })
        )
        if (post.action === 'revive') {
          result.revived += 1
          collapseNote ??= await setCollapsed(octokit, existing.nodeId, null)
        } else {
          result.updated += 1
        }
      } else {
        await callGitHub(`comment on ${finding.path}:${finding.line}`, () =>
          octokit.rest.pulls.createReviewComment({
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.number,
            commit_id: pr.headSha,
            path: finding.path,
            line: finding.line,
            side: finding.side,
            body
          })
        )
        result.created += 1
      }
    } catch (error) {
      if (!isSingleCommentRejection(error)) throw error
      result.failures.push({
        path: finding.path,
        line: finding.line,
        detail: (error as GitHubApiError).message
      })
    }
  }

  for (const { existing, reason } of plan.resolves) {
    try {
      await callGitHub(`mark the comment on ${existing.path} as resolved`, () =>
        octokit.rest.pulls.updateReviewComment({
          owner: pr.owner,
          repo: pr.repo,
          comment_id: existing.id,
          body: renderResolvedBody(existing.body, reason)
        })
      )
      result.resolved += 1
      collapseNote ??= await setCollapsed(octokit, existing.nodeId, CLASSIFIER[reason])
    } catch (error) {
      if (!isSingleCommentRejection(error)) throw error
      result.failures.push({ path: existing.path, line: existing.line, detail: (error as GitHubApiError).message })
    }
  }

  if (collapseNote) result.collapseNote = collapseNote
  return result
}
