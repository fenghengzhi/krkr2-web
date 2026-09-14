import { defineConfig } from '@playwright/test'
import browserConfig from './playwright.config.ts'

// Disk-profile tests own complete browser processes. Run separately from the
// shared ephemeral-browser suite, retaining the same concurrency and deadlines.
export default defineConfig({
  ...browserConfig,
  testDir: './tests/library-browser',
  outputDir: './test-results/library',
  // The shared WebKit project retains DOM/network traces without screencasts.
})
