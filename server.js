const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { TextDecoder } = require("util");

const { ROOT_DIR, initStorage, listProjects, getProject, saveProject } = require("./lib/storage");
const { buildCacheKey, getCachedTranslation, setCachedTranslation, cacheStats } = require("./lib/cache");
const { createJobManager } = require("./lib/jobs");
const { buildPromptContext } = require("./lib/context-bank");
const { parseGlossary, relevantTerms, formatGlossaryTerms } = require("./lib/glossary");
const { defaultBaseUrl, fetchModels } = require("./lib/models");
const { estimateTranslationCost } = require("./lib/pricing");
const { emptyUsage, normalizeUsage } = require("./lib/usage");

const PORT = Number(process.env.PORT || 4173);
const MAX_BODY_BYTES = 120 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const DEFAULT_PROMPT =
  "你是专业文学翻译。请把{{sourceLanguage}}小说翻译为{{targetLanguage}}，保持人物称呼、段落结构和叙事语气一致。只输出译文，不要解释。";

let jobManager;

function corsHeaders(res) {
  const origin = res._requestOrigin;
  const allowedOrigin =
    !origin ||
    origin === "null" ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)
      ? origin || "*"
      : "http://localhost";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    Vary: "Origin"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(res)
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, detail) {
  sendJson(res, status, {
    error: message,
    detail: detail ? String(detail).slice(0, 4000) : undefined
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const safePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(ROOT_DIR, safePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    sendError(res, 403, "禁止访问工作区外文件");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(res, 404, "未找到文件");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function tryDecode(buffer) {
  const labels = ["utf-8", "utf-16le", "shift_jis", "euc-jp", "gb18030", "big5", "latin1"];
  let best = { label: "utf-8", text: buffer.toString("utf8"), score: Number.POSITIVE_INFINITY };
  for (const label of labels) {
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(buffer);
      const bad = (text.match(/\uFFFD/g) || []).length;
      const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g) || []).length;
      const readableCjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
      const score = bad * 1000 + controls * 60 - Math.min(readableCjk, 200) * 0.5;
      if (score < best.score) best = { label, text, score };
    } catch {
      // Some Node builds do not include every legacy encoding.
    }
  }
  return best;
}

function decodeMarkupBuffer(buffer) {
  const head = buffer.slice(0, Math.min(buffer.length, 1024)).toString("ascii");
  const declared = (head.match(/\bencoding\s*=\s*(["'])(.*?)\1/i) || head.match(/charset\s*=\s*(["']?)([^"'\s/>]+)/i))?.[2];
  const label = String(declared || "").trim().toLowerCase().replace("_", "-");
  if (label === "utf-8" || label === "utf8") return buffer.toString("utf8");
  if (label === "utf-16" || label === "utf-16le") return new TextDecoder("utf-16le").decode(buffer);
  if (label) {
    try {
      return new TextDecoder(label).decode(buffer);
    } catch {
      // Fall through to heuristic decoding for uncommon labels not present in this Node build.
    }
  }
  return tryDecode(buffer).text;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function splitPlainTextChapters(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const headingRe =
    /^\s*(第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章节回話话卷部].{0,80}|[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\s+\d+.{0,80}|序章|终章|尾声|后记|番外.{0,40})\s*$/;
  const headings = [];
  let offset = 0;
  for (const line of lines) {
    if (headingRe.test(line.trim())) headings.push({ title: line.trim(), index: offset });
    offset += line.length + 1;
  }
  if (headings.length >= 2) {
    return headings
      .map((heading, index) => {
        const next = headings[index + 1]?.index ?? normalized.length;
        return { title: heading.title || `第 ${index + 1} 章`, text: normalized.slice(heading.index, next).trim() };
      })
      .filter((chapter) => chapter.text);
  }
  const chunks = [];
  for (let index = 0; index < normalized.length; index += 9000) {
    chunks.push({ title: `第 ${chunks.length + 1} 部分`, text: normalized.slice(index, index + 9000).trim() });
  }
  return chunks.length ? chunks : [{ title: "全文", text: normalized }];
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripTags(value) {
  return htmlDecode(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractAttrs(tag) {
  const attrs = {};
  String(tag || "").replace(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g, (_, key, _quote, value) => {
    attrs[key] = htmlDecode(value);
    return "";
  });
  return attrs;
}

function extractHtmlText(htmlBuffer, fallbackTitle) {
  const decoded = decodeMarkupBuffer(htmlBuffer);
  const titleMatch =
    decoded.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) ||
    decoded.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripTags(titleMatch?.[1] || fallbackTitle);
  let text = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<(p|div|section|article|li|h[1-6]|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = normalizeText(htmlDecode(text).split("\n").map((line) => line.trim()).filter(Boolean).join("\n"));
  return { title: title || fallbackTitle, text };
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65558);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是有效的 ZIP/EPUB 文件：找不到中央目录");
}

function readZipEntries(buffer) {
  const eocd = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const nameLength = buffer.readUInt16LE(ptr + 28);
    const extraLength = buffer.readUInt16LE(ptr + 30);
    const commentLength = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.slice(ptr + 46, ptr + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 本地文件头损坏：${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, compressed);
    if (method === 8) entries.set(name, zlib.inflateRawSync(compressed));
    ptr += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function resolveZipPath(baseDir, href) {
  return path.posix.normalize(path.posix.join(baseDir, href)).replace(/^\/+/, "");
}

function parseEpub(buffer) {
  const entries = readZipEntries(buffer);
  const container = entries.get("META-INF/container.xml");
  if (!container) throw new Error("EPUB 缺少 META-INF/container.xml");
  const rootfileMatch = container.toString("utf8").match(/<rootfile\b[^>]*full-path=(["'])(.*?)\1/i);
  if (!rootfileMatch) throw new Error("EPUB container.xml 未声明 OPF 路径");
  const opfPath = rootfileMatch[2].replace(/\\/g, "/");
  const opfBuffer = entries.get(opfPath);
  if (!opfBuffer) throw new Error(`EPUB 缺少 OPF 文件：${opfPath}`);
  const opf = opfBuffer.toString("utf8");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const title = stripTags((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1]) || "未命名小说";
  const manifest = new Map();
  const spine = [];
  opf.replace(/<item\b([^>]*?)\/?>/gi, (_, rawAttrs) => {
    const attrs = extractAttrs(rawAttrs);
    if (attrs.id && attrs.href) manifest.set(attrs.id, { href: resolveZipPath(opfDir, attrs.href), mediaType: attrs["media-type"] || "" });
    return "";
  });
  opf.replace(/<itemref\b([^>]*?)\/?>/gi, (_, rawAttrs) => {
    const attrs = extractAttrs(rawAttrs);
    if (attrs.idref) spine.push(attrs.idref);
    return "";
  });
  const htmlPaths = spine
    .map((id) => manifest.get(id))
    .filter((item) => item && /x?html/i.test(item.mediaType))
    .map((item) => item.href);
  if (!htmlPaths.length) {
    for (const item of manifest.values()) {
      if (/x?html/i.test(item.mediaType)) htmlPaths.push(item.href);
    }
  }
  const chapters = htmlPaths
    .map((chapterPath, index) => {
      const html = entries.get(chapterPath);
      if (!html) return null;
      const parsed = extractHtmlText(html, `第 ${index + 1} 章`);
      return { title: parsed.title || `第 ${index + 1} 章`, text: parsed.text, sourcePath: chapterPath, epubSpineIndex: index };
    })
    .filter((chapter) => chapter && chapter.text);
  if (!chapters.length) throw new Error("EPUB 中没有可解析的 XHTML 章节");
  return {
    title,
    chapters,
    metadata: {
      format: "epub",
      files: entries.size,
      originalEpubBase64: buffer.toString("base64"),
      opfPath,
      spineHtmlPaths: htmlPaths
    }
  };
}

function parseBook({ name, contentBase64 }) {
  const buffer = Buffer.from(contentBase64 || "", "base64");
  const ext = path.extname(name || "").toLowerCase();
  if (ext === ".epub") return parseEpub(buffer);
  if (ext === ".txt" || !ext) {
    const decoded = tryDecode(buffer);
    return {
      title: path.basename(name || "未命名小说", ext || ".txt"),
      chapters: splitPlainTextChapters(decoded.text),
      metadata: { format: "txt", encoding: decoded.label }
    };
  }
  throw new Error("当前支持 .txt 与 .epub");
}

function chunkText(text, maxChars, preserveParagraphs) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  if (!preserveParagraphs) {
    const chunks = [];
    for (let i = 0; i < normalized.length; i += maxChars) chunks.push(normalized.slice(i, i + maxChars));
    return chunks;
  }
  const paragraphs = normalized.split(/\n{1,}/).map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < paragraph.length; i += maxChars) chunks.push(paragraph.slice(i, i + maxChars));
      continue;
    }
    if ((current + "\n\n" + paragraph).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function renderTemplate(template, values) {
  return String(template || DEFAULT_PROMPT).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    return values[key] == null ? "" : String(values[key]);
  });
}

function buildMessages(payload) {
  const {
    sourceLanguage,
    targetLanguage,
    chapterTitle,
    segmentIndex,
    segmentsTotal,
    glossary,
    context,
    text,
    preset
  } = payload;
  const promptContext = buildPromptContext(payload);
  const template = preset?.prompt || DEFAULT_PROMPT;
  const values = {
    sourceLanguage,
    targetLanguage,
    chapterTitle,
    segmentIndex,
    segmentsTotal,
    glossary: promptContext.glossaryText || glossary || "无",
    context: promptContext.summaryText || context || "无",
    retrieval: promptContext.retrievalText || "无",
    text
  };
  if (template.includes("{{text}}")) {
    return {
      system: "你是一个严格遵守用户翻译模板的文学翻译助手。只输出最终译文。",
      user: renderTemplate(template, values)
    };
  }
  const system = renderTemplate(template, values);
  const user = [
    `章节：${chapterTitle || "未命名章节"}`,
    `片段：${segmentIndex || 1}/${segmentsTotal || 1}`,
    `源语言：${sourceLanguage || "自动识别"}`,
    `目标语言：${targetLanguage || "中文"}`,
    `术语表：\n${promptContext.glossaryText || glossary || "无"}`,
    `上下文摘要：\n${promptContext.summaryText || context || "无"}`,
    `相关资料：\n${promptContext.retrievalText || "无"}`,
    "待翻译文本：",
    text
  ].join("\n\n");
  return { system, user };
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

async function parseProviderResponse(provider, response) {
  const raw = await response.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(`API ${response.status} ${response.statusText}: ${raw.slice(0, 2000)}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (provider === "gemini") {
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    const rawUsage = data?.usageMetadata || null;
    return { text, usage: normalizeUsage(provider, rawUsage), rawUsage, raw: data };
  }
  if (provider === "claude") {
    const text = data?.content?.map((part) => part.text || "").join("") || "";
    const rawUsage = data?.usage || null;
    return { text, usage: normalizeUsage(provider, rawUsage), rawUsage, raw: data };
  }
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  const rawUsage = data?.usage || null;
  return { text, usage: normalizeUsage(provider, rawUsage), rawUsage, raw: data };
}

async function translateSegment(payload) {
  const provider = payload.provider || "openai-compatible";
  let model = String(payload.model || "").trim();
  if (provider === "gemini") model = model.replace(/^models\//, "");
  const temperature = Number(payload.temperature ?? payload.preset?.temperature ?? 0.35);
  const apiKey = payload.apiKey || "";
  const { system, user } = buildMessages(payload);

  if (provider === "demo") {
    const prefix = `【Demo 译文｜${payload.targetLanguage || "中文"}｜${payload.preset?.name || "默认预设"}】`;
    return {
      text: `${prefix}\n${String(payload.text || "")
        .split("\n")
        .filter(Boolean)
        .map((line) => `译：${line}`)
        .join("\n")}`,
      usage: emptyUsage({ mode: "demo" }),
      provider
    };
  }

  if (!model) {
    const error = new Error("请先选择或手动输入 model id");
    error.retryable = false;
    throw error;
  }

  if (!globalThis.fetch) throw new Error("当前 Node 版本缺少 fetch，请使用 Node 18 或更新版本");

  if (provider === "gemini") {
    if (!apiKey) {
      const error = new Error("Gemini 需要 API Key");
      error.retryable = false;
      throw error;
    }
    const baseUrl = payload.baseUrl || defaultBaseUrl(provider);
    const url = `${joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature }
      })
    });
    return { ...(await parseProviderResponse(provider, response)), provider };
  }

  if (provider === "claude") {
    if (!apiKey) {
      const error = new Error("Claude 需要 API Key");
      error.retryable = false;
      throw error;
    }
    const baseUrl = payload.baseUrl || defaultBaseUrl(provider);
    const response = await fetch(joinUrl(baseUrl, "/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: Number(payload.maxTokens || 4096),
        temperature,
        system,
        messages: [{ role: "user", content: user }]
      })
    });
    return { ...(await parseProviderResponse(provider, response)), provider };
  }

  if ((provider === "openai" || provider === "deepseek") && !apiKey) {
    const error = new Error(`${provider} 需要 API Key`);
    error.retryable = false;
    throw error;
  }
  const baseUrl = payload.baseUrl || defaultBaseUrl(provider) || defaultBaseUrl("openai-compatible");
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(joinUrl(baseUrl, "/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  return { ...(await parseProviderResponse(provider, response)), provider };
}

async function translateSegmentWithCache(payload) {
  const cacheKey = buildCacheKey(payload);
  if (payload.useCache !== false) {
    const cached = await getCachedTranslation(cacheKey);
    if (cached) {
      return {
        text: cached.text,
        usage: normalizeUsage(payload.provider, cached.usage),
        provider: payload.provider,
        cacheHit: true
      };
    }
  }
  const translated = await translateSegment(payload);
  if (payload.useCache !== false && translated.text) await setCachedTranslation(cacheKey, payload, translated);
  return { ...translated, cacheHit: false };
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    localParts.push(local, data);
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

function stripDangerousAttrs(attrs) {
  return String(attrs || "")
    .replace(/\s(?:id|name)\s*=\s*(["']).*?\1/gi, "")
    .replace(/\s(?:id|name)\s*=\s*[^\s>]+/gi, "");
}

function appendClass(attrs, className) {
  const safeAttrs = stripDangerousAttrs(attrs);
  if (/\sclass\s*=/i.test(safeAttrs)) {
    return safeAttrs.replace(/(\sclass\s*=\s*)(["'])(.*?)\2/i, (_, prefix, quote, value) => {
      const classes = String(value || "").split(/\s+/).filter(Boolean);
      if (!classes.includes(className)) classes.push(className);
      return `${prefix}${quote}${classes.join(" ")}${quote}`;
    });
  }
  return `${safeAttrs} class="${className}"`;
}

function splitTranslatedParagraphs(text) {
  return String(text || "")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function paragraphHtml(text, attrs = "") {
  return `<p${appendClass(attrs, "ntw-translation")}>${xmlEscape(text).replace(/\n/g, "<br />")}</p>`;
}

function protectedRanges(body) {
  const ranges = [];
  const patterns = [
    /<(aside|section|div)\b[^>]*(?:epub:type|class|id)\s*=\s*(["'])[^"']*(?:footnote|endnote|rearnote|note)[^"']*\2[^>]*>[\s\S]*?<\/\1>/gi,
    /<(aside|section|div)\b[^>]*(?:epub:type|class|id)\s*=\s*[^\s>]*(?:footnote|endnote|rearnote|note)[^\s>]*[^>]*>[\s\S]*?<\/\1>/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body))) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function inRanges(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function htmlText(value) {
  return stripTags(String(value || "").replace(/<rt\b[\s\S]*?<\/rt>/gi, ""));
}

function shouldTranslateBlock(attrs, inner, offset, ranges) {
  if (inRanges(offset, ranges)) return false;
  if (/\b(?:epub:type|class|id)\s*=\s*(["'])[^"']*(?:footnote|endnote|rearnote|noteref|pagebreak|toc)[^"']*\1/i.test(attrs)) return false;
  if (/\b(?:epub:type|class|id)\s*=\s*[^\s>]*(?:footnote|endnote|rearnote|noteref|pagebreak|toc)[^\s>]*/i.test(attrs)) return false;
  return Boolean(htmlText(inner).trim());
}

function ensureExportStyle(xhtml, bilingual) {
  const css = [
    ".ntw-translation{margin-top:.15em;color:#1f2937;}",
    bilingual ? ".ntw-source{margin-bottom:.15em;}" : "",
    bilingual ? ".ntw-translation{border-left:2px solid #9ca3af;padding-left:.65em;}" : ""
  ].filter(Boolean).join("");
  const style = `<style type="text/css">${css}</style>`;
  if (/<\/head>/i.test(xhtml)) return xhtml.replace(/<\/head>/i, `${style}</head>`);
  return xhtml.replace(/<html\b([^>]*)>/i, `<html$1><head>${style}</head>`);
}

function transformChapterXhtml(rawHtml, chapter, options = {}) {
  const rawBuffer = Buffer.isBuffer(rawHtml) ? rawHtml : Buffer.from(String(rawHtml), "utf8");
  let xhtml = decodeMarkupBuffer(rawBuffer);
  const translated = splitTranslatedParagraphs(chapter.text || chapter.translatedText || "");
  if (!translated.length) return xhtml;

  const bodyMatch = xhtml.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return xhtml;
  const bodyStart = bodyMatch.index + bodyMatch[0].indexOf(">") + 1;
  const body = bodyMatch[2];
  const ranges = protectedRanges(body);
  let used = 0;
  let changed = false;
  const blockRe = /<(p|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const transformed = body.replace(blockRe, (full, tag, attrs, inner, offset) => {
    if (!shouldTranslateBlock(attrs, inner, offset, ranges)) return full;
    const translatedParagraph = translated[used++];
    if (!translatedParagraph) return full;
    changed = true;
    if (options.bilingual) {
      const source = `<${tag}${appendClass(attrs, "ntw-source")}>${inner}</${tag}>`;
      return `${source}\n${paragraphHtml(translatedParagraph, attrs)}`;
    }
    return `<${tag}${attrs}>${xmlEscape(translatedParagraph).replace(/\n/g, "<br />")}</${tag}>`;
  });
  const extras = translated.slice(used).map((line) => paragraphHtml(line)).join("\n");
  const nextBody = changed ? `${transformed}${extras ? `\n${extras}` : ""}` : `${body}\n${extras}`;
  xhtml = `${xhtml.slice(0, bodyStart)}${nextBody}${xhtml.slice(bodyStart + body.length)}`;
  return ensureExportStyle(xhtml, Boolean(options.bilingual));
}

function resolveChapterSourcePath(payloadChapter, book, index) {
  if (payloadChapter?.sourcePath) return payloadChapter.sourcePath;
  const originalIndex = Number(payloadChapter?.originalIndex ?? payloadChapter?.chapterIndex ?? index);
  return book?.chapters?.[originalIndex]?.sourcePath || book?.metadata?.spineHtmlPaths?.[index] || "";
}

function createPreservedEpub(payload) {
  const book = payload.book || {};
  const sourceBase64 = book.metadata?.originalEpubBase64;
  if (!sourceBase64) return null;
  const entries = readZipEntries(Buffer.from(sourceBase64, "base64"));
  const chapterMap = new Map();
  (payload.chapters || []).forEach((chapter, index) => {
    const sourcePath = resolveChapterSourcePath(chapter, book, index);
    if (sourcePath) chapterMap.set(sourcePath.replace(/\\/g, "/"), chapter);
  });
  if (!chapterMap.size) return null;

  const files = [];
  const mimetype = entries.get("mimetype") || Buffer.from("application/epub+zip", "utf8");
  files.push({ name: "mimetype", data: mimetype });

  for (const [name, data] of entries) {
    if (name === "mimetype") continue;
    const chapter = chapterMap.get(name);
    const output = chapter ? Buffer.from(transformChapterXhtml(data, chapter, { bilingual: payload.bilingual }), "utf8") : data;
    files.push({ name, data: output });
  }
  return createZip(files);
}

function createSimpleEpub({ title, chapters, bilingual }) {
  const safeTitle = xmlEscape(title || "translated-novel");
  const chapterFiles = (chapters || []).map((chapter, index) => {
    const translated = splitTranslatedParagraphs(chapter.text || chapter.translatedText || "");
    const source = splitTranslatedParagraphs(chapter.sourceText || "");
    const paragraphs = bilingual && source.length
      ? [
          ...source.map((line, lineIndex) => [
            `<p class="ntw-source">${xmlEscape(line)}</p>`,
            translated[lineIndex] ? `<p class="ntw-translation">${xmlEscape(translated[lineIndex])}</p>` : ""
          ].filter(Boolean).join("\n")),
          ...translated.slice(source.length).map((line) => `<p class="ntw-translation">${xmlEscape(line)}</p>`)
        ].filter(Boolean).join("\n")
      : translated.map((line) => `<p class="ntw-translation">${xmlEscape(line)}</p>`).join("\n");
    const chapterTitle = chapter.title || `第 ${index + 1} 章`;
    return {
      name: `OEBPS/chapters/chapter-${index + 1}.xhtml`,
      title: chapterTitle,
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>${xmlEscape(chapterTitle)}</title><link rel="stylesheet" href="../style.css" /></head><body><h1>${xmlEscape(chapterTitle)}</h1>${paragraphs}</body></html>`
    };
  });
  const manifestItems = chapterFiles
    .map((file, index) => `<item id="chapter-${index + 1}" href="chapters/chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const spineItems = chapterFiles.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join("\n");
  const navItems = chapterFiles.map((file, index) => `<li><a href="chapters/chapter-${index + 1}.xhtml">${xmlEscape(file.title)}</a></li>`).join("\n");
  return createZip([
    { name: "mimetype", data: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    },
    { name: "OEBPS/style.css", data: "body{font-family:serif;line-height:1.8;}h1{font-size:1.4em;}p{text-indent:2em;margin:0 0 .6em;}" },
    {
      name: "OEBPS/nav.xhtml",
      data: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><h1>目录</h1><ol>${navItems}</ol></nav></body></html>`
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${Date.now()}</dc:identifier><dc:title>${safeTitle}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>${manifestItems}</manifest><spine>${spineItems}</spine></package>`
    },
    ...chapterFiles
  ]);
}

function createEpub(payload) {
  if (payload.book?.metadata?.format === "epub") {
    const preserved = createPreservedEpub(payload);
    if (preserved) return preserved;
  }
  return createSimpleEpub(payload);
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, version: "complete-core", node: process.version });
      return;
    }

    if (req.method === "POST" && pathname === "/api/parse-book") {
      sendJson(res, 200, parseBook(await readJson(req)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/models") {
      sendJson(res, 200, await fetchModels(await readJson(req)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/estimate-cost") {
      sendJson(res, 200, estimateTranslationCost(await readJson(req)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/translate-segment") {
      const payload = await readJson(req);
      if (!payload.text || !payload.text.trim()) {
        sendError(res, 400, "片段文本为空");
        return;
      }
      sendJson(res, 200, await translateSegmentWithCache(payload));
      return;
    }

    if (req.method === "POST" && pathname === "/api/export-epub") {
      const payload = await readJson(req);
      const epub = createEpub(payload);
      const filename = encodeURIComponent(`${payload.title || "translated-novel"}.epub`);
      res.writeHead(200, {
        "Content-Type": "application/epub+zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
        "Content-Length": epub.length,
        ...corsHeaders(res)
      });
      res.end(epub);
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { projects: await listProjects() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/projects") {
      sendJson(res, 200, await saveProject(await readJson(req)));
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "GET" && projectMatch) {
      const project = await getProject(decodeURIComponent(projectMatch[1]));
      if (!project) {
        sendError(res, 404, "项目不存在");
        return;
      }
      sendJson(res, 200, project);
      return;
    }

    if (req.method === "POST" && pathname === "/api/jobs/start") {
      sendJson(res, 200, await jobManager.createAndStart(await readJson(req)));
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = await jobManager.getSnapshot(decodeURIComponent(jobMatch[1]));
      if (!job) {
        sendError(res, 404, "任务不存在");
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    const jobActionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|retry-failed)$/);
    if (req.method === "POST" && jobActionMatch) {
      const jobId = decodeURIComponent(jobActionMatch[1]);
      const action = jobActionMatch[2];
      const payload = await readJson(req);
      if (action === "pause") sendJson(res, 200, await jobManager.pause(jobId));
      if (action === "resume") sendJson(res, 200, await jobManager.resume(jobId, payload.config || payload));
      if (action === "retry-failed") sendJson(res, 200, await jobManager.retryFailed(jobId, payload.config || payload));
      return;
    }

    if (req.method === "GET" && pathname === "/api/cache/stats") {
      sendJson(res, 200, await cacheStats());
      return;
    }

    if (req.method === "POST" && pathname === "/api/glossary/preview") {
      const payload = await readJson(req);
      const terms = parseGlossary(payload.glossary || payload.terms || "");
      const matched = relevantTerms(terms, payload.text || "", Number(payload.limit || 80));
      sendJson(res, 200, {
        terms,
        matched,
        promptText: formatGlossaryTerms(matched.length ? matched : terms.slice(0, Number(payload.limit || 80)))
      });
      return;
    }

    sendError(res, 404, "未知 API 路径");
  } catch (error) {
    sendError(res, 500, error.message || "服务端错误", error.stack || error);
  }
}

const server = http.createServer((req, res) => {
  res._requestOrigin = req.headers.origin;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(res) });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname);
    return;
  }
  serveStatic(req, res);
});

async function start() {
  await initStorage();
  jobManager = createJobManager({ translateSegment, chunkText });
  await jobManager.markInterruptedOnStartup();
  server.listen(PORT, () => {
    console.log(`Novel Translator Workbench running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
