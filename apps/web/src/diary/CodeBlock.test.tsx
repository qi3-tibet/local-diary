// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeBlock, normalizeCodeLanguage } from "./CodeBlock";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
});

it("normalizes common Markdown fence aliases to a supported grammar", () => {
  expect(normalizeCodeLanguage("ts")).toBe("typescript");
  expect(normalizeCodeLanguage("sh")).toBe("bash");
  expect(normalizeCodeLanguage("unknown-language")).toBeUndefined();
});

it("labels an unsupported fence and preserves its exact plain source", () => {
  render(<CodeBlock className="language-unknown-language">hello &lt;world&gt;</CodeBlock>);

  expect(screen.getByText("UNKNOWN-LANGUAGE")).toBeVisible();
  expect(screen.getByText("hello <world>")).toBeVisible();
});

it("applies the VS Code grammar to a supported fenced language", async () => {
  const { container } = render(<CodeBlock className="language-ts">{'const answer = "diary";'}</CodeBlock>);

  await waitFor(() => {
    expect(container.querySelector(".entry-code-highlight .shiki")).toBeInTheDocument();
  });
});

it("uses the Dark+ grammar theme when the diary is dark", async () => {
  document.documentElement.dataset.theme = "dark";
  const { container } = render(<CodeBlock className="language-ts">const answer = 42;</CodeBlock>);

  await waitFor(() => {
    expect(container.querySelector(".entry-code-highlight .shiki")?.getAttribute("style"))
      .toContain("background-color:#1E1E1E");
  });
});

it("uses an icon-only control to copy the exact fenced source", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<CodeBlock className="language-ts">const answer = 42;</CodeBlock>);

  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

  expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  expect(screen.getByRole("button", { name: "Copy code" }).textContent).toBe("");
  expect(screen.getByRole("button", { name: "Copy code" }).querySelector("svg")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
});

it("does not report success when the Clipboard API is unavailable", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  render(<CodeBlock className="language-ts">const answer = 42;</CodeBlock>);

  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await act(async () => {});

  expect(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});
