import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InputError, readInputs } from '../src/inputs.js'
import { redact, resetSecretsForTesting } from '../src/redact.js'

// @actions/core reads inputs from INPUT_<NAME> environment variables.
function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.toUpperCase()}`] = value
}

const INPUT_VARS = ['INPUT_ANTHROPIC_API_KEY', 'INPUT_GITHUB_TOKEN', 'INPUT_CONFIG_PATH']

beforeEach(() => {
  for (const name of INPUT_VARS) delete process.env[name]
})

afterEach(() => {
  for (const name of INPUT_VARS) delete process.env[name]
  resetSecretsForTesting()
})

describe('readInputs', () => {
  it('reads all three inputs and trims them', () => {
    setInput('anthropic_api_key', '  sk-ant-testkey0123456789  ')
    setInput('github_token', ' ghp_testtoken0123456789 ')
    setInput('config_path', ' .github/review.yml ')

    const inputs = readInputs()

    expect(inputs.anthropicApiKey).toBe('sk-ant-testkey0123456789')
    expect(inputs.githubToken).toBe('ghp_testtoken0123456789')
    expect(inputs.configPath).toBe('.github/review.yml')
  })

  it('defaults config_path when it is absent', () => {
    setInput('anthropic_api_key', 'sk-ant-testkey0123456789')
    setInput('github_token', 'ghp_testtoken0123456789')

    expect(readInputs().configPath).toBe('.claude-review.yml')
  })

  it('registers both credentials with the redactor', () => {
    setInput('anthropic_api_key', 'sk-ant-testkey0123456789')
    setInput('github_token', 'ghp_testtoken0123456789')

    readInputs()

    const out = redact('key=sk-ant-testkey0123456789 token=ghp_testtoken0123456789')
    expect(out).toBe('key=*** token=***')
  })

  it('accepts a missing API key, leaving the decision to the provider', () => {
    // Only `provider: anthropic` needs a key, and the provider lives in the
    // config file, which has not been read at this point. Demanding one here
    // would make `dry-run` and `fixture` impossible to use without a secret.
    setInput('github_token', 'ghp_testtoken0123456789')

    expect(readInputs().anthropicApiKey).toBe('')
  })

  it('fails when the github token resolves to empty', () => {
    setInput('anthropic_api_key', 'sk-ant-testkey0123456789')
    setInput('github_token', '   ')

    expect(() => readInputs()).toThrow(/github_token/)
  })

  it('rejects a config path that escapes the repository', () => {
    setInput('anthropic_api_key', 'sk-ant-testkey0123456789')
    setInput('github_token', 'ghp_testtoken0123456789')
    setInput('config_path', '../../etc/passwd')

    expect(() => readInputs()).toThrow(/inside the repository/)
  })

  it('rejects an absolute config path', () => {
    setInput('anthropic_api_key', 'sk-ant-testkey0123456789')
    setInput('github_token', 'ghp_testtoken0123456789')
    setInput('config_path', '/etc/passwd')

    expect(() => readInputs()).toThrow(/inside the repository/)
  })
})
