import type { DraftInput, Entry } from "@diary/contracts";
import { EntryRepository } from "./repository.js";
import type { BeijingClock } from "../time/beijing.js";

export class EntryValidationError extends Error {
  constructor(readonly fields: string[]) {
    super("Entry validation failed");
  }
}

export class EntryService {
  constructor(
    private readonly entries: EntryRepository,
    private readonly clock: BeijingClock,
  ) {}

  saveDraft(input: DraftInput): Entry {
    return this.entries.saveDraft(input);
  }

  getDraft(): Entry | null {
    return this.entries.getDraft();
  }

  listPublished(): Entry[] {
    return this.entries.listPublished();
  }

  publishDraft(): Entry {
    const draft = this.entries.getDraft();
    if (!draft) throw new EntryValidationError(["draft"]);

    const fields = [
      ...(draft.title.trim() ? [] : ["title"]),
      ...(draft.markdown.trim() ? [] : ["markdown"]),
    ];
    if (fields.length) throw new EntryValidationError(fields);

    return this.entries.publishDraft(draft.id, this.clock.publishedAt());
  }
}
