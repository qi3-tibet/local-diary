import { execFile } from "node:child_process";
import path from "node:path";
import type { FingerprintLookup, RecognitionCandidate } from "./types.js";

const ACOUSTID_ENDPOINT = "https://api.acoustid.org/v2/lookup";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const MAX_STDOUT_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ExecFileOptions = {
  encoding: "utf8";
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
};
export type ExecFileResult = { stdout: string; stderr: string };
export type ExecFileRunner = (
  executable: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

export type FingerprintLookupOptions = {
  clientKey?: string;
  executable?: string;
  execute?: ExecFileRunner;
  request?: Fetch;
  timeoutMs?: number;
};

export async function runFpcalc(
  filePath: string,
  executable = resolveFpcalcExecutable(),
  execute: ExecFileRunner = executeFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ duration: number; fingerprint: string }> {
  if (!path.win32.isAbsolute(filePath) && !path.posix.isAbsolute(filePath)) {
    throw new Error("Fingerprint input path must be absolute");
  }
  const result = await execute(executable, ["-json", "--", filePath], {
    encoding: "utf8",
    maxBuffer: MAX_STDOUT_BYTES,
    shell: false,
    timeout: positiveTimeout(timeoutMs),
    windowsHide: true,
  });
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed)) throw new Error("Invalid fpcalc output");
  const duration = Number(parsed.duration);
  const fingerprint = parsed.fingerprint;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60) {
    throw new Error("Invalid fpcalc duration");
  }
  if (
    typeof fingerprint !== "string"
    || fingerprint.length === 0
    || fingerprint.length > MAX_STDOUT_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(fingerprint)
  ) {
    throw new Error("Invalid fpcalc fingerprint");
  }
  return { duration, fingerprint };
}

export function createAcoustIdFingerprintLookup(
  options: FingerprintLookupOptions = {},
): FingerprintLookup {
  const clientKey = options.clientKey?.trim() ?? process.env.ACOUSTID_CLIENT_KEY?.trim() ?? "";
  const execute = options.execute ?? executeFile;
  const request = options.request ?? fetch;
  const executable = options.executable ?? resolveFpcalcExecutable();
  const timeoutMs = positiveTimeout(options.timeoutMs);

  return {
    async search(filePath) {
      if (!clientKey) return [];
      try {
        const calculated = await runFpcalc(filePath, executable, execute, timeoutMs);
        const body = new URLSearchParams({
          client: clientKey,
          duration: String(Math.round(calculated.duration)),
          fingerprint: calculated.fingerprint,
          format: "json",
          meta: "recordings releasegroups",
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await request(ACOUSTID_ENDPOINT, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) return [];
          return parseAcoustIdResponse(await response.json());
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return [];
      }
    },
  };
}

function parseAcoustIdResponse(payload: unknown): RecognitionCandidate[] {
  if (!isRecord(payload) || payload.status !== "ok" || !Array.isArray(payload.results)) return [];
  const byId = new Map<string, RecognitionCandidate>();
  for (const result of payload.results) {
    if (!isRecord(result) || !Array.isArray(result.recordings)) continue;
    const score = Number(result.score);
    if (!Number.isFinite(score)) continue;
    for (const recording of result.recordings) {
      if (!isRecord(recording) || typeof recording.id !== "string" || !UUID.test(recording.id)) continue;
      const artist = firstRecord(recording.artists);
      const releaseGroup = firstRecord(recording.releasegroups);
      const candidate: RecognitionCandidate = {
        id: `acoustid:${recording.id}`,
        title: nullableText(recording.title),
        artist: artist ? nullableText(artist.name) : null,
        album: releaseGroup ? nullableText(releaseGroup.title) : null,
        year: null,
        coverMediaId: null,
        coverReleaseId: null,
        score: Math.max(0, Math.min(1, score)),
        source: "fingerprint",
      };
      const previous = byId.get(candidate.id);
      if (!previous || candidate.score > previous.score) byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MAX_RESULTS);
}

function resolveFpcalcExecutable(): string {
  const configured = process.env.FPCALC_PATH?.trim();
  if (configured) return configured;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    return path.join(resourcesPath, "fpcalc", process.platform === "win32" ? "fpcalc.exe" : "fpcalc");
  }
  return process.platform === "win32" ? "fpcalc.exe" : "fpcalc";
}

function executeFile(
  executable: string,
  args: string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, 500) : null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(value!, 30_000) : DEFAULT_TIMEOUT_MS;
}
