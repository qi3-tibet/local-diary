// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicMetadataEditor } from "./MusicMetadataEditor";

afterEach(cleanup);

describe("MusicMetadataEditor", () => {
  it("edits all text fields with English labels and submits manual values", () => {
    const onSave = vi.fn();
    render(
      <MusicMetadataEditor
        metadata={{
          title: "雨",
          artist: "某人",
          album: "夜",
          year: 2020,
          coverMediaId: null,
          recognitionStatus: "candidates"
        }}
        candidates={[]}
        onSave={onSave}
        onSelectCandidate={vi.fn()}
        onCoverSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Music metadata" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Song title" }), {
      target: { value: "手动歌名" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Artist" }), {
      target: { value: "手动歌手" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Album" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Year" }), {
      target: { value: "2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save music metadata" }));

    expect(onSave).toHaveBeenCalledWith({
      title: "手动歌名",
      artist: "手动歌手",
      album: null,
      year: 2026,
    });
  });

  it("requires an explicit accessible action before selecting a recognition candidate", () => {
    const onSelectCandidate = vi.fn();
    render(
      <MusicMetadataEditor
        metadata={{
          title: null,
          artist: null,
          album: null,
          year: null,
          coverMediaId: null,
          recognitionStatus: "candidates"
        }}
        candidates={[
          {
            id: "candidate-1",
            title: "Pink + White",
            artist: "Frank Ocean",
            album: "Blonde",
            year: 2016,
            coverMediaId: null,
            coverReleaseId: null,
            score: 0.97,
            source: "text",
          },
        ]}
        onSave={vi.fn()}
        onSelectCandidate={onSelectCandidate}
        onCoverSelect={vi.fn()}
      />,
    );

    expect(onSelectCandidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {
      name: "Use Pink + White by Frank Ocean",
    }));
    expect(onSelectCandidate).toHaveBeenCalledWith("candidate-1");
  });

  it("uses a text cover control and exposes busy state without generic icons", () => {
    const onCoverSelect = vi.fn();
    const { container } = render(
      <MusicMetadataEditor
        busy
        metadata={{
          title: null,
          artist: null,
          album: null,
          year: null,
          coverMediaId: null,
          recognitionStatus: "manual_required"
        }}
        candidates={[]}
        onSave={vi.fn()}
        onSelectCandidate={vi.fn()}
        onCoverSelect={onCoverSelect}
      />,
    );

    expect(screen.getByRole("region", { name: "Music metadata" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("MANUAL DETAILS REQUIRED")).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace cover" })).toBeDisabled();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toHaveAttribute("hidden");
  });

  it("refreshes editable values after an explicit candidate selection updates metadata", () => {
    const props = {
      candidates: [],
      onSave: vi.fn(),
      onSelectCandidate: vi.fn(),
      onCoverSelect: vi.fn(),
    };
    const { rerender } = render(
      <MusicMetadataEditor
        {...props}
        metadata={{
          title: null,
          artist: null,
          album: null,
          year: null,
          coverMediaId: null,
          recognitionStatus: "candidates"
        }}
      />,
    );

    rerender(
      <MusicMetadataEditor
        {...props}
        metadata={{
          title: "识别歌曲",
          artist: "识别歌手",
          album: "识别专辑",
          year: 2024,
          coverMediaId: null,
          recognitionStatus: "recognized"
        }}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Song title" })).toHaveValue("识别歌曲");
    expect(screen.getByRole("textbox", { name: "Artist" })).toHaveValue("识别歌手");
    expect(screen.getByRole("spinbutton", { name: "Year" })).toHaveValue(2024);
  });
});
