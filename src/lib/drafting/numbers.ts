// The numbers a draft may state. A figure the model cannot find in the evidence is
// usually a threshold recycled from an earlier post, so every figure must appear there.

// A number is a run of digits not glued to letters (p95, ES2015, S3 are names) and not
// part of a fraction like 24/7. Numbers under ten without a decimal are counts ("three
// checks", "2 sources") and never the problem; the recycled 70 tok/s threshold is.
// A K, M or B suffix stays part of the figure ("10M-token grant"), so it is checked like
// any other number instead of escaping as a word.
const numberToken = /(?<![A-Za-z\d./])\d+(?:[.,]\d+)*(?:[kKmMbB](?![A-Za-z]))?(?![A-Za-z\d/])/g;

export function unsupportedNumbers(text: string, evidence: string[]) {
  const known = new Set<string>();
  const normalise = (value: string) => value.replace(/,/g, "").toUpperCase();
  for (const match of evidence.join("\n").matchAll(numberToken)) {
    const value = normalise(match[0]);
    known.add(value);
    // "16.3" in the evidence also supports "16"; "16.3.0" also supports "16.3".
    const parts = value.split(".");
    for (let length = 1; length <= parts.length; length += 1) known.add(parts.slice(0, length).join("."));
  }
  // A suffixed figure ("2B parameters") is large by definition, whatever its digits say.
  const found = [...text.matchAll(numberToken)]
    .map((match) => match[0].replace(/,/g, ""))
    .filter((value) => value.includes(".") || /[kKmMbB]$/.test(value) || Number(value) >= 10);
  // A patch version the evidence states as a minor ("16.3.0" against "16.3") is supported.
  const supported = (raw: string) => {
    const value = normalise(raw);
    const parts = value.split(".");
    return parts.some((_, index) => index > 0 && known.has(parts.slice(0, parts.length - index).join("."))) || known.has(value);
  };
  return [...new Set(found)].filter((value) => !supported(value));
}

// The digit check above taught the model to write "ten ms" and "a three-hundred second
// timeout", which reads as exactly the dodge it is. Any figure of ten or more written in
// words is rejected outright, so figures arrive as digits and the evidence check applies.
const smallNumberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const scaleWords: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const numberWord = [...Object.keys(smallNumberWords), ...Object.keys(scaleWords)].join("|");
const spelledNumber = new RegExp(`\\b(?:${numberWord})(?:[ -](?:and[ -])?(?:${numberWord}))*\\b`, "gi");

export function spelledNumbers(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(spelledNumber)) {
    const words = match[0].toLowerCase().split(/[ -]+/).filter((word) => word !== "and");
    // "$4 per million" and "a hundred" are units of measure, not figures; "two thousand" is a figure.
    if (words.length === 1 && words[0]! in scaleWords) continue;
    let total = 0;
    let current = 0;
    for (const word of words) {
      const small = smallNumberWords[word];
      if (small !== undefined) current += small;
      else if (word === "hundred") current = (current || 1) * 100;
      else {
        total += (current || 1) * (scaleWords[word] ?? 1);
        current = 0;
      }
    }
    if (total + current >= 10) found.push(match[0]);
  }
  return [...new Set(found)];
}
