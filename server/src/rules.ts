import type { Address, Hex } from "viem";
const textLimit = 1000;
const lineBreakLimit = 20;
const markLimit = 4;
const pageDefault = 50;
const pageMax = 100;
export type Page = { after?: number; before?: number; limit: number };
// C0, DEL and C1 controls except line feed.
const control = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// With the u flag a surrogate matches only when it is unpaired. SQLite would
// store one as U+FFFD, so the saved text would differ from the accepted text.
const loneSurrogate = /\p{Cs}/u;
// Characters that draw nothing or change the direction text is drawn in:
// zero-width characters and directional marks, line and paragraph separators,
// directional embeddings, overrides and isolates, invisible operators and
// format controls, and the byte order mark. With them a message can read as
// other text than it holds.
const invisible = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
// The zero-width joiner is also what builds one emoji out of several, so it
// is allowed exactly there: between two pictographs.
const emojiJoiner =
  /(\p{Extended_Pictographic}[\ufe0f\p{Emoji_Modifier}]?)\u200d(?=\p{Extended_Pictographic})/gu;
// What is left of a message that draws nothing: characters a renderer skips
// (fillers, variation selectors, tags), format characters, which only act on
// their neighbours, combining marks, spaces and the blank braille pattern. A
// message made only of these would look empty.
const blank = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\p{Z}\u2800\n]/gu;
// Nonspacing and enclosing marks pile up on the character before them, and
// past what writing needs they run over the lines above and below and the
// messages there. Four in a row is the limit Unicode's security guidance
// gives (UTS #39, 5.4). Spacing marks sit beside the character and are not
// counted. A format character or a filler between two groups of marks draws
// nothing and leaves both groups on the one character, so the marks are
// counted with those taken out.
const stacked = new RegExp(`[\\p{Mn}\\p{Me}]{${markLimit + 1},}`, "u");
const unseen = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
export function parseAddress(value: unknown): Address | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Address)
    : null;
}
export function parseSignature(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value)
    ? (value as Hex)
    : null;
}
export function parseId(value: unknown): number | null {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,14})$/.test(value)
    ? Number(value)
    : null;
}
export function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || control.test(text) || loneSurrogate.test(text)) return null;
  if (invisible.test(text.replace(emojiJoiner, "$1"))) return null;
  if (!text.replace(blank, "")) return null;
  if (stacked.test(text.replace(unseen, ""))) return null;
  if (text.split("\n").length - 1 > lineBreakLimit) return null;
  return [...text].length <= textLimit ? text : null;
}
export function parsePage(query: URLSearchParams): Page | null {
  const read = (name: string, missing?: number) =>
    query.has(name) ? parseId(query.get(name)) : missing;
  const after = read("after");
  const before = read("before");
  const limit = read("limit", pageDefault);
  if (after === null || before === null || !limit || limit > pageMax)
    return null;
  return { after, before, limit };
}
