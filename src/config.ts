import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as YAML from 'yaml'
import { z } from 'zod'

// zod registers its English locale as an import side effect. ncc's tree-shaking
// drops that side effect, and every validation message in the bundled action
// degrades to a bare "Invalid input" — which is exactly the opposite of the
// helpful config errors this action promises. Registering it explicitly is
// bundler-proof. Guarded by test/bundle.test.ts, which runs the real bundle.
z.config(z.locales.en())

/** Ordered from least to most severe; the index is the rank. */
export const SEVERITIES = ['nit', 'warn', 'error'] as const
export type Severity = (typeof SEVERITIES)[number]

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

/**
 * Where the review call goes.
 *
 * - `anthropic` — the real Messages API. Requires a funded key.
 * - `dry-run`   — writes the assembled prompt to a file and stops before the call.
 * - `fixture`   — replays a findings JSON through the rest of the pipeline.
 *
 * The last two exist so position mapping, filtering, comment posting, idempotency
 * and the cost readout can be exercised end to end without spending anything.
 */
export const PROVIDERS = ['anthropic', 'dry-run', 'fixture'] as const
export type Provider = (typeof PROVIDERS)[number]

export const DEFAULT_CONFIG_PATH = '.claude-review.yml'

/** Inexpensive current Claude model. `claude-sonnet-5` is the documented upgrade. */
export const DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * Used when the repo has no `rules:` of its own, so the action does something
 * sensible with zero configuration. Every one of these is meant to be overridden.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  {
    id: 'correctness',
    description:
      'Logic that does not do what the surrounding code and names claim: off-by-one errors, inverted conditions, unhandled null or undefined, missing await, resources that are never released.',
    severity: 'error'
  },
  {
    id: 'security',
    description:
      'Untrusted input reaching a sensitive sink (shell, SQL, filesystem path, HTML), credentials in source or logs, and missing authorization checks on a code path that needs one.',
    severity: 'error'
  },
  {
    id: 'error-handling',
    description:
      'Failures that are swallowed, logged and then ignored, or re-thrown without enough context to act on. Empty catch blocks and unchecked error returns count.',
    severity: 'warn'
  },
  {
    id: 'test-coverage',
    description:
      'New branching logic or a bug fix that arrives with no test exercising it. Do not raise this for pure refactors or generated code.',
    severity: 'warn'
  },
  {
    id: 'clarity',
    description:
      'Names, comments, or control flow that will mislead the next reader. Only raise this when you can name a concrete alternative.',
    severity: 'nit'
  }
]

const RuleSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, {
      error:
        'must start with a letter or digit and contain only letters, digits, dots, dashes and underscores (it is embedded in the comment marker)'
    }),
  description: z.string().min(1, { error: 'must not be empty — this text is what the model reviews against' }),
  severity: z.enum(SEVERITIES)
})

export type Rule = z.infer<typeof RuleSchema>

/**
 * Rule ids end up inside the idempotency marker of every posted comment, so two
 * rules sharing an id would make re-runs collide and update the wrong comment.
 */
function checkUniqueRuleIds(rules: readonly Rule[], ctx: z.RefinementCtx): void {
  const firstSeenAt = new Map<string, number>()
  rules.forEach((rule, index) => {
    const key = rule.id.toLowerCase()
    const first = firstSeenAt.get(key)
    if (first === undefined) {
      firstSeenAt.set(key, index)
      return
    }
    ctx.addIssue({
      code: 'custom',
      path: [index, 'id'],
      message: `duplicate rule id "${rule.id}" (already defined at rules[${first}]). Rule ids identify findings across re-runs and must be unique.`
    })
  })
}

