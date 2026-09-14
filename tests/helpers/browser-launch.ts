// Linux GPU tests use a virtual display on GitHub-hosted runners. Persistent
// profiles must use the same display mode when reopening an entire browser.
export const browserLaunchOptions = {
  headless: process.env.KRKR_TEST_HEADED !== '1',
}
