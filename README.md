# claude-review-action

[![CI](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml/badge.svg)](https://github.com/hebihime/claude-review-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Opinionated, configurable AI code review on every pull request — with idempotent comments and a cost readout.

> **Status: milestone 1 of 6 (scaffold).** The action currently validates its inputs, resolves the
> pull request, honours the `skip-review` label, and makes one authenticated GitHub call to prove the
> token is wired correctly. It does **not** review code yet. The sections below describe what exists
> today; the full config reference, idempotency, and cost-control docs land with the features.

## Build order

| # | Milestone | State |
|---|-----------|-------|
| 1 | Scaffold, `action.yml`, ncc build, hello-world run | ✅ done |
| 2 | Config loading + validation, diff fetching, ignore/budget logic | ⬜ next |
| 3 | Model review call, structured findings, diff→position mapping | ⬜ |
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
