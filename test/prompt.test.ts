import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/config.js'
import type { PullRequestContext } from '../src/context.js'
import { parsePatch } from '../src/patch.js'
import type { PlannedFile } from '../src/plan.js'
import {
  assemblePrompt,
  buildSystemPrompt,
  buildUserPrompt,
  FINDINGS_TOOL,
  FINDINGS_TOOL_NAME,
  renderPromptForReview
} from '../src/prompt.js'

const pr: PullRequestContext = {
  owner: 'octo',
  repo: 'demo',
  number: 7,
  title: 'Add a thing',
  headSha: 'abc1234def',
  baseRef: 'main',
  labels: [],
  draft: false,
  htmlUrl: 'https://github.com/octo/demo/pull/7',
  runUrl: 'https://github.com/octo/demo/actions/runs/1'
}

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n return a'

function planned(path: string): PlannedFile {
  return {
    file: { path, status: 'modified', additions: 1, deletions: 0, churn: 1, patch: PATCH },
    patch: PATCH,
    estimatedTokens: 100
  }
}

const config = ConfigSchema.parse({})

describe('buildSystemPrompt', () => {
  it('includes every configured rule with its id and severity', () => {
    const system = buildSystemPrompt(config)

    for (const rule of config.rules) {
      expect(system).toContain(`- ${rule.id} (${rule.severity}):`)
      expect(system).toContain(rule.description)
    }
  })

  it('contains only the configured rules, so a custom config replaces the defaults', () => {
    const custom = ConfigSchema.parse({
      rules: [{ id: 'only-rule', description: 'The one thing to check.', severity: 'warn' }]
    })
    const system = buildSystemPrompt(custom)

    // Match the rendered rule line, not the bare word: the standing instructions
    // legitimately use words like "correctness" in prose.
    expect(system).toContain('- only-rule (warn): The one thing to check.')
    expect(system).not.toMatch(/^- correctness \(/m)
    expect(system.match(/^- \S+ \(/gm)).toHaveLength(1)
  })

  it('names the tool the model is forced to call', () => {
    expect(buildSystemPrompt(config)).toContain(FINDINGS_TOOL_NAME)
  })

  it('tells the model that an empty findings list is a valid outcome', () => {
    // Without this a model reliably invents a finding to look useful.
    expect(buildSystemPrompt(config)).toMatch(/empty findings list is a normal/i)
  })
})

describe('buildUserPrompt', () => {
  it('heads each file with the exact path the model must echo back', () => {
    expect(buildUserPrompt(pr, [planned('src/a.ts')])).toContain('### src/a.ts')
  })

  it('renders the patch with the same gutter numbers the parser accepts', () => {
    const user = buildUserPrompt(pr, [planned('src/a.ts')])

    for (const line of parsePatch(PATCH).commentable.keys()) {
      expect(user).toMatch(new RegExp(`^\\s*${line} \\|`, 'm'))
    }
  })

  it('carries the pull request context the reviewer needs for framing', () => {
    const user = buildUserPrompt(pr, [planned('src/a.ts')])

    expect(user).toContain('#7 in octo/demo: Add a thing')
    expect(user).toContain('Merging into: main')
  })

  it('includes every planned file', () => {
    const user = buildUserPrompt(pr, [planned('src/a.ts'), planned('src/b.ts')])

    expect(user).toContain('### src/a.ts')
    expect(user).toContain('### src/b.ts')
    expect(user).toContain('2 file(s) follow')
  })
})

describe('FINDINGS_TOOL', () => {
  it('requires everything the posting step needs, and leaves suggestion optional', () => {
    const item = (FINDINGS_TOOL.input_schema.properties['findings'] as { items: { required: string[] } }).items

    expect(item.required).toEqual(['path', 'line', 'severity', 'rule_id', 'message'])
    expect(item.required).not.toContain('suggestion')
  })

  it('constrains severity to the configured vocabulary', () => {
    const properties = (
      FINDINGS_TOOL.input_schema.properties['findings'] as {
        items: { properties: { severity: { enum: string[] } } }
      }
    ).items.properties

    expect(properties.severity.enum).toEqual(['nit', 'warn', 'error'])
  })
})

describe('renderPromptForReview', () => {
  it('writes everything a human needs to judge the prompt without running it', () => {
    const rendered = renderPromptForReview(assemblePrompt(pr, config, [planned('src/a.ts')]), 'claude-haiku-4-5')

    expect(rendered).toContain('claude-haiku-4-5')
    expect(rendered).toContain('## System prompt')
    expect(rendered).toContain('## User message')
    expect(rendered).toContain('## Tool schema')
    expect(rendered).toContain('### src/a.ts')
  })
})
