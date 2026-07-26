import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(desktopRoot, "release");
const outputPath = path.join(releaseRoot, "checksums.sha256");

export function releaseArtifactNames(names) {
  return names
    .filter((name) => (
      /^Local-Diary-Setup-[\w.-]+\.exe$/i.test(name)
      || /^Local-Diary-Setup-[\w.-]+\.exe\.blockmap$/i.test(name)
    ))
    .sort((left, right) => left.localeCompare(right));
}

export async function writeReleaseChecksums() {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const artifacts = releaseArtifactNames(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  if (artifacts.length === 0) throw new Error(`No release artifacts found in ${releaseRoot}`);
  const lines = [];
  for (const name of artifacts) {
    const checksum = createHash("sha256")
      .update(await readFile(path.join(releaseRoot, name)))
      .digest("hex");
    lines.push(`${checksum}  ${name}`);
  }
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`${outputPath}\n${lines.join("\n")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeReleaseChecksums();
}
