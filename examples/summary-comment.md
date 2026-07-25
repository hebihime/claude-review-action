<!-- claude-review:v1:summary -->
## 🛑 Claude review: REQUEST CHANGES

Reviewed 2 file(s): 4 finding(s), 3 commented inline. Changes are requested.

### Findings

| Severity | Commented | Not commented |
|:--|--:|--:|
| Error | 3 | 0 |
| Warning | 0 | 0 |
| Nit | 0 | 1 |

- 1 finding(s) were below `min_severity_to_comment: warn` and were not commented on. They do not affect the verdict.

<details><summary><b>8 file(s) were not reviewed</b></summary>

**No text diff available** (1)

- `assets/logo.png` — no text diff available (binary, or too large for the GitHub API to inline)

**Ignored by pattern** (2)

- `docs/notes.md` — matched an ignore pattern
- `package-lock.json` — matched an ignore pattern

**Token budget exhausted** (5)

- `findings.json` — ~797 estimated tokens, only ~291 of the 2,800-token budget left
- `src/retry.ts` — ~498 estimated tokens, only ~291 of the 2,800-token budget left
- `.claude-review.yml` — ~599 estimated tokens, only ~291 of the 2,800-token budget left
- `.github/workflows/review.yml` — ~667 estimated tokens, only ~291 of the 2,800-token budget left
- `src/parser.ts` — ~351 estimated tokens, only ~291 of the 2,800-token budget left

</details>

### This run

| | |
|:--|:--|
| Model | `claude-haiku-4-5` via provider `fixture` |
| Tokens | not measured — provider `fixture` did not call the API |
| Estimated cost | **$0.00** — no model call was made |
| Prompt budget | ~2,765 of 2,800 estimated tokens — **exhausted** |
| Inline comments | 0 created, 0 updated, 3 unchanged, 0 resolved, 0 revived |
| Workflow run | [logs](https://github.com/hebihime/claude-review-sandbox/actions/runs/30176394011) for `f140dfa` |

<sub>Posted as a comment, not as a formal review: an approval from a bot can satisfy a required-review rule and let a human review be skipped entirely. Costs are estimates from the API's reported token usage.</sub>
