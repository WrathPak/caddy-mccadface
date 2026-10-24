import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 5199)
const CI = !!process.env.CI

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  timeout: CI ? 150_000 : 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // software webgl is cpu heavy: few workers per job, and ci shards across jobs
  workers: CI ? 2 : 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1600, height: 900 },
    trace: CI ? 'retain-on-failure' : 'off',
    screenshot: CI ? 'only-on-failure' : 'off',
    launchOptions: {
      // software WebGL so the 3D viewport works in headless runs
      args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort --host localhost`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
