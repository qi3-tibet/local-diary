// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageInsert } from "./ImageInsert";

afterEach(cleanup);

describe("ImageInsert", () => {
  it("keeps the file input out of the accessibility tree", () => {
    const { container } = render(<ImageInsert onSelect={vi.fn()} />);

    expect(container.querySelector('input[type="file"]')).toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Insert image" })).toBeEnabled();
  });

  it("disables its geometric control while the editor is submitting", () => {
    render(<ImageInsert disabled onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Insert image" })).toBeDisabled();
  });
});
