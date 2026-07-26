import type {
  DraftInput,
  Entry,
  MusicMetadata,
  MusicMetadataOverride,
  RecognitionCandidate,
} from "@diary/contracts";

type Request = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type UploadedImage = {
  mediaId: string;
  markdownUrl: string;
  alt: string;
  derivativeStatus: "ready" | "failed";
};

export type EditableMusic = MusicMetadata & {
  originalFilename?: string;
  candidates?: RecognitionCandidate[];
  selectedCandidateId?: string | null;
};

export function createApiClient(request: Request = fetch) {
  async function entryRequest(
    path: string,
    message: string,
    init?: RequestInit,
  ): Promise<Entry> {
    const response = await request(path, init);
    if (!response.ok) throw new Error(`${message} (${response.status}).`);
    return (await response.json()) as Entry;
  }

  async function itemListRequest(path: string, message: string): Promise<Entry[]> {
    const response = await request(path, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${message} (${response.status}).`);
    return ((await response.json()) as { items: Entry[] }).items;
  }

  const inputInit = (method: "PUT" | "PATCH", input: DraftInput): RequestInit => ({
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  return {
    async listEntries(): Promise<Entry[]> {
      const response = await request("/api/v1/entries", {
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Could not load diary entries (${response.status}).`);
      }

      return (await response.json()) as Entry[];
    },

    async getDraft(): Promise<Entry | null> {
      const response = await request("/api/v1/draft", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Could not load the draft (${response.status}).`);
      return (await response.json()) as Entry | null;
    },

    saveDraft(input: DraftInput): Promise<Entry> {
      return entryRequest(
        "/api/v1/draft",
        "Could not save the draft",
        inputInit("PUT", input),
      );
    },

    publishDraft(): Promise<Entry> {
      return entryRequest("/api/v1/draft/publish", "Could not publish the draft", {
        method: "POST",
        headers: { accept: "application/json" },
      });
    },

    updateEntry(id: string, input: DraftInput): Promise<Entry> {
      return entryRequest(
        `/api/v1/entries/${id}`,
        "Could not update the entry",
        inputInit("PATCH", input),
      );
    },

    searchEntries(query: string): Promise<Entry[]> {
      return itemListRequest(
        `/api/v1/search?q=${encodeURIComponent(query)}`,
        "Could not search the diary",
      );
    },

    async trashEntry(id: string): Promise<void> {
      const response = await request(`/api/v1/entries/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Could not move the entry to trash (${response.status}).`);
    },

    listTrash(): Promise<Entry[]> {
      return itemListRequest("/api/v1/trash", "Could not load trash");
    },

    restoreEntry(id: string): Promise<Entry> {
      return entryRequest(`/api/v1/trash/${id}/restore`, "Could not restore the entry", {
        method: "POST",
        headers: { accept: "application/json" },
      });
    },

    async uploadImage(entryId: string, image: File): Promise<UploadedImage> {
      const form = new FormData();
      form.append("image", image);
      const response = await request(`/api/v1/entries/${entryId}/images`, {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      });
      if (!response.ok) throw new Error(`Could not upload the image (${response.status}).`);
      return (await response.json()) as UploadedImage;
    },

    async uploadMusic(entryId: string, music: File): Promise<EditableMusic> {
      const form = new FormData();
      form.append("music", music);
      return musicRequest(`/api/v1/entries/${entryId}/music`, "Could not attach the MP3", {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
      });
    },

    recognizeMusic(entryId: string): Promise<EditableMusic> {
      return musicRequest(
        `/api/v1/entries/${entryId}/music/recognition`,
        "Could not recognize the music",
        { method: "POST", headers: { accept: "application/json" } },
      );
    },

    patchMusicMetadata(
      entryId: string,
      patch: MusicMetadataOverride,
    ): Promise<EditableMusic> {
      return musicRequest(
        `/api/v1/entries/${entryId}/music/metadata`,
        "Could not save music metadata",
        {
          method: "PATCH",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
    },

    selectMusicCandidate(entryId: string, candidateId: string): Promise<EditableMusic> {
      return musicRequest(
        `/api/v1/entries/${entryId}/music/recognition/selection`,
        "Could not select the music match",
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ candidateId }),
        },
      );
    },

    mediaDisplayUrl(mediaId: string): string {
      return `/api/v1/media/${encodeURIComponent(mediaId)}/display`;
    },
  };

  async function musicRequest(
    path: string,
    message: string,
    init: RequestInit,
  ): Promise<EditableMusic> {
    const response = await request(path, init);
    if (!response.ok) throw new Error(`${message} (${response.status}).`);
    return (await response.json()) as EditableMusic;
  }
}

export const api = createApiClient();
