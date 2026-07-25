import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { DEFAULT_IGNORE_PATHS, isIgnored, resolveIgnorePatterns } from '../src/filter.js'

const defaults = [...DEFAULT_IGNORE_PATHS]

describe('default ignores', () => {
  it.each([
    'package-lock.json',
    'packages/web/package-lock.json',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'go.sum',
    'dist/index.js',
    'packages/web/dist/bundle.js',
    'node_modules/left-pad/index.js',
    'vendor/github.com/pkg/errors/errors.go',
    'web/static/app.min.js',
    'web/static/app.min.css',
    'dist/index.js.map',
    'test/__snapshots__/app.test.ts.snap',
    'src/api.generated.ts',
    'proto/service_pb2.py',
    'proto/service.pb.go'
  ])('ignores %s', filePath => {
    expect(isIgnored(filePath, defaults)).toBe(true)
  })

  it.each([
    'src/index.ts',
    'README.md',
    '.github/workflows/ci.yml',
    'src/distance.ts',
    'src/vendors.ts',
    'lib/mapper.ts'
  ])('does not ignore %s', filePath => {
    expect(isIgnored(filePath, defaults)).toBe(false)
  })
})

describe('isIgnored', () => {
  it('matches dotfiles and dot-directories, which globs skip by default', () => {
    expect(isIgnored('.config/dist/app.js', defaults)).toBe(true)
    expect(isIgnored('.env.example', ['**/.env*'])).toBe(true)
  })

  it('lets a later negation re-include a path an earlier pattern excluded', () => {
    const patterns = ['docs/**', '!docs/architecture.md']

    expect(isIgnored('docs/notes.md', patterns)).toBe(true)
    expect(isIgnored('docs/architecture.md', patterns)).toBe(false)
  })

  it('lets a later pattern re-exclude what a negation re-included', () => {
    const patterns = ['docs/**', '!docs/**', 'docs/generated/**']

    expect(isIgnored('docs/notes.md', patterns)).toBe(false)
    expect(isIgnored('docs/generated/api.md', patterns)).toBe(true)
  })

  it('ignores nothing when there are no patterns', () => {
    expect(isIgnored('anything.ts', [])).toBe(false)
  })
})

describe('resolveIgnorePatterns', () => {
  it('appends the repo patterns to the built-ins so adding one cannot drop the rest', () => {
    const config = parseConfig('ignore_paths:\n  - "docs/**"\n')

    const patterns = resolveIgnorePatterns(config)

    expect(patterns).toEqual([...DEFAULT_IGNORE_PATHS, 'docs/**'])
    expect(isIgnored('package-lock.json', patterns)).toBe(true)
    expect(isIgnored('docs/notes.md', patterns)).toBe(true)
  })

  it('drops the built-ins when use_default_ignores is false', () => {
    const config = parseConfig('use_default_ignores: false\nignore_paths:\n  - "docs/**"\n')

    const patterns = resolveIgnorePatterns(config)

    expect(patterns).toEqual(['docs/**'])
    expect(isIgnored('package-lock.json', patterns)).toBe(false)
  })

  it('lets a repo un-ignore one built-in path without disabling the rest', () => {
    const config = parseConfig('ignore_paths:\n  - "!dist/loader.js"\n')

    const patterns = resolveIgnorePatterns(config)

    expect(isIgnored('dist/loader.js', patterns)).toBe(false)
    expect(isIgnored('dist/index.js', patterns)).toBe(true)
  })
})
