import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const runId = process.env.DIARY_E2E_RUN_ID ?? randomUUID();
const runRoot = process.env.DIARY_E2E_RUN_ROOT
  ?? path.join(tmpdir(), `local-diary-playwright-${runId}`);
const dataRoot = path.join(runRoot, "data");
const outputDir = path.join(runRoot, "artifacts");

process.env.DIARY_E2E_RUN_ID = runId;
process.env.DIARY_E2E_RUN_ROOT = runRoot;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir,
  globalTeardown: "./apps/web/e2e/global-teardown.ts",
  reporter: [
    ["list"],
    ["./apps/web/e2e/cleanup-reporter.ts"],
  ],
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
