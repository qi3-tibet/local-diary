// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MaterialSymbol } from "./MaterialSymbol";

describe("MaterialSymbol", () => {
  it("renders its ligature name as hidden text without an accessible name", () => {
    render(<MaterialSymbol name="home" className="tool-icon" />);

    const symbol = screen.getByText("home");
    expect(symbol).toHaveAttribute("aria-hidden", "true");
    expect(symbol).toHaveClass("material-symbol", "tool-icon");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
