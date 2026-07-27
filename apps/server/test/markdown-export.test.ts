import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import yauzl from "yauzl";
import { fromMarkdown } from "mdast-util-from-markdown";
import { buildServer } from "../src/app.js";
import { createDiaryDatabase, type DiaryDatabase } from "../src/db/client.js";
import {
  exportMarkdownArchive,
  type MarkdownExportSelection,
} from "../src/export/markdown.js";
import { MediaStore } from "../src/media/store.js";

type Fixture = {
  database: DiaryDatabase;
  dataRoot: string;
  store: MediaStore;
};

describe("portable Markdown export", () => {
  const roots: string[] = [];
  const databases: DiaryDatabase[] = [];
  const servers: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    databases.splice(0).forEach((database) => {
      try { database.close(); } catch {}
    });
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("round-trips quoted Chinese metadata, rewrites only parsed inline images, and includes exact original media", async () => {
    const fixture = createFixture();
    const imageBytes = Buffer.from("original-image");
    const mp3Bytes = Buffer.from("ID3-original-mp3");
    const coverBytes = Buffer.from("original-cover");
    const overrideCoverBytes = Buffer.from("override-cover");
    const image = await fixture.store.put(imageBytes, "png");
    const mp3 = await fixture.store.put(mp3Bytes, "mp3");
    const cover = await fixture.store.put(coverBytes, "jpg");
    const overrideCover = await fixture.store.put(overrideCoverBytes, "png");
    const entryId = seedEntry(fixture.database, {
      title: '雨后的街道: "A/B"',
      markdown: [
        "第一张 ![rain](media:image-one)",
        "",
        "```md",
        "![not-an-image](media:image-one)",
        "```",
        "",
        "普通链接 [keep](media:image-one)，纯文本 media:image-one",
        "",
        "第二张 ![again](media:image-one)",
        "",
        '相同文字 ![media:image-one](media:image-one "media:image-one")',
      ].join("\n"),
      publishedAt: "2026-07-26T22:18:00+08:00",
      updatedAt: "2026-07-27T01:02:03.000Z",
      tags: ["夜晚", "a: b"],
    });
    insertMedia(fixture.database, entryId, "image-one", image.hash, "image/png", "png");
    insertMedia(fixture.database, entryId, "music-one", mp3.hash, "audio/mpeg", "mp3");
    insertMedia(fixture.database, entryId, "cover-one", cover.hash, "image/jpeg", "jpg");
    insertMedia(fixture.database, entryId, "cover-two", overrideCover.hash, "image/png", "png");
    fixture.database.prepare(`
      INSERT INTO entry_music (
        entry_id, media_id, title, artist, album, year, cover_media_id,
        recognition_status, user_overrides_json, original_filename, recognition_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entryId,
      "music-one",
      "Base title",
      "Frank Ocean",
      "Blonde",
      2016,
      "cover-one",
      "recognized",
      JSON.stringify({
        title: "Pink + White",
        album: 'Blonde: "Deluxe"',
        coverMediaId: "cover-two",
      }),
      "Pink & White.mp3",
      "text",
    );
    const archive = await exportFixture(fixture, { entryId });
    const entries = await readZip(archive);
    const markdownName = [...entries.keys()].find((name) => name.endsWith(".md"))!;
    const markdown = entries.get(markdownName)!.toString("utf8");
    const { attributes, body } = parseFrontMatter(markdown);

    expect(markdownName).toMatch(/^2026-07-26\/2218-/u);
    expect(attributes).toMatchObject({
      id: entryId,
      title: '雨后的街道: "A/B"',
      published_at: "2026-07-26T22:18:00+08:00",
      updated_at: "2026-07-27T01:02:03.000Z",
      tags: ["a: b", "夜晚"],
      song_title: "Pink + White",
      song_artist: "Frank Ocean",
      song_album: 'Blonde: "Deluxe"',
      song_year: 2016,
      music_recognition_status: "recognized",
      music_recognition_source: "text",
      music_original_filename: "Pink & White.mp3",
    });
    const imagePath = `media/${image.hash}.png`;
    const imageReference = `../${imagePath}`;
    expect(body.match(new RegExp(`!\\[[^\\]]+\\]\\(${escapeRegExp(imageReference)}`, "g"))).toHaveLength(3);
    expect(body).toContain(`![media:image-one](${imageReference} "media:image-one")`);
    expect(body).toContain("```md\n![not-an-image](media:image-one)\n```");
    expect(body).toContain("[keep](media:image-one)");
    expect(body).toContain("纯文本 media:image-one");
    expect(attributes.music_file).toBe(`../media/${mp3.hash}.mp3`);
    expect(attributes.music_cover).toBe(`../media/${overrideCover.hash}.png`);
    expect([...entries.keys()].filter((name) => name === imagePath)).toHaveLength(1);
    expect(entries.get(imagePath)).toEqual(imageBytes);
    expect(entries.get((attributes.music_file as string).slice(3))).toEqual(mp3Bytes);
    expect(entries.get((attributes.music_cover as string).slice(3))).toEqual(overrideCoverBytes);
    expect(entries.has(`media/${cover.hash}.jpg`)).toBe(false);
    expect(markdown).not.toMatch(/[A-Z]:\\/);
    expect([...entries.keys()].every(isSafeArchiveName)).toBe(true);
  });

  it("uses deterministic collision-safe names for Unicode and Windows-reserved titles", async () => {
    const fixture = createFixture();
    seedEntry(fixture.database, {
      title: "CON",
      markdown: "first",
      publishedAt: "2026-07-26T22:18:00+08:00",
    });
    seedEntry(fixture.database, {
      title: "CON",
      markdown: "second",
      publishedAt: "2026-07-26T22:18:00+08:00",
    });
    seedEntry(fixture.database, {
      title: "<>:\"/\\|?* . ",
      markdown: "third",
      publishedAt: "2026-07-26T22:19:00+08:00",
    });
    const first = await exportFixture(fixture, { from: "2026-07-26", to: "2026-07-26" });
    const second = await exportFixture(fixture, { from: "2026-07-26", to: "2026-07-26" });
    const names = [...(await readZip(first)).keys()].filter((name) => name.endsWith(".md"));

    expect(await readFile(first)).toEqual(await readFile(second));
    expect(names).toEqual([
      "2026-07-26/2218-_con.md",
      "2026-07-26/2218-_con-2.md",
      "2026-07-26/2219-entry.md",
    ]);
    expect(names.every(isSafeArchiveName)).toBe(true);
  });

  it("rewrites media definitions used by full, collapsed, and shortcut image references only", async () => {
    const fixture = createFixture();
    const sources = [
      ["full-image", Buffer.from("full image"), "png"],
      ["collapsed-image", Buffer.from("collapsed image"), "jpg"],
      ["shortcut-image", Buffer.from("shortcut image"), "webp"],
      ["mixed-image", Buffer.from("mixed image"), "gif"],
    ] as const;
    const entryId = seedEntry(fixture.database, {
      title: "Reference images",
      markdown: [
        "Full ![full][ALBUM   COVER]",
        "Collapsed ![collapsed][]",
        "Shortcut ![shortcut]",
        "Shared ![shared][mixed] and ![shared again][MIXED]",
        "Ordinary shared link [site][mixed]",
        "Link only [docs][link only]",
        "",
        "```md",
        "[code photo]: media:full-image",
        "```",
        "",
        "[album cover]: media:full-image \"Full title\"",
        "[collapsed]: media:collapsed-image",
        "[shortcut]: media:shortcut-image",
        "[mixed]: media:mixed-image",
        "[link only]: media:link-only",
        "[unused]: media:unused-image",
      ].join("\n"),
      publishedAt: "2026-07-26T09:15:00+08:00",
    });
    for (const [id, bytes, extension] of sources) {
      const stored = await fixture.store.put(bytes, extension);
      insertMedia(
        fixture.database,
        entryId,
        id,
        stored.hash,
        extension === "jpg" ? "image/jpeg" : `image/${extension}`,
        extension,
      );
    }

    const entries = await readZip(await exportFixture(fixture, { entryId }));
    const markdown = [...entries.entries()].find(([name]) => name.endsWith(".md"))![1].toString("utf8");
    const { body } = parseFrontMatter(markdown);
    const objects = new Map(sources.map(([id, bytes, extension]) => [
      id,
      {
        bytes,
        path: `../media/${createHash("sha256").update(bytes).digest("hex")}.${extension}`,
      },
    ]));

    expect(body).toContain(`[album cover]: ${objects.get("full-image")!.path} "Full title"`);
    expect(body).toContain(`[collapsed]: ${objects.get("collapsed-image")!.path}`);
    expect(body).toContain(`[shortcut]: ${objects.get("shortcut-image")!.path}`);
    expect(body).toContain(`[mixed]: ${objects.get("mixed-image")!.path}`);
    expect(body).toContain("Ordinary shared link [site][mixed]");
    expect(body).toContain("[link only]: media:link-only");
    expect(body).toContain("[unused]: media:unused-image");
    expect(body).toContain("```md\n[code photo]: media:full-image\n```");
    expect([...entries.keys()].filter((name) => name.startsWith("media/"))).toHaveLength(4);
    for (const { bytes, path } of objects.values()) {
      expect(entries.get(path.slice(3))).toEqual(bytes);
    }

    const tree = fromMarkdown(body) as {
      children: Array<{ type: string; identifier?: string; url?: string }>;
    };
    const definitions = new Map(
      tree.children
        .filter((node) => node.type === "definition")
        .map((node) => [node.identifier, node.url]),
    );
    expect(definitions.get("album cover")).toBe(objects.get("full-image")!.path);
    expect(definitions.get("mixed")).toBe(objects.get("mixed-image")!.path);
  });

  it("selects one published entry or an inclusive Beijing date range and excludes drafts and trash", async () => {
    const fixture = createFixture();
    const before = seedEntry(fixture.database, { title: "Before", markdown: "before", publishedAt: "2026-07-24T23:59:00+08:00" });
    const first = seedEntry(fixture.database, { title: "First", markdown: "first", publishedAt: "2026-07-25T00:00:00+08:00" });
    const last = seedEntry(fixture.database, { title: "Last", markdown: "last", publishedAt: "2026-07-26T23:59:00+08:00" });
    seedEntry(fixture.database, { title: "After", markdown: "after", publishedAt: "2026-07-27T00:00:00+08:00" });
    seedEntry(fixture.database, { title: "Trashed", markdown: "trashed", publishedAt: "2026-07-26T10:00:00+08:00", state: "trashed" });
    seedEntry(fixture.database, { title: "Draft", markdown: "draft", publishedAt: null, state: "draft" });

    const ranged = await readZip(await exportFixture(fixture, { from: "2026-07-25", to: "2026-07-26" }));
    const rangeBodies = [...ranged.entries()].filter(([name]) => name.endsWith(".md")).map(([, bytes]) => bytes.toString("utf8"));
    expect(rangeBodies).toHaveLength(2);
    expect(rangeBodies.join("\n")).toContain(first);
    expect(rangeBodies.join("\n")).toContain(last);
    expect(rangeBodies.join("\n")).not.toContain(before);

    const single = await readZip(await exportFixture(fixture, { entryId: first }));
    expect([...single.keys()].filter((name) => name.endsWith(".md"))).toHaveLength(1);
    let unknownEntryId = randomUUID();
    while ([before, first, last].includes(unknownEntryId)) unknownEntryId = randomUUID();
    await expect(exportFixture(fixture, { entryId: unknownEntryId })).rejects.toThrow("EXPORT_ENTRY_NOT_FOUND");
  });

  it("fails without publishing a partial archive when referenced media is missing or corrupt", async () => {
    const fixture = createFixture();
    const entryId = seedEntry(fixture.database, {
      title: "Broken",
      markdown: "![missing][photo]\n\n[photo]: media:missing-image",
      publishedAt: "2026-07-26T12:00:00+08:00",
    });
    const expectedHash = createHash("sha256").update("expected").digest("hex");
    insertMedia(fixture.database, entryId, "missing-image", expectedHash, "image/png", "png");
    const missingTarget = join(tempRoot("markdown-missing-output-"), "export.zip");

    await expect(exportMarkdownArchive(
      { entryId },
      { database: fixture.database, mediaStore: fixture.store },
      missingTarget,
    )).rejects.toThrow("EXPORT_MEDIA_MISSING");
    await expect(readFile(missingTarget)).rejects.toMatchObject({ code: "ENOENT" });

    const objectPath = fixture.store.pathFor(expectedHash, "png");
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "corrupt");
    await expect(exportMarkdownArchive(
      { entryId },
      { database: fixture.database, mediaStore: fixture.store },
      missingTarget,
    )).rejects.toThrow("EXPORT_MEDIA_CORRUPT");
    await expect(readFile(missingTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports a date-only legacy entry without inventing a time in its filename or metadata", async () => {
    const fixture = createFixture();
    const entryId = seedEntry(fixture.database, {
      title: "旧记录",
      markdown: "只记得这一天。",
      publishedAt: "2026-06-05",
    });

    const entries = await readZip(await exportFixture(fixture, { entryId }));
    const markdownName = [...entries.keys()].find((name) => name.endsWith(".md"))!;
    const { attributes } = parseFrontMatter(entries.get(markdownName)!.toString("utf8"));

    expect(markdownName).toBe("2026-06-05/旧记录.md");
    expect(attributes.published_at).toBe("2026-06-05");
  });

  it("validates route selection strictly, streams a safe download, and cleans owned temporary files", async () => {
    const dataRoot = tempRoot("markdown-route-data-");
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    seedEntry(database, {
      title: "Route",
      markdown: "route body",
      publishedAt: "2026-07-26T08:00:00+08:00",
    });
    const server = buildServer({ dataRoot, database });
    servers.push(server);

    for (const url of [
      "/api/v1/exports/markdown",
      "/api/v1/exports/markdown?entryId=bad",
      "/api/v1/exports/markdown?entryId=00000000-0000-4000-8000-000000000001&from=2026-07-26&to=2026-07-26",
      "/api/v1/exports/markdown?from=2026-07-26",
      "/api/v1/exports/markdown?from=2026-07-27&to=2026-07-26",
      "/api/v1/exports/markdown?from=2025-01-01&to=2026-07-26",
      "/api/v1/exports/markdown?from=2026-07-26&to=2026-07-26&extra=true",
    ]) {
      expect((await server.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/exports/markdown?from=2026-07-26&to=2026-07-26",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="diary-2026-07-26-to-2026-07-26.zip"');
    expect(response.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const downloadRoot = join(`${dataRoot}.restore-tmp`, "markdown-exports");
    expect(await readdir(downloadRoot).catch(() => [])).toEqual([]);
  });

  function createFixture(): Fixture {
    const dataRoot = tempRoot("markdown-export-data-");
    const database = createDiaryDatabase(dataRoot);
    databases.push(database);
    return { database, dataRoot, store: new MediaStore(join(dataRoot, "media")) };
  }

  async function exportFixture(fixture: Fixture, selection: MarkdownExportSelection): Promise<string> {
    const output = join(tempRoot("markdown-export-output-"), "diary.zip");
    await exportMarkdownArchive(selection, {
      database: fixture.database,
      mediaStore: fixture.store,
    }, output);
    return output;
  }

  function tempRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});

function seedEntry(database: DiaryDatabase, values: {
  title: string;
  markdown: string;
  publishedAt: string | null;
  updatedAt?: string;
  tags?: string[];
  state?: "draft" | "published" | "trashed";
}): string {
  const id = randomUUID();
  const now = values.updatedAt ?? "2026-07-26T14:18:00.000Z";
  const state = values.state ?? "published";
  database.prepare(`
    INSERT INTO entries (
      id, title, markdown, state, published_at, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, values.title, values.markdown, state, values.publishedAt, now, now, state === "trashed" ? now : null);
  for (const name of values.tags ?? []) {
    const tagId = randomUUID();
    database.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").run(tagId, name);
    database.prepare("INSERT INTO entry_tags (entry_id, tag_id) VALUES (?, ?)").run(id, tagId);
  }
  return id;
}

function insertMedia(
  database: DiaryDatabase,
  entryId: string,
  id: string,
  hash: string,
  mime: string,
  extension: string,
): void {
  database.prepare(`
    INSERT INTO media (
      id, entry_id, original_hash, original_mime, original_extension,
      derivative_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?)
  `).run(id, entryId, hash, mime, extension, "2026-07-26T14:18:00.000Z", "2026-07-26T14:18:00.000Z");
}

function readZip(pathname: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(pathname, { lazyEntries: true }, (error, archive) => {
      if (error || !archive) return reject(error ?? new Error("Could not open ZIP"));
      const entries = new Map<string, Buffer>();
      archive.on("error", reject);
      archive.on("end", () => resolve(entries));
      archive.on("entry", (entry) => {
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("Could not read ZIP entry"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}

function parseFrontMatter(markdown: string): { attributes: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error("Missing front matter");
  return { attributes: parseYaml(match[1]) as Record<string, unknown>, body: match[2] };
}

function isSafeArchiveName(name: string): boolean {
  return !name.includes("\\")
    && !name.startsWith("/")
    && !/^[A-Za-z]:/u.test(name)
    && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
