import { rmSync } from "node:fs";

export default async function globalTeardown(): Promise<void> {
  try {
    await fetch("http://127.0.0.1:4174/__e2e__/shutdown", { method: "POST" });
  } catch {
    // The server may already have stopped after a startup or test failure.
  }

  const runRoot = process.env.DIARY_E2E_RUN_ROOT;
  if (runRoot) rmSync(runRoot, { recursive: true, force: true });
}
