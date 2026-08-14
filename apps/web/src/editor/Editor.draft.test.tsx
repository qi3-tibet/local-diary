// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DraftInput, Entry } from "@diary/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDraft = vi.hoisted(() => vi.fn<() => Promise<Entry | null>>());
const saveDraft = vi.hoisted(() => vi.fn<(input: DraftInput) => Promise<Entry>>());
const uploadMusic = vi.hoisted(() => vi.fn());
const recognizeMusic = vi.hoisted(() => vi.fn());
const patchMusicMetadata = vi.hoisted(() => vi.fn());

vi.mock("../api/client", () => ({
  api: { getDraft, saveDraft, uploadMusic, recognizeMusic, patchMusicMetadata },
}));

import { Editor } from "./Editor";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function savedDraft(input: DraftInput): Entry {
  return {
    id: "draft-1",
    ...input,
    state: "draft",
    publishedAt: null,
    createdAt: "2026-08-14T12:00:00.000+08:00",
    updatedAt: "2026-08-14T12:00:00.000+08:00",
    deletedAt: null,
    edited: false,
    music: null,
  };
}

const attachedMusic = {
  mediaId: "00000000-0000-4000-8000-000000000011",
  title: null,
  artist: null,
  album: null,
  year: null,
  coverMediaId: null,
  coverMime: null,
  recognitionStatus: "manual_required" as const,
};

afterEach(cleanup);

