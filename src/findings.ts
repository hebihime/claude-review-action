import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SEVERITIES, severityRank, type ReviewConfig, type Rule, type Severity } from './config.js'
import { parsePatch, type DiffSide, type ParsedPatch } from './patch.js'
import type { PlannedFile } from './plan.js'

/**
 * Turning what the model said into something that can actually be posted.
 *
 * The model is not trusted here. It can cite a file that was never sent, a rule
 * that does not exist, or a line that is not part of the diff — the last one is
 * the common case, and posting it would be a 422 from the GitHub API. Every
 * rejection is counted and reported rather than silently swallowed, because
 * "we found nothing" and "we threw away everything we found" must not look alike
 * in the log.
 */

/** Long messages are truncated rather than dropped: the finding is still useful. */
export const MAX_MESSAGE_CHARS = 2000
export const MAX_SUGGESTION_CHARS = 1000

/**
 * Deliberately not a strict object. Model output is not a config file: an extra
 * key is noise to be stripped, not an error worth discarding a real finding for.
 */
export const FindingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  severity: z.enum(SEVERITIES),
  rule_id: z.string().min(1),
  message: z.string().min(1),
  suggestion: z.string().min(1).optional()
})

export type RawFinding = z.infer<typeof FindingSchema>

/**
 * `findings` is required rather than defaulted. An explicit empty list is a clean
 * review; a tool call with no list at all means something went wrong, and the two
 * must not produce the same silent "nothing found" result.
 */
export const ToolInputSchema = z.object({
  findings: z.array(z.unknown())
})

export type DropReason =
  /** Did not match the tool schema at all. */
  | 'malformed'
  /** Cited a file that was not part of this review. */
  | 'unknown-path'
  /** Cited a rule id that is not in the config. */
  | 'unknown-rule'
  /** Cited a line that is not in the diff, so no comment can anchor to it. */
  | 'unmappable-line'
  /** Same file, line and rule as a finding already kept. */
  | 'duplicate'

export interface DroppedFinding {
  reason: DropReason
  /** One clause naming what was wrong, safe to print. */
  detail: string
}

export interface MappedFinding {
  path: string
  /** Line number in the head file — a key of the file's `commentable` map. */
  line: number
  /** Always RIGHT in v1: findings anchor to the post-merge state of the file. */
  side: DiffSide
  /** GitHub's legacy diff position, kept for diagnostics and as a posting fallback. */
  position: number
  /** From the rule, not from the model — see `resolveSeverity`. */
  severity: Severity
  /** What the model called it, kept so a disagreement can be logged. */
  modelSeverity: Severity
  ruleId: string
  message: string
  suggestion?: string
  /** True when the anchor is an unchanged context line rather than an added one. */
  onContextLine: boolean
  /** sha1 of path + line + rule id; becomes the idempotency marker in milestone 4. */
  fingerprint: string
}

/**
 * The rule's severity wins over the model's.
 *
 * Two reasons. The config is the repository's contract for what blocks a merge,
 * and a model should not be able to promote its own finding past
 * `min_severity_to_comment` or into a REQUEST CHANGES verdict. And the severity
 * is rendered into the comment body, so a model that labels the same finding
 * `warn` on one run and `error` on the next would make every re-run rewrite a
 * comment that has not actually changed.
 */
function resolveSeverity(rule: Rule): Severity {
  return rule.severity
}

