const { glossaryUsageIssues } = require("./glossary");

function countCjk(text) {
  return (String(text || "").match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
}

function countParagraphs(text) {
  return String(text || "")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function repeatedLineIssues(translatedText) {
  const lines = String(translatedText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 3)
    .slice(0, 5)
    .map(([line, count]) => ({
      type: "repetition",
      severity: "warning",
      message: `译文中疑似重复输出 ${count} 次：${line.slice(0, 60)}`
    }));
}

function checkSegment({ sourceText, translatedText, glossary, preserveParagraphs }) {
  const issues = [];
  const source = String(sourceText || "");
  const translated = String(translatedText || "");
  if (!translated.trim()) {
    issues.push({ type: "empty", severity: "error", message: "译文为空。" });
    return issues;
  }

  const ratio = translated.length / Math.max(1, source.length);
  if (ratio < 0.18) issues.push({ type: "length", severity: "warning", message: "译文长度明显偏短，可能漏译。" });
  if (ratio > 4.2) issues.push({ type: "length", severity: "warning", message: "译文长度明显偏长，可能出现解释或重复。" });

  const sourceCjk = countCjk(source);
  const translatedCjk = countCjk(translated);
  if (sourceCjk > 20 && translatedCjk > sourceCjk * 0.9 && /[ぁ-んァ-ン]/.test(source)) {
    issues.push({ type: "untranslated", severity: "warning", message: "译文中仍有较多日文字符，可能存在未翻译内容。" });
  }

  if (preserveParagraphs) {
    const sourceParas = countParagraphs(source);
    const translatedParas = countParagraphs(translated);
    if (sourceParas >= 2 && Math.abs(sourceParas - translatedParas) > Math.max(2, Math.ceil(sourceParas * 0.35))) {
      issues.push({
        type: "format",
        severity: "warning",
        message: `段落数量差异较大：原文 ${sourceParas} 段，译文 ${translatedParas} 段。`
      });
    }
  }

  if (/^(sure|here is|以下是|当然|翻译如下)[:：\s]/i.test(translated.trim())) {
    issues.push({ type: "instruction", severity: "warning", message: "译文疑似包含模型解释性开头。" });
  }

  issues.push(...glossaryUsageIssues(glossary, source, translated));
  issues.push(...repeatedLineIssues(translated));
  return issues;
}

function checkJob(job) {
  const issues = [];
  for (const segment of job.segments || []) {
    if (segment.status !== "completed" && segment.status !== "cached") continue;
    const segmentIssues = checkSegment({
      sourceText: segment.text,
      translatedText: segment.translatedText,
      glossary: job.config?.glossary || "",
      preserveParagraphs: job.config?.preserveParagraphs !== false
    });
    for (const issue of segmentIssues) {
      issues.push({
        ...issue,
        chapterIndex: segment.chapterIndex,
        chapterTitle: segment.chapterTitle,
        segmentIndex: segment.segmentIndex,
        segmentId: segment.id
      });
    }
  }
  return issues;
}

module.exports = {
  checkSegment,
  checkJob
};
