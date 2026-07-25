import { defineConfig, devices } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const runRoot = path.join(tmpdir(), `local-diary-playwright-${process.pid}`);
const dataRoot = path.join(runRoot, "data");
const outputDir = path.join(runRoot, "artifacts");

rmSync(runRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
process.env.DIARY_E2E_RUN_ROOT = runRoot;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir,
  globalTeardown: "./apps/web/e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "pnpm --filter @diary/server start:e2e",
      url: "http://127.0.0.1:4174/api/v1/health",
      env: {
        ...process.env,
        DIARY_DATA_ROOT: dataRoot,
        DIARY_HOST: "127.0.0.1",
        DIARY_PORT: "4174",
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @diary/web exec vite --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      env: {
        ...process.env,
        DIARY_API_ORIGIN: "http://127.0.0.1:4174",
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
