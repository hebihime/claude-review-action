import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { ConfigError, resolveInsideWorkspace, resolveWorkspace, type Provider, type ReviewConfig } from './config.js'
import { FINDINGS_TOOL_NAME, renderPromptForReview, type AssembledPrompt } from './prompt.js'
import { redact } from './redact.js'

/**
 * The provider seam: everything that decides where the review call goes.
 *
 * `anthropic` is the real Messages API. `dry-run` writes the assembled prompt to
 * disk and stops. `fixture` replays a findings JSON as though the model had
 * returned it. The latter two exist so that position mapping, filtering, comment
 * posting, idempotency and the cost readout can all be exercised end to end
 * without an API key and without spending anything.
 *
 * All three return the same shape, so nothing downstream knows which one ran.
 */

/** Cap on the model's reply. Roughly 40 findings with suggestions; far past `max_comments`. */
export const MAX_OUTPUT_TOKENS = 8192

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface ReviewOutcome {
  provider: Provider
  /** The raw tool input. Unvalidated — `validateFindings` is the arbiter. */
  toolInput: unknown
  /** Null when no model was called, so the cost readout can say so rather than print $0.00. */
  usage: ModelUsage | null
  /** True when the reply hit `max_tokens` and the findings list is incomplete. */
  truncated: boolean
  /** One line for the log when the provider did something worth announcing. */
  note?: string
}

/**
 * A model API failure carrying enough context to print as one readable line,
 * mirroring `GitHubApiError`. `index.ts` prints `error.message` and nothing else.
 */
export class ModelApiError extends Error {
  override readonly name = 'ModelApiError'

  constructor(
    readonly status: number | undefined,
    message: string
  ) {
    super(message)
  }
}

function hintFor(status: number | undefined, model: string): string {
  switch (status) {
    case 401:
      return ' The anthropic_api_key input is missing or invalid.'
    case 403:
      return ' The API key is not permitted to use this model or endpoint.'
    case 404:
      return ` No such model as "${model}". Check the "model" key in your review config.`
    case 400:
      return ' The API rejected the request body. If you set base_url, check that the gateway speaks the Messages API.'
    case 429:
      return ' The API rate limit or spending cap was reached. This run made no comments; re-run it once quota is available.'
    case 529:
      return ' The API is temporarily overloaded. Re-running the workflow usually clears it.'
    default:
      return status !== undefined && status >= 500
        ? ' This is an error on the API side; re-running the workflow usually clears it.'
        : ''
  }
}

interface ApiErrorShape {
  status?: number
  message?: string
}

export function toModelApiError(error: unknown, model: string): ModelApiError {
  const err = error as ApiErrorShape
  const status = typeof err?.status === 'number' ? err.status : undefined
  const detail = err?.message ?? String(error)
  const statusText = status === undefined ? '' : ` (HTTP ${status})`
  return new ModelApiError(status, redact(`Model review call failed${statusText}: ${detail}.${hintFor(status, model)}`))
}

/**
 * The one function that talks to the Messages API, injectable for tests.
 *
 * Kept as a bare function type rather than an Anthropic instance so a test can
 * assert the exact request without constructing a client or touching the network.
 */
export type MessagesCreate = (
  params: Anthropic.Messages.MessageCreateParamsNonStreaming
) => Promise<Anthropic.Messages.Message>

function createMessagesCreate(apiKey: string, config: ReviewConfig): MessagesCreate {
  const options: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey,
    // Two beyond the default: a review is a single call whose failure wastes the
    // whole run, and 429/529 are the failures most likely to be transient.
    maxRetries: 4
  }
  if (config.base_url) options.baseURL = config.base_url
  const client = new Anthropic(options)
  return params => client.messages.create(params)
}

export function buildRequest(
  prompt: AssembledPrompt,
  config: ReviewConfig
): Anthropic.Messages.MessageCreateParamsNonStreaming {
  return {
    model: config.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    tools: [prompt.tool as unknown as Anthropic.Messages.Tool],
    // Forcing the tool is what makes the output structured. Without it the model
    // is free to answer in prose, and every parse becomes best-effort.
    tool_choice: { type: 'tool', name: FINDINGS_TOOL_NAME }
  }
}

