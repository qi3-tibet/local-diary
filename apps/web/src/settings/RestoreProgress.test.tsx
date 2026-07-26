// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RestoreProgress, type RestoreState } from "./RestoreProgress";

afterEach(cleanup);

describe("RestoreProgress", () => {
  it("keeps completed phases visible so fast streamed transitions remain observable", () => {
    const state: RestoreState = {
      phase: "DONE",
      history: ["VALIDATING", "SAFETY_BACKUP", "RESTORING", "REBUILDING", "DONE"],
    };
    render(<RestoreProgress state={state} />);

    expect(screen.getByLabelText("Restore progress")).toHaveTextContent(
      "VALIDATINGSAFETY_BACKUPRESTORINGREBUILDINGDONE",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers the retained archive as a retry after failure", () => {
    const retry = vi.fn();
    render(<RestoreProgress state={{
      phase: "FAILED",
      history: ["VALIDATING", "FAILED"],
      error: "ARCHIVE_CHECKSUM_MISMATCH",
      retry,
    }} />);

    screen.getByRole("button", { name: "Retry" }).click();
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("ARCHIVE_CHECKSUM_MISMATCH");
  });
});
