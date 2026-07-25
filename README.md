# claude-review-action

[![CI](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml/badge.svg)](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Opinionated, configurable AI code review on every pull request — with idempotent comments and a cost readout.

> **Status: milestone 2 of 6.** The action validates its inputs, resolves the pull request, honours
> the `skip-review` label, loads and validates `.claude-review.yml`, fetches the diff, and decides
> which files it would review under the token budget — logging every file it skipped and why. It does
> **not** call the model or post comments yet. The idempotency and cost-readout docs land with those
> features.

## Build order

| # | Milestone | State |
|---|-----------|-------|
| 1 | Scaffold, `action.yml`, ncc build, hello-world run | ✅ done |
| 2 | Config loading + validation, diff fetching, ignore/budget logic | ✅ done |
| 3 | Model review call, structured findings, diff→position mapping | ⬜ next |
| 4 | Inline comments + idempotent update logic | ⬜ |
| 5 | Summary comment, verdict, cost readout | ⬜ |
| 6 | Tests green, full README, tag `v1` | ⬜ |

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `anthropic_api_key` | yes | — | Anthropic API key. Pass from a repository secret. |
| `config_path` | no | `.claude-review.yml` | Review config file, relative to the repo root. |
| `github_token` | no | `${{ github.token }}` | Token used for all GitHub API calls. |

## Outputs

| Output | Description |
|--------|-------------|
| `verdict` | `approve`, `comment`, or `request_changes`. |
| `findings_count` | Findings that survived filtering and were posted. |
| `cost_usd` | Estimated USD cost of the model calls in this run. |
| `skipped` | `true` when the run exited early (not a PR, or `skip-review` label present). |

## Quickstart (current behaviour)

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

`pull-requests: write` is not needed yet (nothing is posted) but is included so the permission block
does not have to change when milestone 4 lands.

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

### Providers

`provider` decides where the review call goes. `anthropic` is the real Messages API and the default.
The other two exist so the whole downstream pipeline — position mapping, severity filtering, comment
posting, idempotent updates, the summary, and the cost math — can be exercised without spending
anything: `dry-run` writes the assembled prompt to `dry_run_path` and stops, and `fixture` replays a
findings JSON from `fixture_path` as if the model had returned it.

## Skipping a review

Add the `skip-review` label to a pull request. The action logs a notice and exits successfully — the
check goes green rather than being skipped, so required-check configuration keeps working. The label
is honoured before any API call, so a skipped PR costs nothing.

## Verified against real infrastructure

Milestone 1 is exercised on GitHub-hosted runners from
[hebihime/claude-review-sandbox](https://github.com/hebihime/claude-review-sandbox), which runs the
tagged action on a live pull request in three configurations:

| Scenario | Result |
|----------|--------|
| Normal PR | Prints the PR context and changed-file counts, sets all four outputs |
| `skip-review` label | Notice, `skipped=true`, exit 0, zero API calls |
| Deliberately invalid `github_token` | `Failed to fetch pull request #1 (HTTP 401): Bad credentials. The github_token is missing or invalid.` — one line, no stack trace |

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
