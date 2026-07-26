export type FpcalcManifest = {
  version: string;
  platform: string;
  architecture: string;
  sourceUrl: string;
  archiveSha256: string;
  sizeBytes: number;
  sha256: string;
  versionOutput: string;
};

export type BinaryRunner = (
  executable: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export function verifyFpcalc(
  executable: string,
  expected: FpcalcManifest,
  runner?: BinaryRunner,
): Promise<Record<string, unknown>>;
