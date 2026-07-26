export default async function globalTeardown(): Promise<void> {
  try {
    await fetch("http://127.0.0.1:4174/__e2e__/shutdown", { method: "POST" });
  } catch {
    // The server may already have stopped after a startup or test failure.
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch("http://127.0.0.1:4174/api/v1/health");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
}
