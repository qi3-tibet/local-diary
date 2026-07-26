// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MusicAttach } from "./MusicAttach";

afterEach(cleanup);

it("accepts one MP3 through an English accessible geometric control", () => {
  const onSelect = vi.fn();
  const { container } = render(<MusicAttach onSelect={onSelect} />);
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["music"], "song.mp3", { type: "audio/mpeg" });

  expect(screen.getByRole("button", { name: "Attach MP3" })).toBeVisible();
  expect(input.accept).toBe("audio/mpeg,.mp3");
  expect(container.querySelector("svg")).toBeNull();
  fireEvent.change(input, { target: { files: [file] } });
  expect(onSelect).toHaveBeenCalledWith(file);
});
