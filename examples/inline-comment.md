<!-- claude-review:v1:8a645e8b225824820fd894b26ba947c42f689c3d -->
**Error** · `correctness`

scale is the only operation here that does not call assertRectangular, so a ragged input passes straight through and returns a ragged result. That value then satisfies the Matrix type and reaches add or multiply, where the failure surfaces far from its cause.

```suggestion
export function scale(matrix: Matrix, factor: number): number[][] {
  assertRectangular(matrix, 'matrix')
```
