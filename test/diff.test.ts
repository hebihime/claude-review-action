import { describe, expect, it, vi } from 'vitest'
import type { PullRequestContext } from '../src/context.js'
import { fetchChangedFiles } from '../src/diff.js'
import { GitHubApiError, type Octokit } from '../src/github.js'

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

/** Minimal Octokit stand-in: only `paginate` and the endpoint reference are used. */
function octokitReturning(files: unknown[]): { octokit: Octokit; paginate: ReturnType<typeof vi.fn> } {
  const paginate = vi.fn().mockResolvedValue(files)
  const octokit = { paginate, rest: { pulls: { listFiles: 'listFiles-endpoint' } } } as unknown as Octokit
  return { octokit, paginate }
}

function octokitRejecting(error: unknown): Octokit {
  return {
    paginate: vi.fn().mockRejectedValue(error),
    rest: { pulls: { listFiles: 'listFiles-endpoint' } }
  } as unknown as Octokit
}

describe('fetchChangedFiles', () => {
  it('requests every page of the file list', async () => {
    const { octokit, paginate } = octokitReturning([])

    await fetchChangedFiles(octokit, pr)

    expect(paginate).toHaveBeenCalledWith('listFiles-endpoint', {
      owner: 'octo',
      repo: 'demo',
      pull_number: 7,
      per_page: 100
    })
  })

  it('maps the API shape and derives churn', async () => {
    const { octokit } = octokitReturning([
      { filename: 'src/a.ts', status: 'modified', additions: 12, deletions: 5, patch: '@@ -1 +1 @@\n-a\n+b\n' }
    ])

    const [file] = await fetchChangedFiles(octokit, pr)

    expect(file).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      additions: 12,
      deletions: 5,
      churn: 17,
      patch: '@@ -1 +1 @@\n-a\n+b\n'
    })
  })

  it('leaves patch undefined for a binary file rather than inventing an empty diff', async () => {
    const { octokit } = octokitReturning([
      { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }
    ])

    const [file] = await fetchChangedFiles(octokit, pr)

    expect(file?.patch).toBeUndefined()
    expect(file?.churn).toBe(0)
  })

  it('carries the previous path through a rename', async () => {
    const { octokit } = octokitReturning([
      {
        filename: 'src/b.ts',
        previous_filename: 'src/a.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0
      }
    ])

    const [file] = await fetchChangedFiles(octokit, pr)

    expect(file?.previousPath).toBe('src/a.ts')
    expect(file?.status).toBe('renamed')
  })

  it('preserves the order the API returned', async () => {
    const { octokit } = octokitReturning([
      { filename: 'z.ts', status: 'modified', additions: 1, deletions: 0, patch: 'p' },
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: 'p' }
    ])

    expect((await fetchChangedFiles(octokit, pr)).map(f => f.path)).toEqual(['z.ts', 'a.ts'])
  })

  it('turns an API failure into one readable line naming the pull request', async () => {
    const octokit = octokitRejecting(Object.assign(new Error('Bad credentials'), { status: 401 }))

    await expect(fetchChangedFiles(octokit, pr)).rejects.toThrow(GitHubApiError)
    await expect(fetchChangedFiles(octokit, pr)).rejects.toThrow(
      /Failed to list changed files on pull request #7 \(HTTP 401\)/
    )
  })
})
