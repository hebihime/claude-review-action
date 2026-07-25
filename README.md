# claude-review-action

[![CI](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml/badge.svg)](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Opinionated, configurable AI code review on every pull request — with idempotent comments and a cost readout.

> **Status: milestone 5 of 6.** The review is feature-complete: the action loads and validates
> `.claude-review.yml`, fetches the diff, decides what fits the token budget, asks the model for
> findings through a forced tool call, maps each finding onto a line a comment can actually anchor
> to, posts them as inline review comments that update in place on every re-run, and closes with a
> single summary comment carrying the verdict, what was skipped, and what the run cost. Milestone 6
> is documentation, dogfooding and the tagged release.

## Build order

| # | Milestone | State |
|---|-----------|-------|
| 1 | Scaffold, `action.yml`, ncc build, hello-world run | ✅ done |
| 2 | Config loading + validation, diff fetching, ignore/budget logic | ✅ done |
| 3 | Model review call, structured findings, diff→position mapping | ✅ done |
| 4 | Inline comments + idempotent update logic | ✅ done |
| 5 | Summary comment, verdict, cost readout | ✅ done |
| 6 | Tests green, full README, tag `v1` | ⬜ next |

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic_api_key` | only for `provider: anthropic` | — | Anthropic API key. Pass from a repository secret. Not needed for `dry-run` or `fixture`. |
| `config_path` | no | `.claude-review.yml` | Review config file, relative to the repo root. |
| `github_token` | no | `${{ github.token }}` | Token used for all GitHub API calls. |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `approve`, `comment`, or `request_changes`. |
| `findings_count` | Findings that survived filtering and were posted. |
| `cost_usd` | Estimated USD cost of this run, to four decimals. `0.00` when no model call was made; **empty** when the configured model has no published price on file — an unpriced run is not a free one. |
| `skipped` | `true` when the run exited early (not a PR, or `skip-review` label present). |

## Quickstart

```yaml
name: Claude Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hebihime/claude-review-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

`pull-requests: write` is required — without it the action can read the diff but every comment fails
with a 403. `contents: read` is what `actions/checkout` needs.

**Pull requests from forks** get a read-only `GITHUB_TOKEN` regardless of this block, so the action
can review them but cannot comment. That is a GitHub security boundary, not something this action can
work around: use `pull_request_target` (and understand what you are accepting) or accept that fork PRs
produce log output only.

## Configuration

Create `.claude-review.yml` in your repository root. **Every key is optional** — with no config file
at all the action runs on the defaults below. A fully commented example lives at
[`.claude-review.yml`](.claude-review.yml) in this repo; it is asserted by the test suite to match
the built-in defaults exactly, so copying it is a safe starting point.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `rules` | list of `{id, description, severity}` | 5 built-in rules | What the reviewer looks for. `severity` is `nit`, `warn`, or `error`. Ids must be unique. |
| `ignore_paths` | list of globs | `[]` | Paths to skip, **added to** the built-in ignores. |
| `use_default_ignores` | boolean | `true` | Set `false` to drop the built-in ignores entirely. |
| `min_severity_to_comment` | `nit`\|`warn`\|`error` | `warn` | Findings below this are dropped. |
| `max_comments` | integer 1–100 | `20` | Hard cap on inline comments per run. |
| `token_budget` | integer ≥ 1000 | `150000` | Pre-flight token ceiling for one run. |
| `model` | string | `claude-haiku-4-5` | Any Claude model id. `claude-sonnet-5` is the upgrade for deeper review. |
| `provider` | `anthropic`\|`dry-run`\|`fixture` | `anthropic` | Where the review call goes — see below. |
| `base_url` | URL | — | Gateway, Bedrock, or Vertex endpoint. |
| `verdict.request_changes_on` | `error`\|`warn` | `error` | Severity that turns the verdict into REQUEST CHANGES. |
| `verdict.approve_when_clean` | boolean | `true` | Post APPROVE rather than COMMENT when nothing was found. |
| `fail_on_request_changes` | boolean | `false` | Whether a REQUEST CHANGES verdict fails the check run. |

Validation is strict: an unknown key is an error rather than a silent no-op, because
`ignore_path:` instead of `ignore_paths:` would otherwise look like it worked. Every problem in the
file is reported in one message, each line naming the exact path (`rules[2].severity: …`).

### Ignore patterns

Repo patterns are **appended to** the built-in list rather than replacing it, so adding one glob
cannot accidentally re-enable review of a 12,000-line lockfile. Built-in ignores cover lockfiles
(npm, yarn, pnpm, bun, Cargo, poetry, Pipenv, Composer, Bundler, Go), `dist/`, `node_modules/`,
`vendor/`, `.next/`, and `*.min.*`, `*.map`, `*.snap`, `*.generated.*` and protobuf output.

Patterns are evaluated in order and **the last match wins**, so a leading `!` re-includes something
an earlier pattern excluded — including a built-in:

```yaml
ignore_paths:
  - "!dist/loader.js"   # review this one file even though dist/** is ignored by default
  - "docs/**"
  - "!docs/architecture.md"
```

### Cost controls

Four independent limits, in the order they apply:

1. **The `skip-review` label** bypasses the run before any API call.
2. **Ignore globs** drop files that are never worth review tokens.
3. **`token_budget`** caps one run. Files are ordered by churn (additions + deletions, descending,
   ties broken by path so re-runs on the same commit produce the same plan) and selected until the
   budget is spent. A file that does not fit is *skipped and reported*, and the walk continues — so
   a small file after a large one still gets reviewed. Nothing is ever silently truncated.
4. **`max_comments`** caps what gets posted, highest severity first.

The pre-flight budget uses a character-based token estimate (3.5 chars/token) rather than a
tokenizer: bundling one would add megabytes to the action, and calling the token-counting endpoint
would cost a network round trip per run. It is tuned to over-estimate, because the only job of this
number is to stop a run from overshooting. The **cost readout in the summary comment uses the usage
the API actually reports**, never this estimate.

#### What the cost readout will and will not tell you

Prices come from a table in [`src/pricing.ts`](src/pricing.ts) — Anthropic list prices, checked
`2026-07`, with cache reads billed at 0.1× the input rate and cache writes at 1.25×. Bedrock, Vertex
and dated model ids resolve to the same entry, so `anthropic.claude-sonnet-5-v1:0` prices correctly.

**A model that is not in that table produces no dollar figure at all.** The summary prints the exact
token counts and says there is no published price on file, and `cost_usd` comes back empty rather
than `0.00`. This action can be pinned at `v1` for a year and `model:` can point at anything a
gateway accepts; a confident number derived from a guessed rate would be worse than no number,
because a spend guard would happily pass a run it could not price. Promotional rates are deliberately
not encoded — they expire, and a stale discount under-reports the bill.

Costs are estimates of API list price. They are not your invoice, and they do not include whatever
your provider charges on top.

## How the review works

One model call per run, not one per file. The system prompt carries your rules; the user message
carries every file that fit the budget, each diff rendered with a line-number gutter:

```
### src/total.js
@@ -1,4 +1,6 @@
     1 | export function total(items) {
       |-  return items.count
     2 |+  let sum = 0
     3 |+  for (let i = 0; i <= items.length; i++) sum += items[i]
     4 |+  return sum
     5 | }
```

Structured output is **forced through tool use** rather than requested in prose: `tool_choice` is
pinned to a `report_findings` tool whose schema is `{path, line, severity, rule_id, message,
suggestion?}`. The model cannot answer with an apology or a markdown table.

### Findings that don't map are dropped, not guessed

A review comment can only attach to a line GitHub considers part of the diff. Every finding is
checked against the parsed patch hunks and dropped if it fails, with the reason logged and counted:

| Drop reason | Meaning |
|-------------|---------|
| `unmappable-line` | Cited a line that is not in the diff. Logged as a warning — it usually means a prompt problem, and it must not look like a clean review. |
| `unknown-path` | Cited a file that was not sent for review. |
| `unknown-rule` | Cited a rule id that is not in your config. |
| `duplicate` | Same file, line and rule as a finding already kept. |
| `malformed` | Did not match the tool schema. Dropped individually, so one bad entry cannot discard the rest. |

The line-number gutter above exists precisely to make `unmappable-line` rare: without it the model
has to count lines from the hunk header, and every off-by-one becomes a dropped finding.

Two deliberate choices worth knowing:

- **The rule's severity wins over the model's.** Your config decides what blocks a merge, so the
  model cannot promote a finding past `min_severity_to_comment` or into a REQUEST CHANGES verdict.
  It also keeps re-runs stable — a model that labelled the same finding `warn` then `error` would
  rewrite a comment that had not actually changed.
- **Unchanged context lines are commentable.** A finding often needs to point at the line a change
  broke, not at the change itself.

## How idempotency works

A pull request is re-reviewed on every push. A reviewer that re-posts the same three comments each
time is worse than no reviewer at all, so every comment carries a hidden marker:

```html
<!-- claude-review:v1:9f2c1a…  -->   ← sha1 of "path:line:rule_id"
```

The marker is the comment's identity. On every run the action lists the review comments on the PR,
keeps the ones carrying a marker, and reconciles them against this run's findings:

| Situation | What happens |
|-----------|--------------|
| Marker present, body identical | **Nothing.** No API call at all. |
| Marker present, body differs | Edited in place. Same comment, same thread, same replies. |
| Marker absent from the PR | Created. |
| Marker on the PR, no matching finding | Marked resolved and collapsed. |
| Marker resolved, finding came back | Revived — the same comment is restored, not a second one. |
| Two comments share a marker | The older one wins; the extras are collapsed as outdated. |

A steady-state re-run therefore logs `0 created, 0 updated, 3 unchanged, 0 resolved, 0 revived` and
makes exactly one API call.

Details that matter:

- **The marker is the identity, not the author.** The action may post as `github-actions[bot]` in one
  repo and as a PAT's user in another; a repo can switch between them without orphaning every comment
  it has already made.
- **Resolved comments are rewritten, not deleted.** The original text is folded into a `<details>`
  block and the comment is collapsed via GraphQL. A comment may already have replies, and deleting it
  to tidy up would destroy conversation the author cared about. If the collapse call is unavailable —
  older GitHub Enterprise, a restricted token — the run says so and carries on; the rewritten body is
  what actually carries the meaning.
- **Only files that were reviewed this run can have their comments resolved.** A file dropped by the
  token budget produces no findings, but that is not evidence its findings were fixed. Resolving it
  would un-resolve on the next run with budget to spare, and comments would flap on every push.
- **`provider: dry-run` never touches comments.** Its empty findings list means "we did not look",
  not "we looked and found nothing".
- **The marker includes the line number**, per the spec. A finding that slides to a different line is
  a different fingerprint: the old comment resolves and a new one is created. That is deliberate —
  the alternative is a comment whose anchor and whose marker disagree.
- **A rejected comment does not lose the review.** GitHub answers 422 when one comment cannot be
  anchored; that comment is reported and the rest are posted normally. Any other status (401, 403,
  5xx) will fail identically for every comment, so it is raised once rather than `max_comments` times.

## The summary comment

Every run ends with exactly one comment on the pull request describing the run itself:

```markdown
<!-- claude-review:v1:summary -->
## 🛑 Claude review: REQUEST CHANGES

Reviewed 1 file(s): 3 finding(s), 2 commented inline. Changes are requested.

### Findings

| Severity | Commented | Not commented |
|:--|--:|--:|
| Error | 1 | 0 |
| Warning | 1 | 0 |
| Nit | 0 | 1 |

- 1 finding(s) were below `min_severity_to_comment: warn` and were not commented on. They do not affect the verdict.
- 1 finding(s) cited a line that is not part of the diff and could not be anchored to a comment. They were discarded.

<details><summary><b>2 file(s) were not reviewed</b></summary>

**Ignored by pattern** (1)

- `package-lock.json` — matched an ignore pattern

**No text diff available** (1)

- `assets/logo.png` — no text diff available (binary, or too large for the GitHub API to inline)

</details>

### This run

| | |
|:--|:--|
| Model | `claude-haiku-4-5` via provider `anthropic` |
| Tokens | 3,128 input · 604 output |
| Estimated cost | **$0.0061** at list prices as of 2026-07 |
| Prompt budget | ~1,664 of 150,000 estimated tokens |
| Inline comments | 2 created, 0 updated, 0 unchanged, 1 resolved, 0 revived |
| Workflow run | [logs](…) for `abcdef1` |
```

Design notes:

- **It is an issue comment, not a review comment.** It is about the pull request as a whole and has
  no line to anchor to, so it belongs in the conversation timeline where the author will see it.
- **The verdict is a header, not a GitHub review event.** The action never submits an approval. A bot
  approval can satisfy a required-review rule and let a human review be skipped entirely, which is a
  worse outcome than any review this action could produce. `fail_on_request_changes: true` is the
  opt-in for making the verdict actually block a merge, via the check run rather than the review.
- **Its idempotency rule is the mirror image of the inline comments'.** An inline comment body must be
  a pure function of its finding, so a re-run rewrites nothing. The summary deliberately carries what
  changed about the *run* — token counts, cost, the link to this workflow run — so a re-run is
  expected to rewrite it. A fixed marker (`claude-review:v1:summary`, not a fingerprint) is what
  guarantees there is never a second one.
- **Nothing is silently dropped.** Findings held back by `min_severity_to_comment` are counted and the
  key is named; findings held back by `max_comments` are counted and the comment says plainly that
  they still count towards the verdict; findings the model cited on a line that is not in the diff are
  counted as discarded. Files that were never reviewed are listed by reason. A summary that only said
  "1 finding" would read as a clean review of the whole pull request.
- **Two runs racing to post the first summary converge.** Two pushes in quick succession start two
  workflow runs, and both can list the comments before either creates one. The *oldest* live summary
  wins every time — never the newest, or the survivor would change on every run — and the duplicate is
  folded away and collapsed rather than deleted, because it may already have replies.

## Providers

`provider` decides where the review call goes. `anthropic` is the real Messages API and the default.
The other two exist so the whole downstream pipeline — position mapping, severity filtering, comment
posting, idempotent updates, the summary, and the cost math — can be exercised without spending
anything, and **neither requires an API key**:

- `dry-run` writes the fully assembled prompt to `dry_run_path` and stops before the call. The file
  is a readable artefact: system prompt, user message, and tool schema, exactly as they would be
  sent. Upload it with `actions/upload-artifact` to inspect what a run would have cost.
- `fixture` replays a findings JSON from `fixture_path` as if the model had returned it. The file is
  either a bare array of findings or `{"findings": [...], "usage": {...}}`; the optional `usage`
  block lets the cost readout be exercised with realistic numbers.

```yaml
# .claude-review.yml — review the pipeline, spend nothing
provider: fixture
fixture_path: test/fixtures/findings.json
```

## Skipping a review

Add the `skip-review` label to a pull request. The action logs a notice and exits successfully — the
check goes green rather than being skipped, so required-check configuration keeps working. The label
is honoured before any API call, so a skipped PR costs nothing.

## Verified against real infrastructure

Every milestone is exercised on GitHub-hosted runners from
[hebihime/claude-review-sandbox](https://github.com/hebihime/claude-review-sandbox), which runs the
tagged action on live pull requests. Handling:

| Scenario | Result |
|----------|--------|
| Normal PR | Prints the PR context and changed-file counts, sets all four outputs |
| `skip-review` label | Notice, `skipped=true`, exit 0, zero API calls |
| Deliberately invalid `github_token` | `Failed to fetch pull request #1 (HTTP 401): Bad credentials. The github_token is missing or invalid.` — one line, no stack trace |

Idempotency, on [PR #2](https://github.com/hebihime/claude-review-sandbox/pull/2), each row a real run
against the same comments:

| Run | Log line | What GitHub showed |
|-----|----------|--------------------|
| First | `2 created, 0 updated, 0 unchanged, 0 resolved, 0 revived` | Two inline comments with committable suggestions |
| Identical re-run | `0 created, 0 updated, 2 unchanged, 0 resolved, 0 revived` | `updated_at` still equal to `created_at` — not one byte rewritten |
| Author fixes one bug | `0 created, 0 updated, 1 unchanged, 1 resolved, 0 revived` | That comment collapsed, `minimizedReason: resolved`, original text intact under the fold |
| Finding returns | `0 created, 1 updated, 0 unchanged, 0 resolved, 1 revived` | The **same** comment id un-collapsed — no duplicate |

The summary comment, on both sandbox PRs:

| Check | Result |
|-------|--------|
| First run | One timeline comment created with the verdict header, the severity table and the run table |
| Second run, same state | `Summary: unchanged` — GitHub reported `updated_at` still equal to `created_at` |
| Never more than one | Both PRs carry exactly one comment matching the summary marker, across every run |
| Cost readout | `2,418 input · 511 output` → **$0.0050**, and `cost_usd=0.0050` in a downstream workflow step |
| No model call | `$0.00 — no model call was made`, `cost_usd=0.00` |
| Unpriced model | `unknown — no published price on file for some-gateway/llm-v3`, and `cost_usd=` — **empty, not zero** |
| Budget exhaustion | The five files the budget dropped listed by name with the tokens each needed, and `~2,765 of 2,800 estimated tokens — exhausted` |

**Comments on unchanged context lines are accepted by GitHub.** That was an open question when the
mapping was written. PR #2 answers it: a comment anchored to ` export function area(rect: Rect): number {`
— a context line, note the leading space in its diff hunk — was created with `side: RIGHT`, `line: 6`
and no 422.

Local `npm test` cannot catch metadata errors, because nothing parses `action.yml` locally. A
`secrets.*` expression in an input description made the action fail to load on the runner before any
code ran; `test/action-yml.test.ts` now asserts that `action.yml` uses only contexts available at
metadata-parse time.

## Local development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # ncc -> dist/ (committed; CI fails if it is stale)
npm run all         # all three, in order
```

`dist/` is committed on purpose: GitHub runs `dist/index.js` directly and never installs
dependencies. CI fails a PR that changes `src/` without rebuilding.

## Security

- The API key and the GitHub token are registered with `core.setSecret` **and** with an internal
  redactor, so they are stripped from any message the action prints — including GitHub API error
  text. See `src/redact.ts` and its tests.
- Every GitHub API call is wrapped so failures print one readable line with a permission hint,
  not an Octokit stack trace. See `src/github.ts`.

## License

MIT
