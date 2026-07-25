import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const path = fileURLToPath(new URL('../.github/workflows/self-review.yml', import.meta.url))

interface Step {
  name?: string
  uses?: string
  if?: string
  with?: Record<string, string>
}

const workflow = parse(readFileSync(path, 'utf8')) as {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  env?: Record<string, string>
  jobs?: Record<string, { if?: string; steps?: Step[] }>
}

const review = workflow.jobs?.['review']
const steps = review?.steps ?? []

/**
 * The dogfooding workflow ships so that anyone who forks this repository and
 * adds an API key gets a self-review with no edit. On this repository there is
 * no such secret and there is never going to be one, so the workflow must be
 * inert here — and "inert" is a property that is easy to break by accident and
 * expensive to discover, because the way you discover it is a bill.
 *
 * These tests are the guard. They assert the gate exists, that it is written in
 * a form the runner can actually evaluate, and that no step which could reach
 * the Anthropic API escapes it.
 */
describe('self-review.yml is inert without a key', () => {
  it('derives the gate from the secret being non-empty', () => {
    expect(workflow.env?.['HAS_KEY']).toBe("${{ secrets.ANTHROPIC_API_KEY != '' }}")
  })

  it('gates every step that runs the action', () => {
    const actionSteps = steps.filter(step => step.uses?.startsWith('.'))
    expect(actionSteps.length).toBeGreaterThan(0)
    for (const step of actionSteps) {
      expect(step.if, `step "${step.name ?? step.uses}"`).toBe("env.HAS_KEY == 'true'")
    }
  })

  it('passes the key to nothing else', () => {
    // Any other step handed the secret would run unconditionally.
    const consumers = steps.filter(step =>
      Object.values(step.with ?? {}).some(value => value.includes('secrets.ANTHROPIC_API_KEY'))
    )
    expect(consumers.map(step => step.uses)).toEqual(['./'])
  })

  it('does not put the gate on the job, where the runner cannot evaluate it', () => {
    // A job-level `if:` sees only the github, needs, vars and inputs contexts.
    // `secrets.*` or `env.*` there is a workflow load error, not a false gate —
    // but it is a load error nobody sees until a pull request is opened.
    expect(review?.if).toBeUndefined()
  })
})

describe('self-review.yml runs the right code', () => {
  it('uses the checkout, not the released tag', () => {
    // A pull request that breaks the reviewer must be reviewed by the broken
    // code. `hebihime/claude-review-action@v1` here would review every pull
    // request with the last release and hide the regression.
    const uses = steps.map(step => step.uses).filter(Boolean)
    expect(uses).toContain('./')
    expect(uses.some(value => value?.includes('claude-review-action@'))).toBe(false)
  })

  it('triggers on pull_request, never pull_request_target', () => {
    // pull_request_target would hand the API key to code from an untrusted
    // fork branch. The trade is that fork pull requests get no self-review,
    // which is the correct side to err on.
    expect(Object.keys(workflow.on ?? {})).toEqual(['pull_request'])
  })

  it('requests the permissions the action needs and no more', () => {
    expect(workflow.permissions).toEqual({ 'contents': 'read', 'pull-requests': 'write' })
  })
})
