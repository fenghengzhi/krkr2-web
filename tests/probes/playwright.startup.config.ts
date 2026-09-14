import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'
import shared from '../../playwright.config.ts'

export default defineConfig({
  ...shared,
  testDir: '.',
  testMatch: 'startup-diagnostic.spec.ts',
  outputDir: resolve('test-results-webkit-diagnostic'),
  projects: shared.projects!.filter((project) => project.name === 'webkit'),
  reporter: [['list'], ['json', { outputFile: resolve('out/ci/webkit-diagnostic.json') }]],
})
