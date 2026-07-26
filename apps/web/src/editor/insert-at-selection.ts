export type SelectionInsertion = {
  value: string;
  cursor: number;
};

export function insertAtSelection(
  value: string,
  start: number,
  end: number,
  markdown: string,
): SelectionInsertion {
  return {
    value: `${value.slice(0, start)}${markdown}${value.slice(end)}`,
    cursor: start + markdown.length,
  };
}
