import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAddress,
  parseId,
  parsePage,
  parseSignature,
  parseText,
} from "../src/rules.ts";
const hex = (digit: string, length: number) => "0x" + digit.repeat(length);
test("an address is exactly 20 hex bytes and is compared in lowercase", () => {
  assert.equal(parseAddress("0x" + "aB".repeat(20)), "0x" + "ab".repeat(20));
  for (const bad of [
    "",
    "0x",
    hex("a", 39),
    hex("a", 41),
    "0X" + "a".repeat(40),
    "a".repeat(40),
    hex("g", 40),
    " " + hex("a", 40),
    hex("a", 40) + "\n",
    null,
    undefined,
    1,
    [hex("a", 40)],
  ])
    assert.equal(parseAddress(bad), null, JSON.stringify(bad));
});
test("a signature is exactly 65 hex bytes", () => {
  assert.equal(parseSignature(hex("1", 130)), hex("1", 130));
  for (const bad of [hex("1", 128), hex("1", 132), hex("z", 130), "", null])
    assert.equal(parseSignature(bad), null);
});
test("ids are canonical non-negative decimal integers", () => {
  assert.equal(parseId("0"), 0);
  assert.equal(parseId("42"), 42);
  assert.equal(parseId("999999999999999"), 999999999999999);
  for (const bad of ["", "01", "-1", "1.0", "1e3", "0x1", " 1", "1 ", "٣"])
    assert.equal(parseId(bad), null, bad);
  assert.equal(parseId("1".repeat(16)), null);
  assert.equal(parseId(1), null);
  assert.equal(parseId(null), null);
});
test("text is trimmed and holds 1 to 1000 Unicode code points", () => {
  assert.equal(parseText("  hello\n"), "hello");
  assert.equal(parseText("x".repeat(1000)), "x".repeat(1000));
  assert.equal(parseText("x".repeat(1001)), null);
  assert.equal(parseText(` ${"한".repeat(1000)} `), "한".repeat(1000));
  // One code point each, two UTF-16 units each.
  assert.equal(parseText("😀".repeat(1000)), "😀".repeat(1000));
  assert.equal(parseText("😀".repeat(1001)), null);
  for (const empty of ["", " ", "\n\n", "\t", "\u00a0", "\ufeff"])
    assert.equal(parseText(empty), null, JSON.stringify(empty));
  for (const value of [null, undefined, 1, true, {}, ["x"]])
    assert.equal(parseText(value), null);
});
test("line feed is the only control character allowed in text", () => {
  for (const good of ["a\nb", "a\n\nb", "a\u00a0b", "é", "한글 ✓ \u2764\ufe0f"])
    assert.equal(parseText(good), good);
  for (const bad of [
    "a\tb",
    "a\rb",
    "a\r\nb",
    "a\x00b",
    "a\x1bb",
    "a\x7fb",
    "a\x80b",
    "a\x85b",
    "a\x9fb",
  ])
    assert.equal(parseText(bad), null, JSON.stringify(bad));
});
test("unpaired surrogates are refused, paired ones are not", () => {
  for (const bad of ["a\ud800b", "a\udc00b", "\ude00\ud83d", "x\ud83d"])
    assert.equal(parseText(bad), null, JSON.stringify(bad));
  assert.equal(parseText("😀"), "😀");
});
test("characters that draw nothing or turn the text around are refused", () => {
  for (const [first, last] of [
    [0x061c, 0x061c],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff],
  ] as const)
    for (let code = first; code <= last; code++)
      assert.equal(
        parseText(`a${String.fromCodePoint(code)}b`),
        null,
        code.toString(16),
      );
  for (const bad of [
    "\u200b",
    "\u200b\u200b\u200b",
    "send funds to \u202eevil",
    "\u2066x\u2069",
    "x \u200f",
  ])
    assert.equal(parseText(bad), null, JSON.stringify(bad));
  // The neighbours of those ranges are ordinary characters.
  for (const code of [
    0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2070, 0xfe0f,
  ])
    assert.notEqual(parseText(`a${String.fromCodePoint(code)}b`), null);
});
test("the zero-width joiner is allowed only where it builds an emoji", () => {
  const joiner = "\u200d";
  const [man, woman, girl, person] = [
    "\u{1f468}",
    "\u{1f469}",
    "\u{1f467}",
    "\u{1f9d1}",
  ];
  for (const emoji of [
    // shrugging man, family, kiss, astronaut with a skin tone, eye in a
    // speech bubble, transgender flag, polar bear
    `\u{1f937}${joiner}\u2642\ufe0f`,
    `${man}${joiner}${woman}${joiner}${girl}`,
    `${woman}${joiner}\u2764\ufe0f${joiner}\u{1f48b}${joiner}${man}`,
    `${person}\u{1f3fd}${joiner}\u{1f680}`,
    `\u{1f441}\ufe0f${joiner}\u{1f5e8}\ufe0f`,
    `\u{1f3f3}\ufe0f${joiner}\u26a7\ufe0f`,
    `\u{1f43b}${joiner}\u2744\ufe0f`,
    `in a sentence \u{1f926}${joiner}\u2640\ufe0f too`,
  ])
    assert.equal(parseText(emoji), emoji, JSON.stringify(emoji));
  for (const bad of [
    joiner,
    `a${joiner}b`,
    `\u{1f600}${joiner}`,
    `${joiner}\u{1f600}`,
    `\u{1f600}${joiner}b`,
    `a${joiner}\u{1f600}`,
    `\u{1f600}${joiner}${joiner}\u{1f600}`,
    `\u{1f600}\ufe0f\ufe0f${joiner}\u{1f600}`,
  ])
    assert.equal(parseText(bad), null, JSON.stringify(bad));
});
test("a message has to show something", () => {
  // Fillers, variation selectors, tags, combining marks and blank braille
  // draw nothing by themselves: a message of only these would look empty.
  for (const empty of [
    // Hangul filler
    "\u3164",
    // halfwidth Hangul filler
    "\uffa0",
    // Hangul choseong filler
    "\u115f",
    // blank braille pattern
    "\u2800",
    // soft hyphen
    "\u00ad",
    // variation selector
    "\ufe0f",
    // combining marks
    "\u0301\u0301",
    // tag characters
    "\u{e0041}\u{e0042}",
    // fillers on two lines
    "\u3164\n\u2800",
    // filler and spaces
    "\u3164 \u3000\u3164",
    // format characters that are not skipped but act on what follows: the
    // Arabic number sign and end of ayah, the Syriac abbreviation mark,
    // an interlinear annotation anchor, the Kaithi number sign
    "\u0600",
    "\u06dd",
    "\u070f",
    "\ufff9\ufffa\ufffb",
    "\u{110bd}",
    // and one of them beside a filler
    "\u0600\u3164",
  ])
    assert.equal(parseText(empty), null, JSON.stringify(empty));
  // Beside something that is drawn they are part of ordinary text.
  for (const shown of [
    // a letter beside a filler
    "a\u3164",
    // a heart with its variation selector
    "\u2764\ufe0f",
    // a keycap
    "1\ufe0f\u20e3",
    // the flag of England
    "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
    // a full stop
    ".",
    // a braille dot
    "\u2801",
    // a letter under combining marks
    "a\u0301\u0301",
    // the Arabic number sign before the digits it spans
    "\u0600123",
  ])
    assert.equal(parseText(shown), shown, JSON.stringify(shown));
});
test("a character carries four stacking marks at most", () => {
  const of = (...codes: number[]) => String.fromCodePoint(...codes);
  // An acute accent, a grave one and a circumflex, and an enclosing circle,
  // stack on the character: nonspacing and enclosing marks. A variation
  // selector draws nothing.
  const [acute, grave, hat, circle] = [0x0301, 0x0300, 0x0302, 0x20dd];
  const selector = 0xfe0f;
  const stack = (count: number) => `a${of(acute).repeat(count)}`;
  for (const count of [1, 2, 3, 4])
    assert.equal(parseText(stack(count)), stack(count));
  for (const count of [5, 6, 50, 999])
    assert.equal(parseText(stack(count)), null);
  // Anywhere in the text, and whichever of those marks they are.
  assert.equal(parseText(`fine ${stack(4)} but not ${stack(5)}`), null);
  const mixed = of(0x61, acute, circle, hat, grave);
  assert.equal(parseText(mixed), mixed);
  assert.equal(parseText(mixed + of(acute)), null);
  // The count starts again after anything else: a letter, or a spacing
  // mark, which sits beside the character and stacks nothing.
  const spread = stack(4).repeat(100);
  assert.equal(parseText(spread), spread);
  const visarga = 0x0903;
  const beside = of(0x61, acute, circle, hat, visarga, hat, grave, acute);
  assert.equal(parseText(beside), beside);
  const besides = `a${of(visarga).repeat(9)}`;
  assert.equal(parseText(besides), besides);
  // What draws nothing does not start the count again. With a tag, the
  // Mongolian vowel separator, a musical format character, a soft hyphen,
  // an annotation anchor, a Hangul filler, a variation selector or the
  // grapheme joiner between them, fifteen groups of four are sixty marks on
  // the one letter.
  for (const between of [
    0xe0041, 0x180e, 0x1d173, 0xad, 0xfff9, 0x3164, 0x115f, 0xfe0f, 0x034f,
  ])
    assert.equal(
      parseText(`a${(of(acute).repeat(4) + of(between)).repeat(15)}`),
      null,
      between.toString(16),
    );
  const split = of(0x61, acute, acute, 0xe0041, acute, acute);
  assert.equal(parseText(split), split);
  assert.equal(parseText(split + of(acute)), null);
  // Such characters are not marks themselves, however many there are.
  const selectors = `a${of(selector).repeat(9)}`;
  assert.equal(parseText(selectors), selectors);
  // Writing that stacks marks stays inside the limit: decomposed
  // Vietnamese, Thai with a vowel and a tone, Arabic with its vowels, Hebrew
  // with points and a cantillation accent, a Devanagari conjunct, a Tibetan
  // stack, a Burmese syllable with two medials, a vowel and a tone.
  for (const text of [
    of(0x56, 0x69, 0x65, 0x0323, 0x0302, 0x74),
    of(0x0e17, 0x0e35, 0x0e48),
    of(0x0627, 0x0644, 0x0644, 0x064f, 0x0651, 0x063a, 0x064e, 0x0629, 0x064f),
    of(0x05d1, 0x05b0, 0x05bc, 0x05e8, 0x05b5, 0x05d0, 0x05e9, 0x05c1, 0x05b4),
    of(0x05e9, 0x05c1, 0x05b4, 0x0596, 0x05d9, 0x05ea),
    of(0x0938, 0x094d, 0x0924, 0x094d, 0x0930, 0x0940),
    of(0x0f66, 0x0f92, 0x0fb2, 0x0f74, 0x0f56),
    of(0x1000, 0x103c, 0x103d, 0x1031, 0x1038),
  ])
    assert.equal(parseText(text), text);
  // And so do emoji: a keycap, a heart with its selector, a flag made of
  // tags, one made with a joiner, a hand with a skin tone.
  for (const text of [
    of(0x31, 0xfe0f, 0x20e3),
    of(0x2764, 0xfe0f),
    of(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f),
    of(0x1f3f3, 0xfe0f, 0x200d, 0x1f308),
    of(0x1f44d, 0x1f3fd),
  ])
    assert.equal(parseText(text), text);
});
test("a message holds at most twenty line breaks", () => {
  const lines = (count: number) => Array(count).fill("x").join("\n");
  assert.equal(parseText(lines(21)), lines(21));
  assert.equal(parseText(lines(22)), null);
  assert.equal(parseText(`a${"\n".repeat(20)}b`), `a${"\n".repeat(20)}b`);
  assert.equal(parseText(`a${"\n".repeat(21)}b`), null);
  assert.equal(parseText(`a${"\n".repeat(998)}b`), null);
  // Line breaks around the text are trimmed before they are counted.
  assert.equal(parseText(`${"\n".repeat(50)}a\nb${"\n".repeat(50)}`), "a\nb");
});
test("a page takes optional cursors and a limit from 1 to 100", () => {
  const page = (query: string) => parsePage(new URLSearchParams(query));
  assert.deepEqual(page(""), {
    after: undefined,
    before: undefined,
    limit: 50,
  });
  assert.deepEqual(page("after=0&before=9&limit=100"), {
    after: 0,
    before: 9,
    limit: 100,
  });
  assert.equal(page("limit=1")?.limit, 1);
  for (const bad of [
    "limit=0",
    "limit=101",
    "limit=",
    "limit=ten",
    "after=",
    "after=-1",
    "before=1.5",
    "before=x",
  ])
    assert.equal(page(bad), null, bad);
});
