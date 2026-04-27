const fs = require("fs");
const crypto = require("crypto");
const { cacheFile, ensureDir, CACHE_DIR, readJson, atomicWriteJson, nowIso, cacheStats } = require("./storage");

const CACHE_VERSION = 1;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function publicPreset(preset) {
  if (!preset) return null;
  return {
    id: preset.id || "",
    name: preset.name || "",
    temperature: Number(preset.temperature ?? 0.35),
    prompt: preset.prompt || ""
  };
}

function buildCacheInput(payload) {
  return {
    version: CACHE_VERSION,
    provider: payload.provider || "",
    model: payload.model || "",
    baseUrl: payload.baseUrl || "",
    sourceLanguage: payload.sourceLanguage || "",
    targetLanguage: payload.targetLanguage || "",
    temperature: Number(payload.temperature ?? payload.preset?.temperature ?? 0.35),
    maxTokens: Number(payload.maxTokens || 0),
    preset: publicPreset(payload.preset),
    promptOptions: payload.promptOptions || {},
    glossary: payload.glossary || "",
    context: payload.context || "",
    chapterSummaries: payload.chapterSummaries || [],
    contextBank: payload.contextBank || [],
    text: payload.text || ""
  };
}

function buildCacheKey(payload) {
  return crypto.createHash("sha256").update(stableStringify(buildCacheInput(payload))).digest("hex");
}

async function getCachedTranslation(cacheKey) {
  const entry = await readJson(cacheFile(cacheKey), null);
  if (!entry || entry.version !== CACHE_VERSION || typeof entry.text !== "string") return null;
  return entry;
}

async function setCachedTranslation(cacheKey, payload, translated) {
  await ensureDir(CACHE_DIR);
  const entry = {
    version: CACHE_VERSION,
    key: cacheKey,
    createdAt: nowIso(),
    provider: payload.provider || "",
    model: payload.model || "",
    sourceLanguage: payload.sourceLanguage || "",
    targetLanguage: payload.targetLanguage || "",
    text: String(translated.text || ""),
    usage: translated.usage || null
  };
  await atomicWriteJson(cacheFile(cacheKey), entry);
  return entry;
}

async function clearCacheEntry(cacheKey) {
  await fs.promises.rm(cacheFile(cacheKey), { force: true });
}

module.exports = {
  CACHE_VERSION,
  buildCacheKey,
  getCachedTranslation,
  setCachedTranslation,
  clearCacheEntry,
  cacheStats
};
