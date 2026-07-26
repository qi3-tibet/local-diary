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
  const label: Record<ThemePreference, string> = {
    system: "Theme: System. Switch to light theme",
    light: "Theme: Light. Switch to dark theme",
    dark: "Theme: Dark. Follow system theme",
  };

  return (
    <button
      className="theme-control"
      type="button"
      aria-label={label[preference]}
      data-preference={preference}
      onClick={() => onChange(nextPreference[preference])}
    />
  );
}