describe("Editor draft leave", () => {
  beforeEach(() => {
    getDraft.mockReset();
    getDraft.mockResolvedValue(null);
    saveDraft.mockReset();
    uploadMusic.mockReset();
    recognizeMusic.mockReset();
    patchMusicMetadata.mockReset();
  });

  it("flushes the latest draft before allowing a registered leave", async () => {
    const save = deferred<Entry>();
    const onRegisterLeave = vi.fn();
    saveDraft.mockReturnValue(save.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    const textarea = await screen.findByRole("textbox", { name: "Markdown body" });
    fireEvent.change(textarea, { target: { value: "The final text" } });
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    let completed = false;
    const leaving = leave().then((result) => {
      completed = result;
      return result;
    });
    await waitFor(() => {
      expect(saveDraft).toHaveBeenCalledWith({ title: "", markdown: "The final text", tags: [] });
    });
    expect(completed).toBe(false);

    const input = saveDraft.mock.calls[0]![0]!;
    await act(async () => {
      save.resolve(savedDraft(input));
      await expect(leaving).resolves.toBe(true);
    });
  });

  it("keeps the draft editor open when a registered leave cannot persist", async () => {
    const onRegisterLeave = vi.fn();
    saveDraft.mockRejectedValue(new Error("disk unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown body" }), {
      target: { value: "Cannot lose this" },
    });
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await act(async () => {
      await expect(leave()).resolves.toBe(false);
    });
    expect(screen.getByRole("textbox", { name: "Markdown body" })).toBeInTheDocument();
    expect(screen.getByText("DRAFT SAVE FAILED")).toBeInTheDocument();
  });

  it("does not allow a registered leave after an MP3 attachment fails", async () => {
    const onRegisterLeave = vi.fn();
    saveDraft.mockImplementation(async (input) => savedDraft(input));
    uploadMusic.mockRejectedValue(new Error("disk unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "Markdown body" });
    const musicInput = container.querySelector<HTMLInputElement>('input[accept="audio/mpeg,.mp3"]')!;
    fireEvent.change(musicInput, { target: { files: [new File(["audio"], "song.mp3", { type: "audio/mpeg" })] } });
    await screen.findByText("THE MP3 COULD NOT BE ATTACHED");
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(false);
  });

  it("does not allow a registered leave after MP3 recognition fails", async () => {
    const onRegisterLeave = vi.fn();
    saveDraft.mockImplementation(async (input) => savedDraft(input));
    uploadMusic.mockResolvedValue(attachedMusic);
    recognizeMusic.mockRejectedValue(new Error("recognition unavailable"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "Markdown body" });
    const musicInput = container.querySelector<HTMLInputElement>('input[accept="audio/mpeg,.mp3"]')!;
    fireEvent.change(musicInput, { target: { files: [new File(["audio"], "song.mp3", { type: "audio/mpeg" })] } });
    await screen.findByText("MUSIC RECOGNITION IS UNAVAILABLE");
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(false);
  });

  it("updates the draft cache after a media-only leave without another draft save", async () => {
    const onRegisterLeave = vi.fn();
    const created = savedDraft({ title: "", markdown: "", tags: [] });
    getDraft.mockResolvedValueOnce(null).mockResolvedValueOnce(created).mockResolvedValueOnce(created);
    saveDraft.mockResolvedValue(created);
    uploadMusic.mockResolvedValue(attachedMusic);
    recognizeMusic.mockResolvedValue(attachedMusic);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "Markdown body" });
    const musicInput = container.querySelector<HTMLInputElement>('input[accept="audio/mpeg,.mp3"]')!;
    fireEvent.change(musicInput, { target: { files: [new File(["audio"], "song.mp3", { type: "audio/mpeg" })] } });
    await screen.findByRole("region", { name: "Music metadata" });
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(true);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["draft"])).toEqual(created);
  });

  it("refreshes an existing draft cache after a media-only leave", async () => {
    const onRegisterLeave = vi.fn();
    const existing = { ...savedDraft({ title: "", markdown: "", tags: [] }), id: "draft-existing" };
    const updated = {
      ...existing,
      music: {
        ...attachedMusic,
        originalFilename: "song.mp3",
        streamUrl: "/api/v1/music/draft-existing",
        coverUrl: null,
        available: true,
      },
    };
    getDraft.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated).mockResolvedValueOnce(updated);
    uploadMusic.mockResolvedValue(attachedMusic);
    recognizeMusic.mockResolvedValue(attachedMusic);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    await screen.findByRole("textbox", { name: "Markdown body" });
    const musicInput = container.querySelector<HTMLInputElement>('input[accept="audio/mpeg,.mp3"]')!;
    fireEvent.change(musicInput, { target: { files: [new File(["audio"], "song.mp3", { type: "audio/mpeg" })] } });
    await screen.findByRole("region", { name: "Music metadata" });
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(true);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["draft"])).toEqual(updated);
  });

  it("refreshes the cache after saving metadata without changing the draft text", async () => {
    const onRegisterLeave = vi.fn();
    const initialMusic = {
      ...attachedMusic,
      originalFilename: "song.mp3",
      streamUrl: "/api/v1/music/draft-existing",
      coverUrl: null,
      available: true,
    };
    const existing = {
      ...savedDraft({ title: "", markdown: "", tags: [] }),
      id: "draft-existing",
      music: initialMusic,
    };
    const updated = { ...existing, music: { ...initialMusic, title: "Updated title" } };
    getDraft.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated).mockResolvedValueOnce(updated);
    patchMusicMetadata.mockResolvedValue({ ...attachedMusic, title: "Updated title" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Song title" }), {
      target: { value: "Updated title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save music metadata" }));
    await waitFor(() => expect(patchMusicMetadata).toHaveBeenCalled());
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(true);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["draft"])).toEqual(updated);
  });

  it("updates the cache and starts a draft refetch after a successful leave save", async () => {
    const onRegisterLeave = vi.fn();
    const persisted = savedDraft({ title: "Saved title", markdown: "Saved body", tags: [] });
    const refreshed = deferred<Entry | null>();
    getDraft.mockResolvedValueOnce(null).mockReturnValueOnce(refreshed.promise);
    saveDraft.mockResolvedValue(persisted);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor {...({
          onCancel: vi.fn(async () => undefined),
          onComplete: vi.fn(),
          onRegisterLeave,
        } as unknown as Parameters<typeof Editor>[0])} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown body" }), {
      target: { value: "Saved body" },
    });
    await waitFor(() => expect(onRegisterLeave).toHaveBeenCalled());
    const leave = onRegisterLeave.mock.calls.at(-1)![0] as () => Promise<boolean>;

    await expect(leave()).resolves.toBe(true);

    expect(queryClient.getQueryData(["draft"])).toEqual(persisted);
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2));
    await act(async () => {
      refreshed.resolve(persisted);
      await refreshed.promise;
    });
  });

  it("reinitializes a same-id form when the persisted draft revision changes", async () => {
    const original = savedDraft({ title: "Old title", markdown: "Old body", tags: [] });
    const saved = {
      ...original,
      title: "Saved title",
      markdown: "Saved body",
      updatedAt: "2026-08-14T12:00:01.000+08:00",
    };
    getDraft.mockResolvedValue(original);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor onCancel={vi.fn(async () => undefined)} onComplete={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("textbox", { name: "Markdown body" })).toHaveValue("Old body");
    act(() => queryClient.setQueryData(["draft"], saved));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown body" })).toHaveValue("Saved body");
    });
  });

  it("preserves active typing when a background refetch returns the same draft revision", async () => {
    const persisted = savedDraft({ title: "Saved title", markdown: "Saved body", tags: [] });
    getDraft.mockResolvedValue(persisted);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor onCancel={vi.fn(async () => undefined)} onComplete={vi.fn()} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Markdown body" }), {
      target: { value: "Still typing" },
    });
    act(() => queryClient.setQueryData(["draft"], { ...persisted }));

    expect(screen.getByRole("textbox", { name: "Markdown body" })).toHaveValue("Still typing");
  });
});
