import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildServer } from "./app.js";
import { createDiaryDatabase } from "./db/client.js";
import { EntryRepository } from "./entries/repository.js";
import { MediaStore } from "./media/store.js";
import { MusicService } from "./music/service.js";

const dataRoot = process.env.DIARY_DATA_ROOT;
if (!dataRoot) throw new Error("DIARY_DATA_ROOT is required for the E2E server.");

const host = process.env.DIARY_HOST ?? "127.0.0.1";
const port = Number(process.env.DIARY_PORT ?? "4174");
const server = buildServer({ dataRoot, scheduleBackups: false });
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  rmSync(dataRoot!, { recursive: true, force: true });
}

server.post("/__e2e__/shutdown", async (_request, reply) => {
  await reply.send({ status: "closing" });
  setImmediate(() => {
    void close().finally(() => process.exit(0));
  });
});

server.post<{ Body: { corrupt?: boolean } }>("/__e2e__/music-fixture", async (request) => {
  const database = createDiaryDatabase(dataRoot);
  const mediaStore = new MediaStore(path.join(dataRoot, "media"));
  const entries = new EntryRepository(database, mediaStore);
  const suffix = request.body?.corrupt ? "corrupt" : crypto.randomUUID();
  try {
    const musicDraft = entries.saveDraft({
      title: `Music ${suffix}`,
      markdown: request.body?.corrupt ? "咖啡比往常更苦" : "The player stays with this entry.",
      tags: [],
    });
    const musicEntry = entries.publishDraft(
      musicDraft.id,
      request.body?.corrupt ? "2026-07-24T10:00:00+08:00" : "2026-07-26T10:00:00+08:00",
    );
    const attached = await new MusicService(database, mediaStore).attach(
      musicEntry.id,
      taggedMp3(request.body?.corrupt ? "Broken Song" : "Pink + White"),
      "fixture.mp3",
    );

    if (request.body?.corrupt) {
      await writeFile(attached.originalPath, Buffer.from("not an MP3"));
    } else {
      const previousDraft = entries.saveDraft({
        title: `Previous ${suffix}`,
        markdown: "The previous day remains in the continuous timeline.",
        tags: [],
      });
      entries.publishDraft(previousDraft.id, "2026-07-25T09:00:00+08:00");
    }

    return {
      entryId: musicEntry.id,
      mediaId: attached.mediaId,
      streamUrl: `/api/v1/music/${attached.mediaId}/stream`,
    };
  } finally {
    database.close();
  }
});

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ host, port });

function taggedMp3(title: string): Buffer {
  const frames = [
    textFrame("TIT2", title),
    textFrame("TPE1", "Frank Ocean"),
    textFrame("TALB", "Blonde"),
  ];
  const tag = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]),
    syncSafe(tag.length),
    tag,
    tinyMp3(),
  ]);
}

function textFrame(id: string, text: string): Buffer {
  const content = Buffer.concat([Buffer.from([3]), Buffer.from(text, "utf8")]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(content.length);
  return Buffer.concat([Buffer.from(id), size, Buffer.from([0, 0]), content]);
}

function syncSafe(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function tinyMp3(): Buffer {
  return Buffer.from(
    "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/4zjAAAAAAAAAAAAASW5mbwAAAA8AAAAAAAAA2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAAAAAAAAAAAAAANgAAPVdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "base64",
  );
}
