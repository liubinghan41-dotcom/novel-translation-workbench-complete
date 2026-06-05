import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createServer } = require("../server.js");

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function postJson(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function rmWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("server API parses, runs demo translation, and persists project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ntw-test-"));
  const workbench = createServer({ port: 0, dataDir, staticDir: process.cwd() });
  const handle = await workbench.start();

  try {
    const health = await fetch(`${handle.url}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);

    const book = await postJson(handle.url, "/api/parse-book", {
      name: "sample.txt",
      contentBase64: base64("Chapter 1\nHello world.\n\nChapter 2\nAnother scene.")
    });
    assert.equal(book.chapters.length, 2);

    const job = await postJson(handle.url, "/api/jobs/start", {
      book,
      chapters: book.chapters.map((chapter, index) => ({ ...chapter, originalIndex: index })),
      config: {
        provider: "demo",
        model: "demo-translator",
        targetLanguage: "Chinese",
        chunkSize: 1200,
        preserveParagraphs: true
      }
    });
    assert.match(job.status, /^(queued|running)$/);

    let snapshot = job;
    for (let i = 0; i < 30 && (snapshot.status === "queued" || snapshot.status === "running"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      snapshot = await fetch(`${handle.url}/api/jobs/${encodeURIComponent(job.id)}`).then((response) => response.json());
    }

    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.results.length, 2);

    const projects = await fetch(`${handle.url}/api/projects`).then((response) => response.json());
    assert.equal(projects.projects.length, 1);
  } finally {
    await new Promise((resolve) => handle.server.close(resolve));
    await rmWithRetry(dataDir);
  }
});
