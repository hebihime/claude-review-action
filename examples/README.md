# Example output

Every file in this directory is a byte-for-byte copy of something a real run of this action
produced or consumed, on a GitHub-hosted runner, against a live pull request in
[hebihime/claude-review-sandbox](https://github.com/hebihime/claude-review-sandbox). None of it is
hand-written illustration.

## Read this first: where the findings came from

**No live Anthropic API call has ever been made by this project.** The findings below were not
produced by CI calling the Messages API. They were produced like this:

1. The action ran with `provider: dry-run`, which assembles the complete prompt — system prompt,
   rendered diffs, tool schema — and writes it to a file instead of sending it. That file is
   [`prompt.txt`](prompt.txt), downloaded from the artifact of
   [run 30145200229](https://github.com/hebihime/claude-review-sandbox/actions/runs/30145200229).
2. That prompt was handed to Claude Code, which answered it as the reviewer and returned
   [`findings.json`](findings.json).
3. The action ran again with `provider: fixture`, which replays that JSON through the rest of the
   pipeline exactly as if the API had returned it: position mapping, severity filtering, the
   `max_comments` cap, comment posting, idempotent updates, the verdict, and the cost readout.

So the *review text* is Claude's, produced from the action's own prompt, and everything the action
does *with* a review is genuinely exercised end to end. What is not exercised is the HTTP request in
`src/model.ts` that turns a prompt into findings — that path has unit tests and no live run.

This is the honest version of the spec deliverable "2–3 public example PRs with real reviews". The
pull requests are public and the comments on them are real comments posted by real runs; the model
call in the middle is not. Making it real requires a funded Anthropic API key, which this project
deliberately does not have.

One further caveat: the `usage` block in the sandbox's PR #2 fixture
(`{"input_tokens": 2418, "output_tokens": 511}`) is **representative of a review this size, not
measured**. It exists so the cost readout has realistic numbers to render. Every other number in
these files — token estimates, budget arithmetic, comment counts — is computed by the action itself.

## The files

| File | What it is |
|------|------------|
| [`prompt.txt`](prompt.txt) | The complete assembled prompt for sandbox PR #1, as written by `provider: dry-run`. Model, forced tool, system prompt, every diff with its line-number gutter, and the `report_findings` schema. |
| [`findings.json`](findings.json) | Claude Code's answer to that prompt: four findings against `src/matrix.ts` and `src/slug.ts`. The input to `provider: fixture`. |
| [`inline-comment.md`](inline-comment.md) | The body of [comment 3651109301](https://github.com/hebihime/claude-review-sandbox/pull/1#discussion_r3651109301), posted from the first finding. Note the marker on line 1 and the committable ` ```suggestion ` block. |
| [`inline-comment-resolved.md`](inline-comment-resolved.md) | The body of a comment whose finding the author fixed. The action rewrote it and collapsed it via GraphQL; the original text survives under the fold, and the marker survives so the same comment can be revived if the finding returns. |
| [`summary-comment.md`](summary-comment.md) | The summary from PR #1, whose `token_budget` is deliberately set to 2,800 so the walk runs out. Lists all eight unreviewed files by reason, and reports `$0.00 — no model call was made`. |
| [`summary-comment-with-cost.md`](summary-comment-with-cost.md) | The summary from PR #2, whose fixture carries a `usage` block. Same comment shape, but with `2,418 input · 511 output` and `**$0.0050**`. |

## The two sandbox pull requests

They are deliberately different shapes, because they demonstrate different things.

**[PR #1 — Add a duration parser](https://github.com/hebihime/claude-review-sandbox/pull/1)** is the
skip-reason and budget demonstration. Every file on it is an addition, and its fixtures are chosen so
that each skip reason fires at least once: `package-lock.json` (built-in ignore), `docs/notes.md`
(the repo's own glob), `assets/logo.png` (binary, so no patch), and source files sized against a
2,800-token budget so the walk drops one file and still reviews a smaller one after it.

**[PR #2 — Round area and tighten the fits check](https://github.com/hebihime/claude-review-sandbox/pull/2)**
is the comments and cost demonstration. It *modifies* a file that already exists on `main`, so its
diff contains unchanged context lines — which is what proved that GitHub accepts a review comment
anchored to one. It sets no `token_budget`, so nothing is skipped, and its fixture carries the
`usage` block that drives the cost readout.

## Reproducing this yourself

Without an API key, in any repository:

```yaml
# .claude-review.yml
provider: dry-run
dry_run_path: claude-review-prompt.txt
```

```yaml
# in your workflow, after the review step
- uses: actions/upload-artifact@v4
  with:
    name: claude-review-prompt
    path: claude-review-prompt.txt
```

Open a pull request, download the artifact, and you have the exact bytes the action would have sent.
Switch `provider` to `fixture` with a `fixture_path` and the rest of the pipeline runs for real.
