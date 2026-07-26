import type { Reporter } from "@playwright/test/reporter";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export default class CleanupReporter implements Reporter {
  printsToStdio(): boolean {
    return false;
  }

  async onExit(): Promise<void> {
    const configuredRoot = process.env.DIARY_E2E_RUN_ROOT;
    if (!configuredRoot) return;

    const runRoot = path.resolve(configuredRoot);
    const temporaryRoot = path.resolve(tmpdir());
    if (
      path.dirname(runRoot) !== temporaryRoot
      || !path.basename(runRoot).startsWith("local-diary-playwright-")
    ) {
      throw new Error(`Refusing to clean unexpected Playwright root: ${runRoot}`);
    }

    rmSync(runRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
