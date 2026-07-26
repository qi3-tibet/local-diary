type MatchMedia = (query: string) => Pick<MediaQueryList, "matches">;

export function prefersReducedMotion(
  matchMedia: MatchMedia | undefined = typeof window === "undefined"
    ? undefined
    : window.matchMedia.bind(window),
): boolean {
  return matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
