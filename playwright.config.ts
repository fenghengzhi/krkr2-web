import { defineConfig, devices } from '@playwright/test'
import { browserLaunchOptions } from './tests/helpers/browser-launch.ts'
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 12_000 },
  workers: 2,
  use: {
    ...browserLaunchOptions,
    baseURL: 'http://127.0.0.1:5175',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
  },
})
