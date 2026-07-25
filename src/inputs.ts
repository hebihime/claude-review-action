import * as core from '@actions/core'
import { registerSecret } from './redact.js'

export interface ActionInputs {
  anthropicApiKey: string
  configPath: string
  githubToken: string
}

export class InputError extends Error {
  override readonly name = 'InputError'
}

/**
 * Read and validate the action inputs.
 *
 * Both credentials are registered with `core.setSecret` (masks them in the
 * GitHub log) and with our own redactor (masks them in strings we build).
 */
export function readInputs(): ActionInputs {
  const anthropicApiKey = core.getInput('anthropic_api_key').trim()
  const githubToken = core.getInput('github_token').trim()
  const configPath = (core.getInput('config_path').trim() || '.claude-review.yml').trim()

  if (anthropicApiKey) {
    core.setSecret(anthropicApiKey)
    registerSecret(anthropicApiKey)
  }
  if (githubToken) {
    core.setSecret(githubToken)
    registerSecret(githubToken)
  }

  if (!anthropicApiKey) {
    throw new InputError(
      'Input "anthropic_api_key" is required. Pass it from a repository secret, e.g. anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}'
    )
  }
  if (!githubToken) {
    throw new InputError(
      'Input "github_token" resolved to an empty string. Leave it unset to use ${{ github.token }}, or pass a token explicitly.'
    )
  }
  if (configPath.startsWith('/') || configPath.split(/[\\/]/).includes('..')) {
    throw new InputError(
      `Input "config_path" must be a path inside the repository. Got: ${configPath}`
    )
  }

  return { anthropicApiKey, configPath, githubToken }
}
