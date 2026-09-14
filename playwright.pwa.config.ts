import { defineConfig } from '@playwright/test'
import config from './playwright.library.config.ts'
export default defineConfig({
  ...config,
  testDir: './tests/pwa-browser',
  outputDir: './test-results/pwa',
  // The bundled WebKit network emulator prevents even a synthetic SW response.
  // All three engines run the real server-shutdown and cold-start scenarios.
  projects: config.projects!.map((project) => ({
    ...project,
    ...(project.name === 'webkit' ? { testIgnore: '**/emulation.spec.ts' } : {}),
  })),
})
