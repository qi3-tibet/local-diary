import { EntryRepository } from "../entries/repository.js";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeExpiredTrash(repository: EntryRepository, now: Date): number {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_MS).toISOString();
  return repository.purgeTrashedBefore(cutoff);
}
