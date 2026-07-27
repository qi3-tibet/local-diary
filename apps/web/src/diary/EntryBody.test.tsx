// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DiaryMarkdown } from "./EntryBody";

afterEach(cleanup);

it("renders every ordinary body newline as a hard line break", () => {
  const { container } = render(
    <DiaryMarkdown>{"第一行\n第二行\n第三行"}</DiaryMarkdown>,
  );

  const paragraph = container.querySelector("p")!;
  expect(paragraph.querySelectorAll("br")).toHaveLength(2);
  expect(paragraph.textContent?.replace(/\s/g, "")).toBe("第一行第二行第三行");
});

it("does not append hard-break spacing inside fenced code blocks", () => {
  const { container } = render(
    <DiaryMarkdown>{"```\nfirst\nsecond\n```"}</DiaryMarkdown>,
  );

  expect(container.querySelector("code")?.textContent).toBe("first\nsecond\n");
  expect(container.querySelector("pre br")).toBeNull();
});
