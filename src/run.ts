import * as core from '@actions/core'
import { readInputs } from './inputs.js'
import { hasSkipLabel, loadPullRequestContext, SKIP_REVIEW_LABEL } from './context.js'
import { callGitHub, createOctokit } from './github.js'
import { loadConfig } from './config.js'
import { fetchChangedFiles, GITHUB_MAX_FILES } from './diff.js'
import { planReview, type ReviewPlan, type SkippedFile } from './plan.js'

/** Group the skipped files by reason so the log stays short on a big PR. */
function logSkipped(skipped: readonly SkippedFile[]): void {
  const byReason = new Map<string, SkippedFile[]>()
  for (const file of skipped) {
    const bucket = byReason.get(file.reason)
    if (bucket) bucket.push(file)
    else byReason.set(file.reason, [file])
  }

  for (const [reason, files] of byReason) {
    core.startGroup(`Skipped (${reason}): ${files.length}`)
    for (const file of files) core.info(`${file.path} — ${file.detail}`)
    core.endGroup()
  }
}

function logPlan(plan: ReviewPlan): void {
  core.startGroup(`Reviewing ${plan.files.length} file(s), highest churn first`)
  for (const planned of plan.files) {
    const { file } = planned
    core.info(
      `${file.path} (+${file.additions} / -${file.deletions}) ~${planned.estimatedTokens.toLocaleString('en-US')} tokens`
    )
  }
  core.endGroup()

  logSkipped(plan.skipped)

  core.info(
    `Estimated prompt tokens: ~${plan.estimatedTokens.toLocaleString('en-US')} of ${plan.tokenBudget.toLocaleString('en-US')} (including ~${plan.baseTokens.toLocaleString('en-US')} of rules and instructions).`
  )
  if (plan.budgetExhausted) {
    core.warning(
      `The token budget was exhausted; ${plan.skipped.filter(f => f.reason === 'budget').length} file(s) were left unreviewed. Raise token_budget or narrow the pull request.`
    )
  }
}

/**
 * Milestone 2: everything up to the model call.
 *
 * Resolves the PR, loads and validates the config, fetches the diff, and decides
 * which files this run would review under the token budget. The model call itself
 * lands in milestone 3 — nothing here spends money.
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

  const { config, source } = loadConfig(inputs.configPath)
  const octokit = createOctokit(inputs.githubToken)

  const { data } = await callGitHub(`fetch pull request #${pr.number}`, () =>
    octokit.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.number })
  )

  core.info(`Repository:    ${pr.owner}/${pr.repo}`)
  core.info(`Pull request:  #${pr.number} — ${pr.title}`)
  core.info(`Base <- head:  ${pr.baseRef} <- ${pr.headSha.slice(0, 7)}`)
  core.info(`Changed files: ${data.changed_files} (+${data.additions} / -${data.deletions})`)
  core.info(
    `Config:        ${source ?? `${inputs.configPath} (not found — using built-in defaults)`}, ${config.rules.length} rule(s)`
  )
  core.info(`Model:         ${config.model} via provider "${config.provider}"`)
  core.info('')

  const files = await fetchChangedFiles(octokit, pr)
  if (files.length >= GITHUB_MAX_FILES) {
    core.warning(
      `This pull request touches at least ${GITHUB_MAX_FILES} files, which is the maximum the GitHub API will list. Files beyond that limit are invisible to this action and were not considered.`
    )
  }

  const plan = planReview(files, config)
  logPlan(plan)

  if (plan.files.length === 0) {
    core.notice('No reviewable files in this pull request — nothing was sent to the model.')
  }

  core.info('')
  core.info('Config, diff and budget are wired up. The model call lands in milestone 3 of 6.')

  core.setOutput('skipped', 'false')
  core.setOutput('verdict', 'comment')
  core.setOutput('findings_count', '0')
  core.setOutput('cost_usd', '0.00')
}
