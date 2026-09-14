import { defineConfig } from '@playwright/test'
import browserConfig from './playwright.config.ts'

// Disk-profile tests own complete browser processes. Run separately from the
// shared ephemeral-browser suite, retaining the same concurrency and deadlines.
export default defineConfig({
  ...browserConfig,
  testDir: './tests/library-browser',
  outputDir: './test-results/library',
  // WebKit's continuous trace screencast adds ~200 ms to protocol calls with
  // two persistent pages. Keep DOM/network traces and failure screenshots.
  projects: browserConfig.projects!.map((project) => ({
    ...project,
    ...(project.name === 'webkit'
      ? {
          use: {
            ...project.use,
            trace: {
              mode: 'retain-on-failure' as const,
              screenshots: false,
              snapshots: true,
              sources: true,
            },
          },
        }
      : {}),
  })),
})
