const { emptyUsage, addUsage, estimateSegmentsUsage, normalizeUsage } = require("./usage");

const OFFICIAL_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  claude: "https://api.anthropic.com/v1"
};

const OFFICIAL_PRICES = [
  { provider: "openai", models: ["gpt-5.5"], inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 30 },
  { provider: "openai", models: ["gpt-5.4"], inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15 },
  { provider: "openai", models: ["gpt-5.4-mini"], inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 },
  { provider: "openai", models: ["gpt-4.1"], inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 8 },
  { provider: "openai", models: ["gpt-4.1-mini"], inputPer1M: 0.4, cachedInputPer1M: 0.1, outputPer1M: 1.6 },
  { provider: "openai", models: ["gpt-4.1-nano"], inputPer1M: 0.1, cachedInputPer1M: 0.025, outputPer1M: 0.4 },
  { provider: "deepseek", models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"], inputPer1M: 0.14, cachedInputPer1M: 0.0028, outputPer1M: 0.28 },
  { provider: "deepseek", models: ["deepseek-v4-pro"], inputPer1M: 0.435, cachedInputPer1M: 0.003625, outputPer1M: 0.87 },
  { provider: "gemini", models: ["gemini-2.5-flash-lite"], inputPer1M: 0.1, cachedInputPer1M: 0.01, outputPer1M: 0.4 },
  { provider: "gemini", models: ["gemini-2.5-flash"], inputPer1M: 0.3, cachedInputPer1M: 0.03, outputPer1M: 2.5 },
  { provider: "claude", models: ["claude-4-5-haiku", "claude-haiku-4-5"], inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 5 },
  { provider: "claude", models: ["claude-3-5-haiku"], inputPer1M: 0.8, cachedInputPer1M: 0.08, outputPer1M: 4 },
  { provider: "claude", models: ["claude-sonnet-4", "claude-4-sonnet", "claude-3-7-sonnet"], inputPer1M: 3, cachedInputPer1M: 0.3, outputPer1M: 15 },
  { provider: "claude", models: ["claude-opus-4"], inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 25 }
];

function normalizeProvider(provider) {
  return String(provider || "openai-compatible").trim().toLowerCase();
}

function normalizeModelId(model) {
  return String(model || "")
    .trim()
    .replace(/^models\//, "")
    .toLowerCase();
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function pricingKey(provider, baseUrl, model) {
  return `${normalizeProvider(provider)}|${normalizeBaseUrl(baseUrl)}|${normalizeModelId(model)}`;
}

function toPrice(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeRates(value = {}) {
  const inputPer1M = toPrice(value.inputPer1M);
  const cachedInputPer1M = toPrice(value.cachedInputPer1M);
  const outputPer1M = toPrice(value.outputPer1M);
  if (inputPer1M == null && cachedInputPer1M == null && outputPer1M == null) return null;
  return { inputPer1M, cachedInputPer1M, outputPer1M };
}

function officialProviderFor(provider, baseUrl) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (OFFICIAL_BASE_URLS[normalizedProvider] && normalizeBaseUrl(OFFICIAL_BASE_URLS[normalizedProvider]) === normalizedBaseUrl) {
    return normalizedProvider;
  }
  return null;
}

function matchesModel(model, pattern) {
  const normalized = normalizeModelId(model);
  const target = normalizeModelId(pattern);
  return normalized === target || normalized.startsWith(`${target}-`) || normalized.startsWith(`${target}@`);
}

function findOfficialPricing(provider, baseUrl, model) {
  const officialProvider = officialProviderFor(provider, baseUrl);
  if (!officialProvider || !model) return null;
  let best = null;
  for (const item of OFFICIAL_PRICES) {
    if (item.provider !== officialProvider) continue;
    for (const pattern of item.models) {
      if (!matchesModel(model, pattern)) continue;
      const length = normalizeModelId(pattern).length;
      if (!best || length > best.length) best = { record: item, length };
    }
  }
  const record = best?.record;
  if (!record) return null;
  return {
    provider: normalizeProvider(provider),
    baseUrl: normalizeBaseUrl(baseUrl),
    model: normalizeModelId(model),
    source: "official",
    currency: "USD",
    inputPer1M: record.inputPer1M,
    cachedInputPer1M: record.cachedInputPer1M,
    outputPer1M: record.outputPer1M
  };
}

function findOverride(pricingOverrides, provider, baseUrl, model) {
  if (!pricingOverrides || typeof pricingOverrides !== "object") return null;
  const key = pricingKey(provider, baseUrl, model);
  return normalizeRates(pricingOverrides[key] || null);
}

function getPricing({ provider, baseUrl, model, pricingOverrides } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl || OFFICIAL_BASE_URLS[normalizedProvider] || "");
  const normalizedModel = normalizeModelId(model);
  const key = pricingKey(normalizedProvider, normalizedBaseUrl, normalizedModel);

  if (normalizedProvider === "demo") {
    return {
      key,
      provider: normalizedProvider,
      baseUrl: normalizedBaseUrl,
      model: normalizedModel,
      source: "free",
      currency: "USD",
      inputPer1M: 0,
      cachedInputPer1M: 0,
      outputPer1M: 0
    };
  }

  const official = findOfficialPricing(normalizedProvider, normalizedBaseUrl, normalizedModel);
  const override = findOverride(pricingOverrides, normalizedProvider, normalizedBaseUrl, normalizedModel);
  if (override) {
    return {
      ...(official || {}),
      key,
      provider: normalizedProvider,
      baseUrl: normalizedBaseUrl,
      model: normalizedModel,
      source: official ? "override+official" : "override",
      currency: "USD",
      inputPer1M: override.inputPer1M ?? official?.inputPer1M ?? null,
      cachedInputPer1M: override.cachedInputPer1M ?? official?.cachedInputPer1M ?? override.inputPer1M ?? official?.inputPer1M ?? null,
      outputPer1M: override.outputPer1M ?? official?.outputPer1M ?? null
    };
  }

  if (official) return { ...official, key };
  return {
    key,
    provider: normalizedProvider,
    baseUrl: normalizedBaseUrl,
    model: normalizedModel,
    source: "missing",
    currency: "USD",
    inputPer1M: null,
    cachedInputPer1M: null,
    outputPer1M: null,
    warning: "No pricing configured for this provider/baseUrl/model."
  };
}

function emptyCost(pricing = null, extra = {}) {
  return {
    currency: "USD",
    input: 0,
    cachedInput: 0,
    output: 0,
    total: 0,
    priceUnavailable: false,
    pricing: pricing || null,
    ...extra
  };
}

function zeroCost(pricing = null, reason = "zero") {
  return emptyCost(pricing, { reason });
}

function calculateCost(usage = emptyUsage(), pricing = null) {
  const rates = pricing || {};
  if (rates.inputPer1M == null || rates.cachedInputPer1M == null || rates.outputPer1M == null) {
    return {
      currency: "USD",
      input: null,
      cachedInput: null,
      output: null,
      total: null,
      priceUnavailable: true,
      pricing: pricing || null
    };
  }
  const input = (Number(usage.uncachedInputTokens || 0) / 1_000_000) * Number(rates.inputPer1M || 0);
  const cachedInput = (Number(usage.cachedInputTokens || 0) / 1_000_000) * Number(rates.cachedInputPer1M || 0);
  const output = (Number(usage.outputTokens || 0) / 1_000_000) * Number(rates.outputPer1M || 0);
  return {
    currency: rates.currency || "USD",
    input,
    cachedInput,
    output,
    total: input + cachedInput + output,
    priceUnavailable: false,
    pricing: rates
  };
}

function addCost(left = emptyCost(), right = emptyCost()) {
  const unavailable = Boolean(left.priceUnavailable || right?.priceUnavailable || right?.total == null);
  return {
    currency: left.currency || right?.currency || "USD",
    input: Number(left.input || 0) + Number(right?.input || 0),
    cachedInput: Number(left.cachedInput || 0) + Number(right?.cachedInput || 0),
    output: Number(left.output || 0) + Number(right?.output || 0),
    total: unavailable ? null : Number(left.total || 0) + Number(right?.total || 0),
    knownTotal: Number(left.knownTotal ?? left.total ?? 0) + Number(right?.total || 0),
    priceUnavailable: unavailable
  };
}

function estimateTranslationCost(payload = {}) {
  const pricing = getPricing(payload);
  const usage =
    payload.usage && typeof payload.usage === "object"
      ? normalizeUsage(payload.provider, payload.usage)
      : estimateSegmentsUsage(payload.segments || [], payload.estimateOptions || {});
  return {
    provider: normalizeProvider(payload.provider),
    baseUrl: normalizeBaseUrl(payload.baseUrl),
    model: normalizeModelId(payload.model),
    pricing,
    usage,
    cost: calculateCost(usage, pricing),
    estimated: true
  };
}

module.exports = {
  OFFICIAL_BASE_URLS,
  normalizeProvider,
  normalizeModelId,
  normalizeBaseUrl,
  pricingKey,
  getPricing,
  calculateCost,
  addCost,
  zeroCost,
  estimateTranslationCost,
  addUsage
};