function readUsage(usage: Anthropic.Messages.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0
  }
}

async function callAnthropic(
  prompt: AssembledPrompt,
  config: ReviewConfig,
  create: MessagesCreate
): Promise<ReviewOutcome> {
  let message: Anthropic.Messages.Message
  try {
    message = await create(buildRequest(prompt, config))
  } catch (error) {
    throw toModelApiError(error, config.model)
  }

  const truncated = message.stop_reason === 'max_tokens'
  const block = message.content.find(
    (candidate): candidate is Anthropic.Messages.ToolUseBlock =>
      candidate.type === 'tool_use' && candidate.name === FINDINGS_TOOL_NAME
  )

  const outcome: ReviewOutcome = {
    provider: 'anthropic',
    toolInput: block?.input ?? { findings: [] },
    usage: readUsage(message.usage),
    truncated
  }
  if (!block) {
    // Forced tool_choice makes this nearly impossible, but a reply truncated
    // before the tool block closed lands here, and silently reporting a clean
    // review would be the worst possible failure mode.
    outcome.note = `The model returned no ${FINDINGS_TOOL_NAME} call (stop reason: ${message.stop_reason ?? 'unknown'}), so this run found nothing to report.`
  }
  return outcome
}

function runDryRun(prompt: AssembledPrompt, config: ReviewConfig, workspace: string): ReviewOutcome {
  const absolute = resolveInsideWorkspace(config.dry_run_path, workspace, 'dry_run_path')
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, renderPromptForReview(prompt, config.model), 'utf8')

  return {
    provider: 'dry-run',
    toolInput: { findings: [] },
    usage: null,
    truncated: false,
    note: `provider is "dry-run": the assembled prompt was written to ${config.dry_run_path} and no model was called.`
  }
}

/**
 * The accepted fixture file shape. `usage` mirrors the API's own field names so a
 * fixture can be pasted straight out of a real response.
 */
interface FixtureShape {
  findings?: unknown
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

function runFixture(config: ReviewConfig, workspace: string): ReviewOutcome {
  // Schema validation guarantees fixture_path is set when provider is "fixture".
  const fixturePath = config.fixture_path as string
  const absolute = resolveInsideWorkspace(fixturePath, workspace, 'fixture_path')

  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    throw new ConfigError(
      `Could not read the findings fixture "${fixturePath}": ${(error as Error).message}. It is resolved relative to the repository root and the repository must be checked out first.`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The findings fixture "${fixturePath}" is not valid JSON: ${(error as Error).message}`)
  }

  // A bare array is accepted alongside the full object so a fixture can be
  // exactly the `findings` value the model would have produced.
  const shape: FixtureShape = Array.isArray(parsed) ? { findings: parsed } : (parsed as FixtureShape)
  const usage = shape.usage

  return {
    provider: 'fixture',
    toolInput: { findings: shape.findings ?? [] },
    // Optional on purpose: a fixture that carries usage exercises the cost
    // readout, one that does not still exercises everything else.
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0
        }
      : null,
    truncated: false,
    note: `provider is "fixture": findings were replayed from ${fixturePath} and no model was called.`
  }
}

export interface ReviewOptions {
  workspace?: string
  /** Test seam; defaults to a real Anthropic client. */
  create?: MessagesCreate
}

/**
 * Obtain findings for this run, by whichever route the config selected.
 *
 * The API key is required only by `anthropic` — demanding one for `dry-run` or
 * `fixture` would defeat the point of having them.
 */
export async function requestReview(
  prompt: AssembledPrompt,
  config: ReviewConfig,
  apiKey: string,
  options: ReviewOptions = {}
): Promise<ReviewOutcome> {
  const workspace = options.workspace ?? resolveWorkspace()

  switch (config.provider) {
    case 'dry-run':
      return runDryRun(prompt, config, workspace)
    case 'fixture':
      return runFixture(config, workspace)
    case 'anthropic': {
      if (!apiKey) {
        throw new ConfigError(
          'Input "anthropic_api_key" is required when provider is "anthropic". Pass it from a repository secret, or set provider to "dry-run" or "fixture" to run without calling the API.'
        )
      }
      return callAnthropic(prompt, config, options.create ?? createMessagesCreate(apiKey, config))
    }
  }
}
