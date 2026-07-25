import * as core from '@actions/core'
import { readInputs } from './inputs.js'
import { hasSkipLabel, loadPullRequestContext, SKIP_REVIEW_LABEL } from './context.js'
import { callGitHub, createOctokit } from './github.js'

/**
 * Milestone 1: prove the wiring end to end.
 *
 * Reads and validates inputs, resolves the pull request from the event payload,
 * honours the skip-review label, and makes exactly one authenticated GitHub call
 * so a misconfigured token fails loudly here rather than halfway through a review.
 * The review pipeline itself lands in later milestones.
 */
export async function run(): Promise<void> {
  const inputs = readInputs()

  const pr = loadPullRequestContext()
  if (!pr) {
    core.notice(
      'Not a pull_request event — nothing to review. Trigger this action on pull_request (opened, synchronize, reopened).'
    )
    core.setOutput('skipped', 'true')
    return
  }

  if (hasSkipLabel(pr)) {
    core.notice(`PR #${pr.number} carries the "${SKIP_REVIEW_LABEL}" label — skipping review.`)
    core.setOutput('skipped', 'true')
    return
  }

  const octokit = createOctokit(inputs.githubToken)
  const { data } = await callGitHub(`fetch pull request #${pr.number}`, () =>
    octokit.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.number })
  )

  core.info(`Repository:    ${pr.owner}/${pr.repo}`)
  core.info(`Pull request:  #${pr.number} — ${pr.title}`)
  core.info(`Base <- head:  ${pr.baseRef} <- ${pr.headSha.slice(0, 7)}`)
  core.info(`Changed files: ${data.changed_files} (+${data.additions} / -${data.deletions})`)
  core.info(`Config path:   ${inputs.configPath}`)
  core.info(`Labels:        ${pr.labels.length > 0 ? pr.labels.join(', ') : '(none)'}`)
  core.info(`Draft:         ${pr.draft}`)
  core.info('')
  core.info('Wiring OK. The review pipeline is not implemented yet (milestone 1 of 6).')

  core.setOutput('skipped', 'false')
  core.setOutput('verdict', 'comment')
  core.setOutput('findings_count', '0')
  core.setOutput('cost_usd', '0.00')
}