export function fingerprintOf(path: string, line: number, ruleId: string): string {
  return createHash('sha1').update(`${path}:${line}:${ruleId}`).digest('hex')
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`
}

export interface ReviewedFiles {
  /** Reviewed path → its parsed patch. */
  patches: Map<string, ParsedPatch>
  /** Lowercased rule id → rule. */
  rules: Map<string, Rule>
}

export function indexReviewed(files: readonly PlannedFile[], config: ReviewConfig): ReviewedFiles {
  const patches = new Map<string, ParsedPatch>()
  for (const planned of files) patches.set(planned.file.path, parsePatch(planned.patch))

  const rules = new Map<string, Rule>()
  for (const rule of config.rules) rules.set(rule.id.toLowerCase(), rule)

  return { patches, rules }
}

export interface ValidationResult {
  findings: MappedFinding[]
  dropped: DroppedFinding[]
}

/**
 * Validate the tool input and map every surviving finding to a diff anchor.
 *
 * Each finding is checked on its own so one malformed entry cannot discard the
 * rest of the review.
 */
export function validateFindings(input: unknown, reviewed: ReviewedFiles): ValidationResult {
  const findings: MappedFinding[] = []
  const dropped: DroppedFinding[] = []

  const outer = ToolInputSchema.safeParse(input)
  if (!outer.success) {
    return {
      findings,
      dropped: [{ reason: 'malformed', detail: 'the tool call did not contain a findings list' }]
    }
  }

  const seen = new Set<string>()

  for (const candidate of outer.data.findings) {
    const parsed = FindingSchema.safeParse(candidate)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const field = issue?.path.join('.') || 'finding'
      dropped.push({ reason: 'malformed', detail: `${field}: ${issue?.message ?? 'did not match the schema'}` })
      continue
    }
    const raw = parsed.data

    const patch = reviewed.patches.get(raw.path)
    if (!patch) {
      dropped.push({
        reason: 'unknown-path',
        detail: `${raw.path} — not one of the files sent for review`
      })
      continue
    }

    const rule = reviewed.rules.get(raw.rule_id.toLowerCase())
    if (!rule) {
      dropped.push({
        reason: 'unknown-rule',
        detail: `${raw.path}:${raw.line} — rule "${raw.rule_id}" is not defined in the config`
      })
      continue
    }

    const anchor = patch.commentable.get(raw.line)
    if (!anchor || anchor.newLine === null) {
      dropped.push({
        reason: 'unmappable-line',
        detail: `${raw.path}:${raw.line} — line ${raw.line} is not part of the diff, so no comment can anchor to it`
      })
      continue
    }

    const fingerprint = fingerprintOf(raw.path, anchor.newLine, rule.id)
    if (seen.has(fingerprint)) {
      dropped.push({
        reason: 'duplicate',
        detail: `${raw.path}:${raw.line} — already reported under rule "${rule.id}"`
      })
      continue
    }
    seen.add(fingerprint)

    const mapped: MappedFinding = {
      path: raw.path,
      line: anchor.newLine,
      side: 'RIGHT',
      position: anchor.position,
      severity: resolveSeverity(rule),
      modelSeverity: raw.severity,
      ruleId: rule.id,
      message: truncate(raw.message, MAX_MESSAGE_CHARS),
      onContextLine: anchor.kind === 'context',
      fingerprint
    }
    if (raw.suggestion) mapped.suggestion = truncate(raw.suggestion, MAX_SUGGESTION_CHARS)

    findings.push(mapped)
  }

  return { findings, dropped }
}

export type SuppressReason = 'below-min-severity' | 'over-max-comments'

export interface SuppressedFinding {
  finding: MappedFinding
  reason: SuppressReason
}

export interface SelectionResult {
  selected: MappedFinding[]
  suppressed: SuppressedFinding[]
}

/**
 * Most severe first, then by path and line.
 *
 * The severity ordering is what `max_comments` is supposed to mean — a cap that
 * keeps the important findings. The path/line tie-break exists so the same set
 * of findings always survives the cap, otherwise a re-run could post and then
 * un-post the same comment.
 */
function bySeverityThenLocation(a: MappedFinding, b: MappedFinding): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.ruleId.localeCompare(b.ruleId)
  )
}

/** Apply `min_severity_to_comment` and `max_comments`, recording what was held back. */
export function selectFindings(findings: readonly MappedFinding[], config: ReviewConfig): SelectionResult {
  const threshold = severityRank(config.min_severity_to_comment)
  const ordered = [...findings].sort(bySeverityThenLocation)

  const selected: MappedFinding[] = []
  const suppressed: SuppressedFinding[] = []

  for (const finding of ordered) {
    if (severityRank(finding.severity) < threshold) {
      suppressed.push({ finding, reason: 'below-min-severity' })
      continue
    }
    if (selected.length >= config.max_comments) {
      suppressed.push({ finding, reason: 'over-max-comments' })
      continue
    }
    selected.push(finding)
  }

  return { selected, suppressed }
}

export function countBySeverity(findings: readonly MappedFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { nit: 0, warn: 0, error: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}
