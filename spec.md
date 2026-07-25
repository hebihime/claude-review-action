# Project 4 — claude-review-action: AI Code Review as a GitHub Action

**Tagline:** Opinionated, configurable AI code review on every PR — with idempotent comments and a cost readout.
**Hiring signal:** CI/CD integration, config-driven design, the production details everyone gets wrong

---

## 1. Scope

**In scope (v1):**
- Triggers on `pull_request` opened/synchronize
- Reads `.claude-review.yml` from the target repo
- Reviews the diff, posts inline comments + one summary comment with verdict
- Idempotent re-runs (updates its own comments, never duplicates)
- Token budget + per-run cost in the summary

**Out of scope:** auto-fix commits, multi-model consensus, GitHub App distribution (Action only).

## 2. Behavior spec

- **Config (`.claude-review.yml`):** rules (list of natural-language review rules with severity `error|warn|nit`), `ignore_paths` (globs), `min_severity_to_comment`, `max_comments`, `token_budget`, `model`, `verdict_threshold` (e.g. any `error` → request changes)
- **Chunking:** per-file diffs; files over N lines summarized-then-reviewed; skip lockfiles/generated files by default
- **Verdict:** `approve` / `comment` / `request_changes` derived from findings vs config — posted as the summary comment header (the Action comments; it does not submit a formal blocking review in v1 — document why)
- **Idempotency:** every comment carries a hidden HTML marker (`<!-- claude-review:<file>:<line-hash> -->`); on re-run, update matching comments, resolve ones no longer applicable, add new ones
- **Cost controls:** hard token budget per run; if exceeded, review highest-risk files first (by churn) and say so in the summary; `skip-review` label bypasses entirely
- **Auth/model:** Messages API with `ANTHROPIC_API_KEY` from repo secrets (CI = API key path; note in README that subscription auth is for local dev only)

## 3. Stack

- TypeScript GitHub Action (bundled with `@vercel/ncc`), `@actions/core`, `@actions/github` (Octokit), `@anthropic-ai/sdk`, zod for config validation, Vitest
- Structured output via tool-use: findings as `{path, line, severity, rule, message, suggestion?}`

## 4. The differentiator — dogfooding

Enable it on the other three project repos. Every PR you open gets reviewed by your own Action, visibly, in public. Link 2–3 example reviewed PRs from the README.

## 5. Deliverables / definition of done

- [ ] Action repo with `action.yml`, tagged release (`v1`)
- [ ] Installed and running on your other project repos
- [ ] 2–3 public example PRs with reviews linked in README
- [ ] README: quickstart workflow YAML, full config reference, cost-control explanation, idempotency explanation

---

## Kickoff prompt (paste into Claude Code in an empty repo)

```
You are building "claude-review-action", a TypeScript GitHub Action that
performs configurable AI code review on pull requests using the Anthropic
Messages API. Read this entire prompt before writing code.

GOAL
Marketplace-quality Action: config-driven rules, inline comments, a summary
verdict, idempotent re-runs, and explicit cost controls. Production details
matter more than cleverness.

STACK
TypeScript strict, @actions/core, @actions/github (Octokit),
@anthropic-ai/sdk, zod, bundle with @vercel/ncc into dist/ (committed),
Vitest with mocked Octokit + mocked Anthropic client.

INPUTS (action.yml)
anthropic_api_key (required), config_path (default .claude-review.yml),
github_token (default ${{ github.token }}).

CONFIG SCHEMA (.claude-review.yml, zod-validated with helpful errors)
rules: [{ id, description, severity: error|warn|nit }]
ignore_paths: [globs]  (defaults: lockfiles, dist/**, *.min.*, generated)
min_severity_to_comment: nit|warn|error (default warn)
max_comments: number (default 20)
token_budget: number (default 150000)
model: string (default an inexpensive current Claude model)
verdict: { request_changes_on: error|warn, approve_when_clean: boolean }
Ship a documented example config in the repo root.

PIPELINE
1. Load PR context; exit cleanly (neutral log, success status) if the
   skip-review label is present.
2. Fetch changed files + patches via Octokit; apply ignore globs.
3. Order files by churn (adds+deletes desc). Walk the list accumulating
   estimated tokens; stop when budget would be exceeded and record which
   files were skipped.
4. Review per file (or small batches): send the patch + the config rules,
   force structured output via tool-use:
   findings: [{ path, line, severity, rule_id, message, suggestion? }].
   Lines must map to positions that are actually commentable in the diff —
   validate against the patch hunks, drop findings that don't map, count
   the drops.
5. Filter by min_severity, cap at max_comments (highest severity first).
6. Post inline review comments. Idempotency: embed
   <!-- claude-review:v1:<sha1 of path+line+rule_id> --> in each comment.
   On rerun: list existing bot comments, update changed ones, minimize/mark
   resolved ones whose finding disappeared, create only genuinely new ones.
7. Summary comment (same idempotent update pattern, fixed marker):
   verdict header (APPROVE / COMMENT / REQUEST CHANGES per config),
   findings table by severity, files skipped (budget/ignored), token usage
   and computed USD cost, model used, run link.
8. Set the Action's exit code: fail the check only when verdict is
   request_changes AND config.fail_on_request_changes is true (add that
   config key, default false). Document the reasoning.

QUALITY BAR
- Every Octokit call wrapped with clear error context; API failures must
  produce a readable Action log line, not a stack trace.
- No secrets ever logged. Redact the key from any debug output.
- Unit tests: config validation, diff→position mapping, idempotency marker
  matching, budget ordering. Use fixture patches.
- README: 60-second quickstart (workflow YAML block), config reference
  table, "How idempotency works" section, "Cost controls" section, badge
  row, placeholder links for example reviewed PRs.
- Provide .github/workflows/self-review.yml so this repo reviews its own
  PRs (dogfooding).

BUILD ORDER
1. Scaffold + action.yml + ncc build + a hello-world run I can test in a
   sandbox repo.
2. Config loading/validation + diff fetching + ignore/budget logic with
   tests.
3. Model review call + structured findings + position mapping.
4. Inline comments + idempotent update logic.
5. Summary comment + verdict + cost readout.
6. Tests green, README, tag v1.
Pause after each milestone and tell me exactly how to test it in a sandbox
repo before continuing.
```
