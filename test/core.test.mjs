import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, createEpub, parseBook } from "../src/core/book.mjs";

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

test("parseBook splits plain text chapters", () => {
  const book = parseBook({
    name: "sample.txt",
    contentBase64: base64("Chapter 1\nHello world.\n\nChapter 2\nAnother scene.")
  });
  assert.equal(book.title, "sample");
  assert.equal(book.metadata.format, "txt");
  assert.equal(book.chapters.length, 2);
  assert.match(book.chapters[0].text, /Hello world/);
});

test("createEpub output can be parsed again", () => {
  const epub = createEpub({
    title: "Translated Sample",
    chapters: [
      { title: "One", text: "First paragraph.\n\nSecond paragraph." },
      { title: "Two", text: "Final paragraph." }
    ]
  });
  const parsed = parseBook({
    name: "translated.epub",
    contentBase64: Buffer.from(epub).toString("base64")
  });
  assert.equal(parsed.metadata.format, "epub");
  assert.equal(parsed.title, "Translated Sample");
  assert.equal(parsed.chapters.length, 2);
  assert.match(parsed.chapters[0].text, /First paragraph/);
});

test("chunkText preserves paragraphs when requested", () => {
  const chunks = chunkText("alpha\n\nbeta\n\ngamma", 12, true);
  assert.deepEqual(chunks, ["alpha\n\nbeta", "gamma"]);
});
