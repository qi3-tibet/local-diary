import type { BeijingClock } from "../time/beijing.js";
import type { SnapshotService } from "./snapshot.js";

export type DailyBackupResult = { created: boolean; day: string };

const locks = new Map<SnapshotService, Promise<void>>();

export async function runDailyBackupIfDue(options: { snapshots: SnapshotService; clock: BeijingClock }): Promise<DailyBackupResult> {
  const { snapshots, clock } = options;
  const day = clock.dayKey(clock.publishedAt());
  const previous = locks.get(snapshots) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  locks.set(snapshots, tail);
  await previous;
  try {
    if (snapshots.getLastScheduledDay() === day && await snapshots.hasDay(day)) return { created: false, day };
    if (await snapshots.hasDay(day)) {
      snapshots.recordScheduledDay(day);
      return { created: false, day };
    }
    await snapshots.create(day);
    snapshots.recordScheduledDay(day);
    return { created: true, day };
  } finally {
    release();
    if (locks.get(snapshots) === tail) locks.delete(snapshots);
  }
}
