import { parseBuffer, selectCover } from "music-metadata";
import sharp from "sharp";

export type MusicMetadata = {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  coverBytes: Buffer | null;
  coverMime: string | null;
  recognitionStatus: "embedded" | "manual_required";
};

export async function readId3(bytes: Buffer): Promise<MusicMetadata> {
  try {
    const parsed = await parseBuffer(bytes, { mimeType: "audio/mpeg", size: bytes.length });
    const picture = selectCover(parsed.common.picture);
    const cover = picture ? await readCover(Buffer.from(picture.data)) : null;
    const metadata = {
      title: clean(parsed.common.title),
      artist: clean(parsed.common.artist),
      album: clean(parsed.common.album),
      year: parsed.common.year ?? null,
      coverBytes: cover?.bytes ?? null,
      coverMime: cover?.mime ?? null,
    };
    return {
      ...metadata,
      recognitionStatus: metadata.title || metadata.artist || metadata.album || metadata.year || metadata.coverBytes
        ? "embedded"
        : "manual_required",
    };
  } catch {
    return emptyMetadata();
  }
}

export async function isMp3Container(bytes: Buffer): Promise<boolean> {
  let parsed: Awaited<ReturnType<typeof parseBuffer>>;
  try {
    parsed = await parseBuffer(bytes, { mimeType: "audio/mpeg", size: bytes.length });
  } catch {
    return false;
  }
  if (parsed.format.container !== "MPEG" || !parsed.format.hasAudio) return false;
  const start = id3End(bytes);
  let coherentFrames = 0;
  for (let offset = start; offset + 3 < bytes.length; offset += 1) {
    let next = offset;
    let framesAtOffset = 0;
    for (let frameLength = mpegFrameLength(bytes, next); frameLength; frameLength = mpegFrameLength(bytes, next)) {
      framesAtOffset += 1;
      next += frameLength;
    }
    coherentFrames = Math.max(coherentFrames, framesAtOffset);
    if (coherentFrames >= 3) return true;
  }
  return coherentFrames > 0 && Boolean(parsed.format.codecProfile);
}

function emptyMetadata(): MusicMetadata {
  return {
    title: null,
    artist: null,
    album: null,
    year: null,
    coverBytes: null,
    coverMime: null,
    recognitionStatus: "manual_required",
  };
}

function clean(value: string | undefined): string | null {
  const text = value?.trim();
  return text || null;
}

async function readCover(bytes: Buffer): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const metadata = await sharp(bytes).metadata();
    const mime = coverMimeForFormat(metadata.format);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

function coverMimeForFormat(format: string | undefined): string | null {
  const mimes: Record<string, string> = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    png: "image/png",
    tiff: "image/tiff",
    webp: "image/webp",
  };
  return format ? mimes[format] ?? null : null;
}

function id3End(bytes: Buffer): number {
  if (bytes.subarray(0, 3).toString("ascii") !== "ID3" || bytes.length < 10) return 0;
  const sizeBytes = bytes.subarray(6, 10);
  if (sizeBytes.some((value) => value > 0x7f)) return 0;
  const size = (sizeBytes[0] << 21) | (sizeBytes[1] << 14) | (sizeBytes[2] << 7) | sizeBytes[3];
  return Math.min(bytes.length, 10 + size);
}

function mpegFrameLength(bytes: Buffer, offset: number): number | null {
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 0x03;
  const layer = (bytes[offset + 1] >> 1) & 0x03;
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
  const padding = (bytes[offset + 2] >> 1) & 0x01;
  if (version === 0x01 || layer === 0x00 || bitrateIndex === 0x00 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) {
    return null;
  }
  const sampleRate = mpegSampleRate(version, sampleRateIndex);
  const bitrate = mpegBitrate(version, layer, bitrateIndex);
  if (!sampleRate || !bitrate) return null;
  if (layer === 0x03) return (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4;
  return Math.floor((((layer === 0x01 && version !== 0x03) ? 72 : 144) * bitrate * 1000) / sampleRate) + padding;
}

function mpegSampleRate(version: number, index: number): number | null {
  const base = [44_100, 48_000, 32_000][index];
  if (!base) return null;
  return version === 0x03 ? base : version === 0x02 ? base / 2 : base / 4;
}

function mpegBitrate(version: number, layer: number, index: number): number | null {
  const mpeg1 = {
    0x03: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    0x02: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    0x01: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  } as const;
  const mpeg2 = layer === 0x03
    ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  return (version === 0x03 ? mpeg1[layer as keyof typeof mpeg1]?.[index] : mpeg2[index]) ?? null;
}
