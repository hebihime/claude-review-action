import { callGitHub, type Octokit } from './github.js'
import type { PullRequestContext } from './context.js'

export type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'

export interface ChangedFile {
  path: string
  /** Set only for renames and copies. */
  previousPath?: string
  status: FileStatus
  additions: number
  deletions: number
  /** additions + deletions — the churn used to order the review. */
  churn: number
  /**
   * Unified diff for this file. Absent for binary files and for files whose diff
   * GitHub considers too large to inline; both are unreviewable and get skipped.
   */
  patch?: string
}

/** GitHub truncates `pulls.listFiles` at 3000 entries however you paginate. */
export const GITHUB_MAX_FILES = 3000

/**
 * Fetch every changed file on the pull request, following pagination.
 *
 * Uses the API rather than `git diff` on the checkout: the action must work when
 * the workflow used a shallow checkout, or no checkout at all.
 */
export async function fetchChangedFiles(octokit: Octokit, pr: PullRequestContext): Promise<ChangedFile[]> {
  const files = await callGitHub(`list changed files on pull request #${pr.number}`, () =>
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100
    })
  )

  return files.map(file => {
    const additions = file.additions ?? 0
    const deletions = file.deletions ?? 0
    const changed: ChangedFile = {
      path: file.filename,
      status: file.status as FileStatus,
      additions,
      deletions,
      churn: additions + deletions
    }
    if (file.previous_filename) changed.previousPath = file.previous_filename
    if (file.patch) changed.patch = file.patch
    return changed
  })
}
