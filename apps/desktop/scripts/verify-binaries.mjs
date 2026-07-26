import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(desktopRoot, "assets", "binaries.json");
const sourcePath = path.join(desktopRoot, "assets", "fpcalc.exe");

export async function verifyBundledBinaries(options = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const source = await verifyFpcalc(sourcePath, manifest.fpcalc);
  const report = { fpcalc: source };
  if (options.packagedPath) {
    report.packagedFpcalc = await verifyFpcalc(path.resolve(options.packagedPath), manifest.fpcalc);
  }
  return report;
}

async function verifyFpcalc(executable, expected) {
  const bytes = await readFile(executable);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const { stdout, stderr } = await execute(executable, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const version = `${stdout}${stderr}`.trim();
  if (checksum !== expected.sha256) {
    throw new Error(`fpcalc checksum mismatch at ${executable}`);
  }
  if (version !== expected.versionOutput || !version.startsWith(`fpcalc version ${expected.version}`)) {
    throw new Error(`fpcalc version mismatch at ${executable}: ${version}`);
  }
  return {
    path: executable,
    present: true,
    checksum,
    checksumMatch: true,
    version,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyBundledBinaries({ packagedPath: option("--packaged") });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