export const ConfigSchema = z
  .strictObject({
    rules: z.array(RuleSchema).superRefine(checkUniqueRuleIds).default(DEFAULT_RULES as Rule[]),

    /** Extends the built-in ignores unless `use_default_ignores: false`. */
    ignore_paths: z.array(z.string().min(1)).default([]),
    use_default_ignores: z.boolean().default(true),

    min_severity_to_comment: z.enum(SEVERITIES).default('warn'),
    max_comments: z.number().int().min(1).max(100).default(20),
    token_budget: z.number().int().min(1_000).default(150_000),

    model: z.string().min(1).default(DEFAULT_MODEL),
    provider: z.enum(PROVIDERS).default('anthropic'),
    base_url: z.url({ error: 'must be an absolute URL, e.g. https://gateway.example.com' }).optional(),
    /** Findings JSON replayed when `provider: fixture`. */
    fixture_path: z.string().min(1).optional(),
    /** Where `provider: dry-run` writes the assembled prompt. */
    dry_run_path: z.string().min(1).default('claude-review-prompt.txt'),

    verdict: z
      .strictObject({
        request_changes_on: z.enum(['error', 'warn']).default('error'),
        approve_when_clean: z.boolean().default(true)
      })
      .default({ request_changes_on: 'error', approve_when_clean: true }),

    /**
     * Off by default: a review that fails the check turns an advisory tool into a
     * merge blocker, and a model is not reliable enough to hold that veto without
     * the repo opting in. Documented in the README.
     */
    fail_on_request_changes: z.boolean().default(false)
  })
  .superRefine((config, ctx) => {
    if (config.provider === 'fixture' && !config.fixture_path) {
      ctx.addIssue({
        code: 'custom',
        path: ['fixture_path'],
        message: 'is required when provider is "fixture" — there is nothing to replay without it'
      })
    }
  })

export type ReviewConfig = z.infer<typeof ConfigSchema>

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

const DOCS_HINT =
  'See https://github.com/hebihime/claude-review-action#configuration for the full reference.'

/** `rules[1].severity` rather than zod's raw path array. */
function formatIssuePath(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) return '(root)'
  return segments.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`
  }, '')
}

function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map(issue => `  - ${formatIssuePath(issue.path)}: ${issue.message}`).join('\n')
}

export interface LoadedConfig {
  config: ReviewConfig
  /** Repo-relative path that was read, or `null` when built-in defaults were used. */
  source: string | null
}

export function resolveWorkspace(): string {
  return process.env['GITHUB_WORKSPACE'] ?? process.cwd()
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * Read and validate `.claude-review.yml` from the checked-out workspace.
 *
 * A missing file at the *default* path is normal — the action runs on built-in
 * defaults and says so. A missing file at an *explicitly configured* path is a
 * mistake worth failing on, because the repo asked for a config that is not there.
 */
export function loadConfig(configPath: string, workspace: string = resolveWorkspace()): LoadedConfig {
  const absolute = path.resolve(workspace, configPath)
  const relative = path.relative(workspace, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConfigError(`config_path must stay inside the repository. Got: ${configPath}`)
  }

  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    if (!isNotFound(error)) {
      throw new ConfigError(`Could not read ${configPath}: ${(error as Error).message}`)
    }
    if (configPath !== DEFAULT_CONFIG_PATH) {
      throw new ConfigError(
        `Config file "${configPath}" was not found. It is resolved relative to the repository root, and the repository must be checked out (actions/checkout) before this action runs.`
      )
    }
    return { config: ConfigSchema.parse({}), source: null }
  }

  return { config: parseConfig(text, configPath), source: configPath }
}

/** Exported for tests: everything after the file read. */
export function parseConfig(text: string, configPath = DEFAULT_CONFIG_PATH): ReviewConfig {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (error) {
    throw new ConfigError(`${configPath} is not valid YAML: ${(error as Error).message}`)
  }

  // An empty file (or one that is only comments) parses to null and is treated
  // as "use the defaults", which is what a placeholder config should mean.
  if (raw === null || raw === undefined) raw = {}

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      `${configPath} must contain a YAML mapping of config keys, but parsed to ${Array.isArray(raw) ? 'a list' : typeof raw}. ${DOCS_HINT}`
    )
  }

  const result = ConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigError(`${configPath} is not valid:\n${formatIssues(result.error.issues)}\n${DOCS_HINT}`)
  }
  return result.data
}
