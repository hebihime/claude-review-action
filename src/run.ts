import * as core from '@actions/core'
import { readInputs } from './inputs.js'
import { hasSkipLabel, loadPullRequestContext, SKIP_REVIEW_LABEL } from './context.js'
import { callGitHub, createOctokit } from './github.js'
import { loadConfig, type ReviewConfig } from './config.js'
import { fetchChangedFiles, GITHUB_MAX_FILES } from './diff.js'
import { planReview, type ReviewPlan, type SkippedFile } from './plan.js'
import { assemblePrompt } from './prompt.js'
import { requestReview, type ReviewOutcome } from './model.js'
import {
  countBySeverity,
  indexReviewed,
  selectFindings,
  validateFindings,
  type DroppedFinding,
  type MappedFinding,
  type SelectionResult
} from './findings.js'
import { decideVerdict, type Verdict } from './verdict.js'

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

/** Group the dropped findings by reason, so a systematic failure is visible at a glance. */
function logDropped(dropped: readonly DroppedFinding[]): void {
  if (dropped.length === 0) return

  const byReason = new Map<string, DroppedFinding[]>()
  for (const drop of dropped) {
    const bucket = byReason.get(drop.reason)
    if (bucket) bucket.push(drop)
    else byReason.set(drop.reason, [drop])
  }

  for (const [reason, drops] of byReason) {
    core.startGroup(`Findings dropped (${reason}): ${drops.length}`)
    for (const drop of drops) core.info(drop.detail)
    core.endGroup()
  }

  // Worth a warning rather than a quiet group: a model that cannot cite a valid
  // line is a prompt problem, and it would otherwise look like a clean review.
  const unmappable = dropped.filter(drop => drop.reason === 'unmappable-line').length
  if (unmappable > 0) {
    core.warning(
      `${unmappable} finding(s) cited a line that is not part of the diff and could not be anchored to a comment.`
    )
  }
}

function logFindings(selection: SelectionResult, findings: readonly MappedFinding[]): void {
  const counts = countBySeverity(selection.selected)
  core.info(
    `Findings: ${selection.selected.length} to report (${counts.error} error, ${counts.warn} warn, ${counts.nit} nit) out of ${findings.length} mapped.`
  )

  if (selection.selected.length > 0) {
    core.startGroup(`Findings (${selection.selected.length})`)
    for (const finding of selection.selected) {
      core.info(`${finding.severity.toUpperCase()} ${finding.path}:${finding.line} [${finding.ruleId}] ${finding.message}`)
    }
    core.endGroup()
  }

  const belowMin = selection.suppressed.filter(entry => entry.reason === 'below-min-severity').length
  if (belowMin > 0) {
    core.info(`${belowMin} finding(s) were below min_severity_to_comment and will not be posted.`)
  }
  const overCap = selection.suppressed.filter(entry => entry.reason === 'over-max-comments').length
  if (overCap > 0) {
    core.warning(
      `${overCap} finding(s) exceeded max_comments and will not be posted as inline comments. They still count towards the verdict.`
    )
  }

  // The rule's severity is authoritative; log the disagreements so a rule whose
  // severity is consistently wrong for its description is visible.
  const disagreements = selection.selected.filter(finding => finding.modelSeverity !== finding.severity).length
  if (disagreements > 0) {
    core.info(
      `${disagreements} finding(s) were re-labelled to their rule's configured severity (the model proposed a different one).`
    )
  }
}

function logUsage(outcome: ReviewOutcome, config: ReviewConfig): void {
  if (outcome.note) core.info(outcome.note)

  if (outcome.truncated) {
    core.warning(
      "The model's reply hit the output token limit, so its findings list may be incomplete. Narrow the pull request, or lower token_budget so fewer files are reviewed at once."
    )
  }

  if (!outcome.usage) {
    core.info(`Model usage:   none — provider "${outcome.provider}" did not call the API.`)
    return
  }
  core.info(
    `Model usage:   ${outcome.usage.inputTokens.toLocaleString('en-US')} input / ${outcome.usage.outputTokens.toLocaleString('en-US')} output tokens on ${config.model}.`
  )
}

/**
 * Milestone 3: everything up to posting.
 *
 * Resolves the PR, loads and validates the config, fetches the diff, decides
 * what fits the token budget, asks the model for findings, and maps each one
 * onto a line a comment can actually anchor to. Posting lands in milestone 4.
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
    finish(emptySelection(), config)
    return
  }

  core.info('')
  const prompt = assemblePrompt(pr, config, plan.files)
  const outcome = await requestReview(prompt, config, inputs.anthropicApiKey)
  logUsage(outcome, config)

  const reviewed = indexReviewed(plan.files, config)
  const { findings, dropped } = validateFindings(outcome.toolInput, reviewed)
  logDropped(dropped)

  const selection = selectFindings(findings, config)
  logFindings(selection, findings)

  core.info('')
  core.info('Findings are mapped to commentable lines. Posting them lands in milestone 4 of 6.')

  finish(selection, config)
}

function emptySelection(): SelectionResult {
  return { selected: [], suppressed: [] }
}

/**
 * Set the outputs and the exit code.
 *
 * The check fails only when the verdict is `request_changes` *and* the repo opted
 * in with `fail_on_request_changes`. A failing check is a merge blocker, and a
 * model is not reliable enough to hold that veto by default.
 */
function finish(selection: SelectionResult, config: ReviewConfig): void {
  const verdict: Verdict = decideVerdict(selection, config)

  core.setOutput('skipped', 'false')
  core.setOutput('verdict', verdict)
  core.setOutput('findings_count', String(selection.selected.length))
  // The pricing table and the USD readout land with the summary comment in
  // milestone 5; reporting a made-up number here would be worse than zero.
  core.setOutput('cost_usd', '0.00')

  core.info(`Verdict:       ${verdict}`)

  if (verdict === 'request_changes' && config.fail_on_request_changes) {
    core.setFailed(
      'Review verdict is request_changes and fail_on_request_changes is enabled, so this check is failing.'
    )
  }
}
