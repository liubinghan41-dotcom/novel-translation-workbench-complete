const { parseGlossary, relevantTerms, formatGlossaryTerms } = require("./glossary");

function estimateTokens(text) {
  const value = String(text || "");
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const ascii = value.length - cjk;
  return Math.ceil(cjk * 0.8 + ascii / 4);
}

function trimToBudget(text, maxTokens) {
  const value = String(text || "").trim();
  if (!value || !maxTokens) return "";
  const approxChars = Math.max(160, Math.floor(maxTokens * 3.2));
  if (value.length <= approxChars) return value;
  return `${value.slice(0, approxChars).trim()}...`;
}

function tokenize(text) {
  return Array.from(
    new Set(
      String(text || "")
        .toLowerCase()
        .match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\w]{2,}/gu) || []
    )
  );
}

function scoreText(queryTokens, text) {
  if (!queryTokens.length) return 0;
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += Math.min(6, token.length);
  }
  return score;
}

function retrieveContextItems(contextBank, queryText, limit = 5) {
  const queryTokens = tokenize(queryText);
  return (Array.isArray(contextBank) ? contextBank : [])
    .map((item, index) => ({
      ...item,
      index,
      score: scoreText(queryTokens, `${item.title || ""}\n${item.text || item.content || ""}`)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
}

function buildPromptContext(payload) {
  const options = payload.promptOptions || {};
  const glossaryLimit = Math.max(0, Number(options.glossaryLimit ?? 80));
  const summaryBudget = Math.max(0, Number(options.summaryTokens ?? 350));
  const retrievalBudget = Math.max(0, Number(options.retrievalTokens ?? 320));
  const relevant = relevantTerms(payload.glossary, payload.text, glossaryLimit);
  const summaries = Array.isArray(payload.chapterSummaries) ? payload.chapterSummaries : [];
  const currentSummary = summaries.find((summary) => summary.chapterIndex === payload.chapterIndex);
  const previousSummaries = summaries
    .filter((summary) => summary.chapterIndex < payload.chapterIndex)
    .slice(-3)
    .map((summary) => `${summary.title || `第 ${summary.chapterIndex + 1} 章`}：${summary.summary}`)
    .join("\n");
  const retrieved = retrieveContextItems(payload.contextBank, payload.text, Number(options.retrievalCount ?? 5));
  const retrievedText = retrieved
    .map((item) => `- ${item.title || `资料 ${item.index + 1}`}：${item.text || item.content || ""}`)
    .join("\n");

  return {
    glossaryText: formatGlossaryTerms(relevant.length ? relevant : parseGlossary(payload.glossary).slice(0, glossaryLimit)),
    summaryText: trimToBudget(
      [
        payload.context || "",
        currentSummary?.summary ? `当前章节摘要：${currentSummary.summary}` : "",
        previousSummaries ? `前文摘要：\n${previousSummaries}` : ""
      ]
        .filter(Boolean)
        .join("\n\n"),
      summaryBudget
    ) || "无",
    retrievalText: trimToBudget(retrievedText, retrievalBudget) || "无",
    tokenEstimate: {
      glossary: estimateTokens(formatGlossaryTerms(relevant)),
      summary: estimateTokens(previousSummaries),
      retrieval: estimateTokens(retrievedText)
    },
    relevantTerms: relevant,
    retrieved
  };
}

module.exports = {
  estimateTokens,
  trimToBudget,
  retrieveContextItems,
  buildPromptContext
};
