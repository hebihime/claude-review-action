import { minimatch } from 'minimatch'
import type { ReviewConfig } from './config.js'

/**
 * Files that are almost never worth spending review tokens on: dependency
 * lockfiles, build output, vendored code, minified or generated artefacts.
 *
 * A repo's own `ignore_paths` are appended to these rather than replacing them,
 * so adding one glob cannot silently re-enable review of a 12,000-line lockfile.
 * Set `use_default_ignores: false` to start from an empty list instead.
 */
export const DEFAULT_IGNORE_PATHS: readonly string[] = [
  // Lockfiles
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/go.sum',
  // Build output and vendored dependencies
  '**/dist/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/.next/**',
  // Minified, mapped, generated
  '**/*.min.*',
  '**/*.map',
  '**/*.snap',
  '**/*.generated.*',
  '**/*_pb2.py',
  '**/*.pb.go'
]

export function resolveIgnorePatterns(config: ReviewConfig): string[] {
  const base = config.use_default_ignores ? DEFAULT_IGNORE_PATHS : []
  return [...base, ...config.ignore_paths]
}

/**
 * gitignore-style matching: patterns are evaluated in order and the last one to
 * match wins, so a leading `!` re-includes a path an earlier pattern excluded.
 * That is the only way to say "ignore dist/** except dist/loader.js".
 *
 * `dot: true` because a repo's dotfiles and dot-directories are real source.
 */
export function isIgnored(filePath: string, patterns: readonly string[]): boolean {
  let ignored = false
  for (const raw of patterns) {
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    if (pattern === '') continue
    if (minimatch(filePath, pattern, { dot: true })) ignored = !negated
  }
  return ignored
}
