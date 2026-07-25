export type BeijingClock = {
  publishedAt(): string;
  dayKey(timestamp: string): string;
};

export function createBeijingClock(now: () => Date = () => new Date()): BeijingClock {
  return {
    publishedAt() {
      const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now()).reduce<Record<string, string>>((out, part) => {
        out[part.type] = part.value;
        return out;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00+08:00`;
    },
    dayKey(timestamp) {
      return timestamp.slice(0, 10);
    },
  };
}
