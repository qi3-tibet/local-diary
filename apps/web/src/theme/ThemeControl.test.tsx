// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeControl } from "./ThemeControl";

afterEach(cleanup);

describe("ThemeControl", () => {
  it("cycles through system, light, and dark preferences", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThemeControl preference="system" onChange={onChange} />);

    const systemButton = screen.getByRole("button", {
      name: "Theme: System. Switch to light theme",
    });
    expect(systemButton).toBeEmptyDOMElement();
    expect(systemButton).toHaveAttribute("data-preference", "system");
    fireEvent.click(systemButton);
    expect(onChange).toHaveBeenLastCalledWith("light");

    rerender(<ThemeControl preference="light" onChange={onChange} />);
    const lightButton = screen.getByRole("button", {
      name: "Theme: Light. Switch to dark theme",
    });
    expect(lightButton).toHaveAttribute("data-preference", "light");
    fireEvent.click(lightButton);
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(<ThemeControl preference="dark" onChange={onChange} />);
    const darkButton = screen.getByRole("button", {
      name: "Theme: Dark. Follow system theme",
    });
    expect(darkButton).toHaveAttribute("data-preference", "dark");
    fireEvent.click(darkButton);
    expect(onChange).toHaveBeenLastCalledWith("system");
  });
});
