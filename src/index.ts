import * as core from '@actions/core'
import { run } from './run.js'
import { redactError } from './redact.js'

// Entry point. Kept separate from run.ts so tests can import the pipeline
// without triggering a run on import.
try {
  await run()
} catch (error: unknown) {
  core.setFailed(redactError(error))
}
