import { afterEach, describe, expect, it } from 'vitest'
import { redact, redactError, registerSecret, resetSecretsForTesting } from '../src/redact.js'

afterEach(() => {
  resetSecretsForTesting()
})

describe('redact', () => {
  it('removes a registered secret wherever it appears', () => {
    registerSecret('sk-ant-supersecretvalue')
    const out = redact('request failed with key sk-ant-supersecretvalue (twice: sk-ant-supersecretvalue)')
    expect(out).not.toContain('supersecretvalue')
    expect(out).toBe('request failed with key *** (twice: ***)')
  })

  it('redacts anthropic-shaped keys that were never registered', () => {
    const out = redact('Authorization: Bearer sk-ant-api03-AbCdEf0123456789')
    expect(out).toBe('Authorization: Bearer sk-ant-***')
  })

  it('redacts github-shaped tokens that were never registered', () => {
    const out = redact('remote: token ghp_0123456789abcdefghijABCDEFGHIJ rejected')
    expect(out).toBe('remote: token gh*_*** rejected')
  })

  it('ignores short values so ordinary log text is not garbled', () => {
    registerSecret('abc')
    expect(redact('abc is not a secret')).toBe('abc is not a secret')
  })

  it('ignores empty and nullish registrations', () => {
    registerSecret('')
    registerSecret(undefined)
    registerSecret(null)
    expect(redact('nothing to mask')).toBe('nothing to mask')
  })
})

describe('redactError', () => {
  it('redacts the message of an Error', () => {
    registerSecret('sk-ant-abcdefghijklmnop')
    const out = redactError(new Error('bad key sk-ant-abcdefghijklmnop'))
    expect(out).toBe('bad key ***')
  })

  it('handles a thrown string', () => {
    registerSecret('ghp_0123456789abcdefghij')
    expect(redactError('token ghp_0123456789abcdefghij leaked')).toBe('token *** leaked')
  })

  it('handles a thrown non-Error object', () => {
    expect(redactError({ status: 500 })).toBe('{"status":500}')
  })

  it('does not leak a stack trace', () => {
    const error = new Error('boom')
    expect(redactError(error)).toBe('boom')
  })
})
