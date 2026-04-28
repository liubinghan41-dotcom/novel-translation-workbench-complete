function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function emptyUsage(extra = {}) {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...extra
  };
}

function tokenSum(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + toNumber(item?.tokenCount ?? item?.tokens ?? item?.count), 0);
}

function fromParts({ inputTokens, uncachedInputTokens, cachedInputTokens, cacheCreationInputTokens, outputTokens, totalTokens, extra }) {
  const cached = toNumber(cachedInputTokens);
  const cacheCreation = toNumber(cacheCreationInputTokens);
  const uncached =
    uncachedInputTokens == null
      ? Math.max(0, toNumber(inputTokens) - cached)
      : toNumber(uncachedInputTokens);
  const input = inputTokens == null ? uncached + cached : Math.max(toNumber(inputTokens), uncached + cached);
  const output = toNumber(outputTokens);
  return emptyUsage({
    inputTokens: input,
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    cacheCreationInputTokens: cacheCreation,
    outputTokens: output,
    totalTokens: totalTokens == null ? input + output : Math.max(toNumber(totalTokens), input + output),
    ...(extra || {})
  });
}

function normalizeOpenAiUsage(rawUsage) {
  const details = rawUsage.prompt_tokens_details || rawUsage.promptTokensDetails || rawUsage.input_tokens_details || {};
  const cached =
    toNumber(details.cached_tokens) ||
    toNumber(details.cachedTokens) ||
    toNumber(rawUsage.prompt_cache_hit_tokens) ||
    toNumber(rawUsage.promptCacheHitTokens) ||
    toNumber(rawUsage.cached_tokens) ||
    toNumber(rawUsage.cachedTokens);
  const prompt = toNumber(rawUsage.prompt_tokens ?? rawUsage.promptTokens ?? rawUsage.input_tokens ?? rawUsage.inputTokens ?? rawUsage.prompt_eval_count);
  const miss =
    rawUsage.prompt_cache_miss_tokens != null || rawUsage.promptCacheMissTokens != null
      ? toNumber(rawUsage.prompt_cache_miss_tokens ?? rawUsage.promptCacheMissTokens)
      : Math.max(0, prompt - cached);
  return fromParts({
    inputTokens: prompt || miss + cached,
    uncachedInputTokens: miss,
    cachedInputTokens: cached,
    outputTokens: rawUsage.completion_tokens ?? rawUsage.completionTokens ?? rawUsage.output_tokens ?? rawUsage.outputTokens ?? rawUsage.eval_count,
    totalTokens: rawUsage.total_tokens ?? rawUsage.totalTokens
  });
}

function normalizeGeminiUsage(rawUsage) {
  const cached =
    toNumber(rawUsage.cachedContentTokenCount ?? rawUsage.cached_content_token_count) ||
    tokenSum(rawUsage.cacheTokensDetails) ||
    tokenSum(rawUsage.cachedContentTokenDetails);
  const prompt = toNumber(rawUsage.promptTokenCount ?? rawUsage.prompt_token_count ?? rawUsage.inputTokens ?? rawUsage.input_tokens);
  return fromParts({
    inputTokens: prompt || cached,
    cachedInputTokens: cached,
    outputTokens: rawUsage.candidatesTokenCount ?? rawUsage.candidates_token_count ?? rawUsage.outputTokenCount ?? rawUsage.output_tokens,
    totalTokens: rawUsage.totalTokenCount ?? rawUsage.total_token_count ?? rawUsage.totalTokens
  });
}

function normalizeClaudeUsage(rawUsage) {
  const input = toNumber(rawUsage.input_tokens ?? rawUsage.inputTokens);
  const cacheRead = toNumber(rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens);
  const cacheCreation = toNumber(rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationInputTokens);
  const uncached = input + cacheCreation;
  return fromParts({
    inputTokens: uncached + cacheRead,
    uncachedInputTokens: uncached,
    cachedInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    outputTokens: rawUsage.output_tokens ?? rawUsage.outputTokens
  });
}

function normalizeUsage(provider, rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return emptyUsage();
  if (
    rawUsage.inputTokens != null ||
    rawUsage.outputTokens != null ||
    rawUsage.cachedInputTokens != null ||
    rawUsage.uncachedInputTokens != null
  ) {
    return fromParts({
      inputTokens: rawUsage.inputTokens,
      uncachedInputTokens: rawUsage.uncachedInputTokens,
      cachedInputTokens: rawUsage.cachedInputTokens,
      cacheCreationInputTokens: rawUsage.cacheCreationInputTokens,
      outputTokens: rawUsage.outputTokens,
      totalTokens: rawUsage.totalTokens,
      extra: {
        cacheHit: Boolean(rawUsage.cacheHit),
        localCacheHit: Boolean(rawUsage.localCacheHit),
        estimated: Boolean(rawUsage.estimated)
      }
    });
  }
  if (provider === "gemini") return normalizeGeminiUsage(rawUsage);
  if (provider === "claude") return normalizeClaudeUsage(rawUsage);
  return normalizeOpenAiUsage(rawUsage);
}

function addUsage(left = emptyUsage(), right = emptyUsage()) {
  return emptyUsage({
    inputTokens: toNumber(left.inputTokens) + toNumber(right.inputTokens),
    uncachedInputTokens: toNumber(left.uncachedInputTokens) + toNumber(right.uncachedInputTokens),
    cachedInputTokens: toNumber(left.cachedInputTokens) + toNumber(right.cachedInputTokens),
    cacheCreationInputTokens: toNumber(left.cacheCreationInputTokens) + toNumber(right.cacheCreationInputTokens),
    outputTokens: toNumber(left.outputTokens) + toNumber(right.outputTokens),
    totalTokens: toNumber(left.totalTokens) + toNumber(right.totalTokens)
  });
}

function estimateTextTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  const cjk = (value.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
  const whitespace = (value.match(/\s/g) || []).length;
  const other = Math.max(0, value.length - cjk - whitespace);
  return Math.max(1, Math.ceil(cjk * 0.9 + other / 4));
}

function estimateSegmentsUsage(segments = [], options = {}) {
  const promptOverheadTokens = Math.max(0, toNumber(options.promptOverheadTokens ?? 280));
  const outputRatio = Number.isFinite(Number(options.outputRatio)) && Number(options.outputRatio) > 0 ? Number(options.outputRatio) : 1.15;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const segment of segments || []) {
    const sourceTokens =
      segment?.tokens != null || segment?.inputTokens != null
        ? toNumber(segment.tokens ?? segment.inputTokens)
        : estimateTextTokens(segment?.text || "");
    if (!sourceTokens) continue;
    inputTokens += sourceTokens + promptOverheadTokens;
    outputTokens += Math.ceil(sourceTokens * outputRatio);
  }
  return fromParts({
    inputTokens,
    uncachedInputTokens: inputTokens,
    outputTokens,
    extra: { estimated: true }
  });
}

module.exports = {
  emptyUsage,
  normalizeUsage,
  addUsage,
  estimateTextTokens,
  estimateSegmentsUsage
};
