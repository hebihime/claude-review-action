<!-- claude-review:v1:000826eb5ce133fd1fd708145013c50106c53b51 -->
<!-- claude-review:resolved -->
**Resolved** — this finding is no longer reported for the latest commit.

<details><summary>Original comment</summary>

**Error** · `correctness`

Changing <= to < makes a rectangle no longer fit inside itself, so fits(r, r) is now false. Exact-fit is the common case for layout and packing code, and this reads as a typo rather than a decision.

</details>
