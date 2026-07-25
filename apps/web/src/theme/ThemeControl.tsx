import type { ThemePreference } from "./theme-store";

const nextPreference: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

type ThemeControlProps = {
  preference: ThemePreference;
  onChange: (preference: ThemePreference) => void;
};

export function ThemeControl({ preference, onChange }: ThemeControlProps) {
  const label = preference[0].toUpperCase() + preference.slice(1);

  return (
    <button
      className="theme-control"
      type="button"
      aria-label={`Theme: ${label}. Change theme`}
      onClick={() => onChange(nextPreference[preference])}
    >
      <span className="theme-mark" aria-hidden="true" />
      <span>{preference.toUpperCase()}</span>
    </button>
  );
}
