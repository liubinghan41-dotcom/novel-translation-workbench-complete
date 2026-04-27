const { parseGlossary, relevantTerms } = require("./glossary");

function firstSentences(text, limit = 280) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const parts = normalized.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  const joined = parts.slice(0, 4).join("");
  return (joined || normalized).slice(0, limit);
}

function extractNames(text, limit = 12) {
  const matches = String(text || "").match(/[ァ-ヶー]{2,}|[一-龥]{2,6}/g) || [];
  const counts = new Map();
  for (const match of matches) counts.set(match, (counts.get(match) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([name]) => name);
}

function summarizeChapter({ chapter, translatedText, glossary }) {
  const text = translatedText || chapter.text || "";
  const names = extractNames(`${chapter.text || ""}\n${translatedText || ""}`, 10);
  const terms = relevantTerms(glossary, chapter.text || "", 12);
  return {
    chapterIndex: Number(chapter.originalIndex ?? chapter.index ?? 0),
    title: chapter.title || "未命名章节",
    summary: firstSentences(text, 360) || "暂无可用摘要。",
    characters: names,
    terms: terms.map((term) => ({
      source: term.source,
      target: term.target,
      note: term.note
    })),
    updatedAt: new Date().toISOString()
  };
}

function buildChapterSummaries(job) {
  const summaries = [];
  for (const chapter of job.chapters || []) {
    const translatedText = (job.segments || [])
      .filter((segment) => segment.chapterIndex === chapter.originalIndex)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map((segment) => segment.translatedText || "")
      .filter(Boolean)
      .join("\n\n");
    if (!translatedText) continue;
    summaries.push(summarizeChapter({ chapter, translatedText, glossary: job.config?.glossary || "" }));
  }
  return summaries;
}

function consistencyIssues(job) {
  const glossary = parseGlossary(job.config?.glossary || "");
  const issues = [];
  for (const term of glossary) {
    if (!term.target) continue;
    const seenSource = [];
    const missingTarget = [];
    for (const segment of job.segments || []) {
      if (!String(segment.text || "").includes(term.source)) continue;
      seenSource.push(segment);
      if (!String(segment.translatedText || "").includes(term.target)) missingTarget.push(segment);
    }
    if (seenSource.length >= 2 && missingTarget.length > 0) {
      issues.push({
        type: "consistency",
        severity: "warning",
        source: term.source,
        target: term.target,
        message: `术语「${term.source}」在 ${seenSource.length} 个片段出现，其中 ${missingTarget.length} 个片段未使用「${term.target}」。`,
        locations: missingTarget.slice(0, 8).map((segment) => ({
          chapterIndex: segment.chapterIndex,
          chapterTitle: segment.chapterTitle,
          segmentIndex: segment.segmentIndex
        }))
      });
    }
  }
  return issues;
}

module.exports = {
  summarizeChapter,
  buildChapterSummaries,
  consistencyIssues
};
