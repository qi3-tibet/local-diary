import { randomUUID } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const prefix = "local-diary-playwright-";
const temporaryRoot = tmpdir();

for (const name of readdirSync(temporaryRoot)) {
  if (name.startsWith(prefix)) {
    rmSync(path.join(temporaryRoot, name), { recursive: true, force: true });
  }
}

const runId = randomUUID();
const result = spawnSync(
  process.execPath,
  [
    path.join(process.cwd(), "node_modules", "@playwright", "test", "cli.js"),
    "test",
    "apps/web/e2e/core-diary.spec.ts",
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIARY_E2E_RUN_ID: runId,
    },
    stdio: "inherit",
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);

const leftovers = readdirSync(temporaryRoot).filter((name) => name.startsWith(prefix));
if (leftovers.length > 0) {
  throw new Error(`Playwright left temporary roots: ${leftovers.join(", ")}`);
}

async function assertStopped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    await fetch(url, { signal: controller.signal });
    throw new Error(`Playwright left a listener at ${url}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Playwright left")) throw error;
  } finally {
    clearTimeout(timeout);
  }
}

await assertStopped("http://127.0.0.1:4173");
await assertStopped("http://127.0.0.1:4174/api/v1/health");
console.log("Playwright cleanup verified: no temporary roots or loopback listeners.");
