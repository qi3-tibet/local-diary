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

    fireEvent.click(screen.getByRole("button", { name: "Theme: System. Change theme" }));
    expect(onChange).toHaveBeenLastCalledWith("light");

    rerender(<ThemeControl preference="light" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Theme: Light. Change theme" }));
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(<ThemeControl preference="dark" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Theme: Dark. Change theme" }));
    expect(onChange).toHaveBeenLastCalledWith("system");
  });
});
