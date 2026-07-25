import { SEVERITIES, type ReviewConfig } from './config.js'
import type { PullRequestContext } from './context.js'
import { parsePatch, renderAnnotatedPatch } from './patch.js'
import type { PlannedFile } from './plan.js'

/**
 * Prompt assembly.
 *
 * Kept free of any SDK import so the exact text sent to the model can be
 * asserted in tests and written to disk by `provider: dry-run` without a client.
 */

export const FINDINGS_TOOL_NAME = 'report_findings'

export interface FindingsTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/**
 * Structured output is forced through tool use rather than asked for in prose:
 * with `tool_choice` pinned to this tool the model cannot reply with an apology,
 * a markdown table, or JSON wrapped in a code fence.
 */
export const FINDINGS_TOOL: FindingsTool = {
  name: FINDINGS_TOOL_NAME,
  description:
    'Report every code review finding for this pull request. Call this exactly once. Call it with an empty findings list when the diff is clean.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        description: 'Every finding, in any order. Empty when there is nothing to report.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The file path exactly as it appears in the "### " header above the diff.'
            },
            line: {
              type: 'integer',
              description:
                'A line number from the gutter of that file\'s diff. Must be a number that is actually printed; lines with a blank gutter were removed and cannot be commented on.'
            },
            severity: {
              type: 'string',
              enum: [...SEVERITIES],
              description: 'How serious this specific instance is.'
            },
            rule_id: {
              type: 'string',
              description: 'The id of the rule this finding falls under, copied exactly from the rules list.'
            },
            message: {
              type: 'string',
              description:
                'One to three sentences addressed to the pull request author: what is wrong, and what it will cause.'
            },
            suggestion: {
              type: 'string',
              description:
                'Optional replacement source for the cited line, with no diff markers and no explanation. Include only when you can write the corrected code.'
            }
          },
          required: ['path', 'line', 'severity', 'rule_id', 'message']
        }
      }
    },
    required: ['findings']
  }
}

function renderRules(config: ReviewConfig): string {
  return config.rules.map(rule => `- ${rule.id} (${rule.severity}): ${rule.description}`).join('\n')
}

/**
 * The static half of the system prompt. Split out so its token cost can be
 * measured directly by the budget estimator's test.
 */
export const SYSTEM_PREAMBLE = `You are a meticulous code reviewer running as a GitHub Action on a pull request. You see only the changed lines of each file, never the whole repository.

Review the diff against the rules below and against nothing else. Each rule's description defines what counts as a finding for that rule. An observation that does not fall under one of these rules is not a finding, however true it is.`

export const SYSTEM_INSTRUCTIONS = `HOW TO REPORT

Call the ${FINDINGS_TOOL_NAME} tool exactly once. An empty findings list is a normal and common outcome — a clean diff is not a failure to find something.

Every finding anchors to a line that is visible in the diff. Each line is printed with its number in the file as it will exist after this pull request:

    42 |+  const total = items.length
       |-  const total = items.count
    43 |   return total

Use that number as \`line\`. "+" marks an added line, "-" a removed line, and a space an unchanged line included for context. A line with a blank gutter was removed and cannot be commented on: anchor to the nearest numbered line instead and say in the message that the problem is in the removed code.

Copy \`path\` exactly from the "### " header above each diff, and \`rule_id\` exactly from the rules list.

WRITING THE MESSAGE

Address the author directly. Say what is wrong and what it will cause, in one to three sentences. No preamble, no restating the code back, no praise.

Include \`suggestion\` only when you can write the corrected source for the line you cited. It is offered to the author as a committable change, so it must be code alone — no diff markers, no commentary. Omit it when the fix spans more code than you can see or needs a judgement call.

WHAT NOT TO REPORT

- Anything a formatter or linter already enforces.
- Speculation about code you cannot see. When correctness depends on a function whose body is not in the diff, assume it does what its name says.
- Pre-existing problems on unchanged context lines, unless this pull request makes them materially worse.
- The same problem twice. Report it once, at its cause.

Prefer fewer, higher-confidence findings. A wrong finding costs the author more time than a missed one costs the project.`

export function buildSystemPrompt(config: ReviewConfig): string {
  return `${SYSTEM_PREAMBLE}\n\nRULES\n\n${renderRules(config)}\n\n${SYSTEM_INSTRUCTIONS}`
}

export function buildUserPrompt(pr: PullRequestContext, files: readonly PlannedFile[]): string {
  const header = [
    `Pull request #${pr.number} in ${pr.owner}/${pr.repo}: ${pr.title}`,
    `Merging into: ${pr.baseRef}`,
    '',
    `${files.length} file(s) follow. These diffs are everything you can see.`
  ].join('\n')

  const sections = files.map(planned => {
    const annotated = renderAnnotatedPatch(parsePatch(planned.patch))
    return `### ${planned.file.path}\n\n${annotated}`
  })

  return [header, ...sections].join('\n\n')
}

export interface AssembledPrompt {
  system: string
  user: string
  tool: FindingsTool
}

export function assemblePrompt(
  pr: PullRequestContext,
  config: ReviewConfig,
  files: readonly PlannedFile[]
): AssembledPrompt {
  return {
    system: buildSystemPrompt(config),
    user: buildUserPrompt(pr, files),
    tool: FINDINGS_TOOL
  }
}

/** The exact text `provider: dry-run` writes, so a human can read what would be sent. */
export function renderPromptForReview(prompt: AssembledPrompt, model: string): string {
  return [
    `# claude-review-action — assembled prompt (provider: dry-run)`,
    ``,
    `Model that would be called: ${model}`,
    `Tool that would be forced:  ${prompt.tool.name}`,
    ``,
    `## System prompt`,
    ``,
    prompt.system,
    ``,
    `## User message`,
    ``,
    prompt.user,
    ``,
    `## Tool schema`,
    ``,
    JSON.stringify(prompt.tool, null, 2),
    ``
  ].join('\n')
}
