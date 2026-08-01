// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Entry } from "@diary/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  api: {
    getDraft: vi.fn(async () => null),
    saveDraft: vi.fn(),
  },
}));

import { Editor } from "./Editor";

const entry: Entry = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "Long entry",
  markdown: Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`).join("\n\n"),
  state: "published",
  publishedAt: "2025-07-26T10:00:00.000+08:00",
  createdAt: "2025-07-26T10:00:00.000+08:00",
  updatedAt: "2025-07-26T10:00:00.000+08:00",
  deletedAt: null,
  edited: false,
  tags: [],
  music: null,
};

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-preview") ? 500 : 500;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("editor-preview") ? 1000 : 2000;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Editor preview position", () => {
  it.each([
    { mode: "editing", currentEntry: entry },
    { mode: "creating", currentEntry: undefined },
  ])("keeps the same reading progress when $mode in both directions", async ({ currentEntry }) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Editor entry={currentEntry} onCancel={vi.fn()} onComplete={vi.fn()} />
      </QueryClientProvider>,
    );

    const textarea = await screen.findByRole("textbox", { name: "Markdown body" });
    textarea.scrollTop = 750;

    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    const preview = screen.getByLabelText("Markdown preview");
    expect(preview.scrollTop).toBe(250);

    preview.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "Toggle preview" }));
    expect(screen.getByRole("textbox", { name: "Markdown body" }).scrollTop).toBe(1200);
  });
});
