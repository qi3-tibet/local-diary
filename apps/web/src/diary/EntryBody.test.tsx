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

it("keeps inline code inline and renders fenced code outside the Markdown pre wrapper", () => {
  const { container } = render(
    <DiaryMarkdown>{"Text with `inline` code.\n\n```ts\nconst answer = 42;\n```"}</DiaryMarkdown>,
  );

  const inline = container.querySelector("p code");
  expect(inline?.textContent).toBe("inline");
  expect(inline?.parentElement?.tagName).toBe("P");
  expect(container.querySelector("p section")).toBeNull();
  expect(container.querySelector("pre section")).toBeNull();
  expect(container.querySelector(".entry-code-block")).toBeTruthy();
});
