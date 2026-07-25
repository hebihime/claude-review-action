/**
 * Central place for secret redaction.
 *
 * `@actions/core.setSecret` masks values that GitHub's log processor sees, but it
 * does not help with strings we build ourselves (error messages, JSON dumps of a
 * failed request, debug output). Everything user-visible goes through `redact`
 * so a key can never reach the Action log, even indirectly.
 */

const secrets = new Set<string>()

/** Register a value that must never appear in output. Short values are ignored. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return
  const trimmed = value.trim()
  // Anything this short is not a credential and masking it would garble the log.
  if (trimmed.length < 8) return
  secrets.add(trimmed)
}

/** Remove every registered secret from a string, plus anything that looks like an API key. */
export function redact(input: string): string {
  let out = input
  for (const secret of secrets) {
    out = out.split(secret).join('***')
  }
  // Belt and braces: catch key-shaped tokens we were never told about.
  out = out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***')
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
  return out
}

/** Turn an unknown thrown value into a redacted, single-line message. */
export function redactError(error: unknown): string {
  if (error instanceof Error) return redact(error.message)
  if (typeof error === 'string') return redact(error)
  try {
    return redact(JSON.stringify(error))
  } catch {
    return 'unknown error'
  }
}

/** Test-only: clear registered secrets between cases. */
export function resetSecretsForTesting(): void {
  secrets.clear()
}
