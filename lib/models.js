const { OFFICIAL_BASE_URLS, normalizeProvider, normalizeModelId } = require("./pricing");

const DEFAULT_BASE_URLS = {
  ...OFFICIAL_BASE_URLS,
  "openai-compatible": "http://localhost:11434/v1",
  demo: ""
};

function defaultBaseUrl(provider) {
  return DEFAULT_BASE_URLS[normalizeProvider(provider)] || "";
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

function requireApiKey(provider, apiKey) {
  if (provider === "demo" || provider === "openai-compatible") return;
  if (!apiKey) throw new Error(`${provider} requires an API key to refresh models.`);
}

function modelFromItem(provider, item) {
  if (typeof item === "string") {
    const id = provider === "gemini" ? normalizeModelId(item) : item.trim();
    return id ? { id, label: id } : null;
  }
  if (!item || typeof item !== "object") return null;
  if (
    provider === "gemini" &&
    Array.isArray(item.supportedGenerationMethods) &&
    !item.supportedGenerationMethods.includes("generateContent")
  ) {
    return null;
  }
  const rawId = item.id || item.name || item.model || item.display_name || item.displayName;
  const id = provider === "gemini" ? normalizeModelId(rawId) : String(rawId || "").trim();
  if (!id) return null;
  return {
    id,
    label: item.display_name || item.displayName || item.name || id,
    description: item.description || "",
    ownedBy: item.owned_by || item.ownedBy || ""
  };
}

function extractModelItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function normalizeModels(provider, data) {
  const seen = new Set();
  const models = [];
  for (const item of extractModelItems(data)) {
    const model = modelFromItem(provider, item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function parseResponse(response) {
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(`Model API ${response.status} ${response.statusText}: ${raw.slice(0, 1200)}`);
  }
  return data;
}

async function fetchModels(payload = {}) {
  const provider = normalizeProvider(payload.provider);
  const apiKey = String(payload.apiKey || "").trim();
  if (provider === "demo") {
    return {
      provider,
      baseUrl: "",
      models: [{ id: "demo-translator", label: "Demo translator" }]
    };
  }

  requireApiKey(provider, apiKey);
  const baseUrl = String(payload.baseUrl || defaultBaseUrl(provider)).trim();
  if (!baseUrl) throw new Error("Base URL is required to refresh models.");
  if (!globalThis.fetch) throw new Error("Current Node version does not provide fetch. Please use Node 18 or newer.");

  let url = joinUrl(baseUrl, "/models");
  const headers = {};
  if (provider === "gemini") {
    url = `${url}?key=${encodeURIComponent(apiKey)}`;
  } else if (provider === "claude") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = payload.anthropicVersion || "2023-06-01";
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, { method: "GET", headers });
  const data = await parseResponse(response);
  return {
    provider,
    baseUrl,
    models: normalizeModels(provider, data)
  };
}

module.exports = {
  DEFAULT_BASE_URLS,
  defaultBaseUrl,
  joinUrl,
  normalizeModelId,
  fetchModels
};
