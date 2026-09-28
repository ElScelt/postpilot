// How a post splits into paragraphs and openings. The prompt and the validator both
// compare tonight's hook and question with recent ones, so they must split posts alike.

export function firstParagraph(text: string) {
  return text.trim().split(/\n{2,}/)[0]?.trim() ?? "";
}

export function lastParagraph(text: string) {
  return text.trim().split(/\n{2,}/).at(-1)?.trim() ?? "";
}

export function openingWords(text: string, count: number) {
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'\s]/g, " ")
    .trim().split(/\s+/).slice(0, count).join(" ");
}
