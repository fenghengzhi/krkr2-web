import { defineConfig } from '@playwright/test'
import shared from './playwright.config.ts'
export default defineConfig({
  ...shared,
  testDir: './tests/activity-native-browser',
  projects: [{ name: 'chromium-native' }],
  outputDir: 'test-results-native-activity',
  reporter: [['list'], ['json', { outputFile: 'out/verification/activity/native-check.json' }]],
})
