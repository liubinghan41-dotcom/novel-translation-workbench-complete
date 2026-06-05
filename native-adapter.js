(function () {
  "use strict";

  const forcedNative = new URLSearchParams(window.location.search).has("ntw-native");
  const capacitor = window.Capacitor;
  const isNative =
    forcedNative ||
    Boolean(
      capacitor &&
        (typeof capacitor.isNativePlatform === "function"
          ? capacitor.isNativePlatform()
          : capacitor.getPlatform && capacitor.getPlatform() !== "web")
    );

  if (!isNative) return;

  const originalFetch = window.fetch.bind(window);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const activeJobs = new Map();
  const storagePrefix = "ntw.native.";

  const officialBaseUrls = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    claude: "https://api.anthropic.com/v1",
    "openai-compatible": "http://localhost:11434/v1",
    demo: ""
  };

  const officialPrices = [
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
    return String(model || "").trim().replace(/^models\//, "").toLowerCase();
  }

  function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  }

  function pricingKey(provider, baseUrl, model) {
    return `${normalizeProvider(provider)}|${normalizeBaseUrl(baseUrl)}|${normalizeModelId(model)}`;
  }

  function randomId(prefix = "item") {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  function blobResponse(blob, status = 200) {
    return new Response(blob, {
      status,
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "Cache-Control": "no-store"
      }
    });
  }

  function errorResponse(error, status = 500) {
    return jsonResponse({ error: error?.message || String(error), detail: error?.stack || "" }, status);
  }

  async function requestJson(init = {}) {
    const text = init.body ? String(init.body) : "";
    return text ? JSON.parse(text) : {};
  }

  function getCapPlugin(name) {
    return window.Capacitor?.Plugins?.[name] || null;
  }

  const nativeStore = {
    async read(path, fallback = null) {
      const filesystem = getCapPlugin("Filesystem");
      if (filesystem?.readFile) {
        try {
          const file = await filesystem.readFile({ path, directory: "DATA", encoding: "utf8" });
          return typeof file.data === "string" ? file.data : fallback;
        } catch {
          return fallback;
        }
      }
      return localStorage.getItem(storagePrefix + path) ?? fallback;
    },
    async write(path, text) {
      const filesystem = getCapPlugin("Filesystem");
      if (filesystem?.writeFile) {
        await filesystem.writeFile({ path, directory: "DATA", data: text, encoding: "utf8", recursive: true });
        return;
      }
      localStorage.setItem(storagePrefix + path, text);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const indexKey = `${storagePrefix}index:${dir}`;
      const index = JSON.parse(localStorage.getItem(indexKey) || "[]");
      if (!index.includes(path)) {
        index.push(path);
        localStorage.setItem(indexKey, JSON.stringify(index));
      }
    },
    async list(dir) {
      const normalized = dir.replace(/\/+$/, "");
      const filesystem = getCapPlugin("Filesystem");
      if (filesystem?.readdir) {
        try {
          const listed = await filesystem.readdir({ path: normalized, directory: "DATA" });
          return (listed.files || []).map((item) => (typeof item === "string" ? item : item.name)).filter(Boolean);
        } catch {
          return [];
        }
      }
      const index = JSON.parse(localStorage.getItem(`${storagePrefix}index:${normalized}`) || "[]");
      return index.map((item) => item.slice(normalized.length + 1));
    },
    async readJson(path, fallback = null) {
      const text = await this.read(path, null);
      if (text == null) return fallback;
      try {
        return JSON.parse(text);
      } catch {
        return fallback;
      }
    },
    async writeJson(path, value) {
      await this.write(path, `${JSON.stringify(value)}\n`);
      return value;
    }
  };

  async function listJson(dir) {
    const files = await nativeStore.list(dir);
    const values = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const value = await nativeStore.readJson(`${dir}/${file}`, null);
      if (value) values.push(value);
    }
    return values;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function blobToBase64(blob) {
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  async function saveBlob(blob, filename) {
    const filesystem = getCapPlugin("Filesystem");
    const share = getCapPlugin("Share");
    if (!filesystem?.writeFile) return false;
    const safeName = String(filename || "download.bin").replace(/[\\/:*?"<>|]+/g, "-");
    const path = `Novel Translation Workbench/${safeName}`;
    await filesystem.writeFile({
      path,
      directory: "DOCUMENTS",
      data: await blobToBase64(blob),
      recursive: true
    });
    if (filesystem.getUri && share?.share) {
      const uri = await filesystem.getUri({ path, directory: "DOCUMENTS" });
      await share.share({ title: safeName, url: uri.uri });
    } else {
      window.alert(`Saved to Documents/${path}`);
    }
    return true;
  }

  window.NTWNative = { isNative: true, saveBlob };

  function tryDecode(bytes) {
    const labels = ["utf-8", "utf-16le", "shift_jis", "euc-jp", "gb18030", "big5", "latin1"];
    let best = { label: "utf-8", text: decoder.decode(bytes), score: Number.POSITIVE_INFINITY };
    const nulRatio = bytes.length ? bytes.filter((byte) => byte === 0).length / bytes.length : 0;
    for (const label of labels) {
      try {
        const text = new TextDecoder(label, { fatal: false }).decode(bytes);
        const bad = (text.match(/\uFFFD/g) || []).length;
        const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g) || []).length;
        const readableCjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
        let score = bad * 1000 + controls * 60 - Math.min(readableCjk, 200) * 0.5;
        if (label.startsWith("utf-16") && nulRatio < 0.05) score += 10000;
        if (score < best.score) best = { label, text, score };
      } catch {
        // Ignore unsupported encodings in older WebViews.
      }
    }
    return best;
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
          return { title: heading.title || `Chapter ${index + 1}`, text: normalized.slice(heading.index, next).trim() };
        })
        .filter((chapter) => chapter.text);
    }
    const chunks = [];
    for (let index = 0; index < normalized.length; index += 9000) {
      chunks.push({ title: `Part ${chunks.length + 1}`, text: normalized.slice(index, index + 9000).trim() });
    }
    return chunks.length ? chunks : [{ title: "Full Text", text: normalized }];
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

  function xmlEscape(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function extractAttrs(tag) {
    const attrs = {};
    String(tag || "").replace(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g, (_, key, _quote, value) => {
      attrs[key] = htmlDecode(value);
      return "";
    });
    return attrs;
  }

  function readU16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readU32(view, offset) {
    return view.getUint32(offset, true);
  }

  function findEocd(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.length - 65558);
    for (let offset = bytes.length - 22; offset >= min; offset -= 1) {
      if (readU32(view, offset) === 0x06054b50) return offset;
    }
    throw new Error("Invalid ZIP/EPUB: central directory not found.");
  }

  async function inflateRaw(bytes) {
    if (!("DecompressionStream" in window)) throw new Error("This Android WebView cannot decompress EPUB entries.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZipEntries(bytes) {
    const eocd = findEocd(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const totalEntries = readU16(view, eocd + 10);
    let ptr = readU32(view, eocd + 16);
    const entries = new Map();
    for (let i = 0; i < totalEntries; i += 1) {
      if (readU32(view, ptr) !== 0x02014b50) throw new Error("ZIP central directory is corrupt.");
      const method = readU16(view, ptr + 10);
      const compressedSize = readU32(view, ptr + 20);
      const nameLength = readU16(view, ptr + 28);
      const extraLength = readU16(view, ptr + 30);
      const commentLength = readU16(view, ptr + 32);
      const localOffset = readU32(view, ptr + 42);
      const name = decoder.decode(bytes.slice(ptr + 46, ptr + 46 + nameLength)).replace(/\\/g, "/");
      if (readU32(view, localOffset) !== 0x04034b50) throw new Error(`ZIP local header is corrupt: ${name}`);
      const localNameLength = readU16(view, localOffset + 26);
      const localExtraLength = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) entries.set(name, compressed);
      else if (method === 8) entries.set(name, await inflateRaw(compressed));
      ptr += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  function posixDirname(filePath) {
    const normalized = String(filePath || "").replace(/\\/g, "/");
    return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/") + 1) : "";
  }

  function resolveZipPath(baseDir, href) {
    const parts = `${baseDir || ""}${href || ""}`.replace(/\\/g, "/").split("/");
    const out = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function decodeMarkupBuffer(bytes) {
    const head = decoder.decode(bytes.slice(0, Math.min(bytes.length, 1024)));
    const declared = (head.match(/\bencoding\s*=\s*(["'])(.*?)\1/i) || head.match(/charset\s*=\s*(["']?)([^"'\s/>]+)/i))?.[2];
    const label = String(declared || "").trim().toLowerCase().replace("_", "-");
    if (label) {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        // Fall through.
      }
    }
    return tryDecode(bytes).text;
  }

  function extractHtmlText(htmlBytes, fallbackTitle) {
    const decoded = decodeMarkupBuffer(htmlBytes);
    const titleMatch = decoded.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) || decoded.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
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

  async function parseEpub(bytes) {
    const entries = await readZipEntries(bytes);
    const container = entries.get("META-INF/container.xml");
    if (!container) throw new Error("EPUB is missing META-INF/container.xml.");
    const rootfileMatch = decoder.decode(container).match(/<rootfile\b[^>]*full-path=(["'])(.*?)\1/i);
    if (!rootfileMatch) throw new Error("EPUB container.xml does not declare an OPF path.");
    const opfPath = rootfileMatch[2].replace(/\\/g, "/");
    const opfBytes = entries.get(opfPath);
    if (!opfBytes) throw new Error(`EPUB is missing OPF file: ${opfPath}`);
    const opf = decoder.decode(opfBytes);
    const opfDir = posixDirname(opfPath);
    const title = stripTags((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1]) || "Untitled Book";
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
      for (const item of manifest.values()) if (/x?html/i.test(item.mediaType)) htmlPaths.push(item.href);
    }
    const chapters = [];
    for (const chapterPath of htmlPaths) {
      const html = entries.get(chapterPath);
      if (!html) continue;
      const parsed = extractHtmlText(html, `Chapter ${chapters.length + 1}`);
      if (parsed.text) chapters.push({ title: parsed.title, text: parsed.text, sourcePath: chapterPath, epubSpineIndex: chapters.length });
    }
    if (!chapters.length) throw new Error("EPUB contains no readable XHTML chapters.");
    return {
      title,
      chapters,
      metadata: {
        format: "epub",
        files: entries.size,
        originalEpubBase64: bytesToBase64(bytes),
        opfPath,
        spineHtmlPaths: htmlPaths
      }
    };
  }

  async function parseBook(payload = {}) {
    const bytes = base64ToBytes(payload.contentBase64 || "");
    const name = String(payload.name || "book.txt");
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "epub") return parseEpub(bytes);
    if (ext === "txt" || !name.includes(".")) {
      const decoded = tryDecode(bytes);
      return {
        title: name.replace(/\.[^.]+$/, "") || "Untitled Book",
        chapters: splitPlainTextChapters(decoded.text),
        metadata: { format: "txt", encoding: decoded.label }
      };
    }
    throw new Error("Only .txt and .epub files are supported.");
  }

  function crc32(bytes) {
    const table = crc32.table || (crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    }));
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function writeU16(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function dosDateTime(date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: dosDate };
  }

  function createZip(files) {
    const localParts = [];
    const centralParts = [];
    const stamp = dosDateTime();
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      writeU32(local, 0, 0x04034b50);
      writeU16(local, 4, 20);
      writeU16(local, 6, 0x0800);
      writeU16(local, 8, 0);
      writeU16(local, 10, stamp.time);
      writeU16(local, 12, stamp.date);
      writeU32(local, 14, crc);
      writeU32(local, 18, data.length);
      writeU32(local, 22, data.length);
      writeU16(local, 26, nameBytes.length);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      writeU32(central, 0, 0x02014b50);
      writeU16(central, 4, 20);
      writeU16(central, 6, 20);
      writeU16(central, 8, 0x0800);
      writeU16(central, 10, 0);
      writeU16(central, 12, stamp.time);
      writeU16(central, 14, stamp.date);
      writeU32(central, 16, crc);
      writeU32(central, 20, data.length);
      writeU32(central, 24, data.length);
      writeU16(central, 28, nameBytes.length);
      writeU32(central, 42, offset);
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }
    const centralDir = concatBytes(centralParts);
    const eocd = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 8, files.length);
    writeU16(eocd, 10, files.length);
    writeU32(eocd, 12, centralDir.length);
    writeU32(eocd, 16, offset);
    return concatBytes([...localParts, centralDir, eocd]);
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
    return String(text || "").split(/\n{1,}/).map((line) => line.trim()).filter(Boolean);
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

  function transformChapterXhtml(rawBytes, chapter, options = {}) {
    let xhtml = rawBytes instanceof Uint8Array ? decodeMarkupBuffer(rawBytes) : String(rawBytes || "");
    const translated = splitTranslatedParagraphs(chapter.text || chapter.translatedText || "");
    if (!translated.length) return xhtml;
    const bodyMatch = xhtml.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
    if (!bodyMatch) return xhtml;
    const bodyStart = bodyMatch.index + bodyMatch[0].indexOf(">") + 1;
    const body = bodyMatch[2];
    const ranges = protectedRanges(body);
    let used = 0;
    let changed = false;
    const transformed = body.replace(/<(p|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (full, tag, attrs, inner, offset) => {
      if (!shouldTranslateBlock(attrs, inner, offset, ranges)) return full;
      const translatedParagraph = translated[used++];
      if (!translatedParagraph) return full;
      changed = true;
      if (options.bilingual) {
        return `<${tag}${appendClass(attrs, "ntw-source")}>${inner}</${tag}>\n${paragraphHtml(translatedParagraph, attrs)}`;
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

  async function createPreservedEpub(payload) {
    const book = payload.book || {};
    const sourceBase64 = book.metadata?.originalEpubBase64;
    if (!sourceBase64) return null;
    const entries = await readZipEntries(base64ToBytes(sourceBase64));
    const chapterMap = new Map();
    (payload.chapters || []).forEach((chapter, index) => {
      const sourcePath = resolveChapterSourcePath(chapter, book, index);
      if (sourcePath) chapterMap.set(sourcePath.replace(/\\/g, "/"), chapter);
    });
    if (!chapterMap.size) return null;
    const files = [{ name: "mimetype", data: entries.get("mimetype") || encoder.encode("application/epub+zip") }];
    for (const [name, data] of entries) {
      if (name === "mimetype") continue;
      const chapter = chapterMap.get(name);
      files.push({
        name,
        data: chapter ? encoder.encode(transformChapterXhtml(data, chapter, { bilingual: payload.bilingual })) : data
      });
    }
    return createZip(files);
  }

  function createSimpleEpub(payload = {}) {
    const safeTitle = xmlEscape(payload.title || "translated-novel");
    const chapterFiles = (payload.chapters || []).map((chapter, index) => {
      const translated = splitTranslatedParagraphs(chapter.text || chapter.translatedText || "");
      const source = splitTranslatedParagraphs(chapter.sourceText || "");
      const paragraphs = payload.bilingual && source.length
        ? [
            ...source.map((line, lineIndex) => [
              `<p class="ntw-source">${xmlEscape(line)}</p>`,
              translated[lineIndex] ? `<p class="ntw-translation">${xmlEscape(translated[lineIndex])}</p>` : ""
            ].filter(Boolean).join("\n")),
            ...translated.slice(source.length).map((line) => `<p class="ntw-translation">${xmlEscape(line)}</p>`)
          ].filter(Boolean).join("\n")
        : translated.map((line) => `<p class="ntw-translation">${xmlEscape(line)}</p>`).join("\n");
      const chapterTitle = chapter.title || `Chapter ${index + 1}`;
      return {
        name: `OEBPS/chapters/chapter-${index + 1}.xhtml`,
        title: chapterTitle,
        data: `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><title>${xmlEscape(chapterTitle)}</title><link rel="stylesheet" href="../style.css" /></head><body><h1>${xmlEscape(chapterTitle)}</h1>${paragraphs}</body></html>`
      };
    });
    const manifestItems = chapterFiles.map((chapter, index) => `<item id="chapter-${index + 1}" href="chapters/chapter-${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
    const spineItems = chapterFiles.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join("");
    const navItems = chapterFiles.map((chapter, index) => `<li><a href="chapters/chapter-${index + 1}.xhtml">${xmlEscape(chapter.title)}</a></li>`).join("");
    return createZip([
      { name: "mimetype", data: "application/epub+zip" },
      { name: "META-INF/container.xml", data: `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
      { name: "OEBPS/style.css", data: "body{font-family:serif;line-height:1.8;}h1{font-size:1.4em;}p{text-indent:2em;margin:0 0 .6em;}.ntw-translation{color:#1f2937;}.ntw-source{color:#374151;}" },
      { name: "OEBPS/nav.xhtml", data: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${navItems}</ol></nav></body></html>` },
      { name: "OEBPS/content.opf", data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${Date.now()}</dc:identifier><dc:title>${safeTitle}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>${manifestItems}</manifest><spine>${spineItems}</spine></package>` },
      ...chapterFiles
    ]);
  }

  async function createEpub(payload = {}) {
    if (payload.book?.metadata?.format === "epub") {
      const preserved = await createPreservedEpub(payload);
      if (preserved) return preserved;
    }
    return createSimpleEpub(payload);
  }

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

  function fromParts({ inputTokens, uncachedInputTokens, cachedInputTokens, cacheCreationInputTokens, outputTokens, totalTokens, extra }) {
    const cached = toNumber(cachedInputTokens);
    const cacheCreation = toNumber(cacheCreationInputTokens);
    const uncached = uncachedInputTokens == null ? Math.max(0, toNumber(inputTokens) - cached) : toNumber(uncachedInputTokens);
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

  function normalizeUsage(provider, rawUsage) {
    if (!rawUsage || typeof rawUsage !== "object") return emptyUsage();
    if (rawUsage.inputTokens != null || rawUsage.outputTokens != null || rawUsage.cachedInputTokens != null || rawUsage.uncachedInputTokens != null) {
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
    if (provider === "gemini") {
      const cached = toNumber(rawUsage.cachedContentTokenCount ?? rawUsage.cached_content_token_count);
      const prompt = toNumber(rawUsage.promptTokenCount ?? rawUsage.prompt_token_count ?? rawUsage.inputTokens ?? rawUsage.input_tokens);
      return fromParts({
        inputTokens: prompt || cached,
        cachedInputTokens: cached,
        outputTokens: rawUsage.candidatesTokenCount ?? rawUsage.candidates_token_count ?? rawUsage.outputTokenCount ?? rawUsage.output_tokens,
        totalTokens: rawUsage.totalTokenCount ?? rawUsage.total_token_count ?? rawUsage.totalTokens
      });
    }
    if (provider === "claude") {
      const input = toNumber(rawUsage.input_tokens ?? rawUsage.inputTokens);
      const cacheRead = toNumber(rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens);
      const cacheCreation = toNumber(rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationInputTokens);
      return fromParts({
        inputTokens: input + cacheRead + cacheCreation,
        uncachedInputTokens: input + cacheCreation,
        cachedInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        outputTokens: rawUsage.output_tokens ?? rawUsage.outputTokens
      });
    }
    const details = rawUsage.prompt_tokens_details || rawUsage.promptTokensDetails || rawUsage.input_tokens_details || {};
    const cached = toNumber(details.cached_tokens) || toNumber(details.cachedTokens) || toNumber(rawUsage.prompt_cache_hit_tokens) || toNumber(rawUsage.promptCacheHitTokens);
    const prompt = toNumber(rawUsage.prompt_tokens ?? rawUsage.promptTokens ?? rawUsage.input_tokens ?? rawUsage.inputTokens ?? rawUsage.prompt_eval_count);
    const miss = rawUsage.prompt_cache_miss_tokens != null || rawUsage.promptCacheMissTokens != null ? toNumber(rawUsage.prompt_cache_miss_tokens ?? rawUsage.promptCacheMissTokens) : Math.max(0, prompt - cached);
    return fromParts({
      inputTokens: prompt || miss + cached,
      uncachedInputTokens: miss,
      cachedInputTokens: cached,
      outputTokens: rawUsage.completion_tokens ?? rawUsage.completionTokens ?? rawUsage.output_tokens ?? rawUsage.outputTokens ?? rawUsage.eval_count,
      totalTokens: rawUsage.total_tokens ?? rawUsage.totalTokens
    });
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
      const sourceTokens = segment?.tokens != null || segment?.inputTokens != null ? toNumber(segment.tokens ?? segment.inputTokens) : estimateTextTokens(segment?.text || "");
      if (!sourceTokens) continue;
      inputTokens += sourceTokens + promptOverheadTokens;
      outputTokens += Math.ceil(sourceTokens * outputRatio);
    }
    return fromParts({ inputTokens, uncachedInputTokens: inputTokens, outputTokens, extra: { estimated: true } });
  }

  function matchesModel(model, pattern) {
    const normalized = normalizeModelId(model);
    const target = normalizeModelId(pattern);
    return normalized === target || normalized.startsWith(`${target}-`) || normalized.startsWith(`${target}@`);
  }

  function toPrice(value) {
    if (value === "" || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function normalizeRates(value = {}) {
    if (!value || typeof value !== "object") return null;
    const inputPer1M = toPrice(value.inputPer1M);
    const cachedInputPer1M = toPrice(value.cachedInputPer1M);
    const outputPer1M = toPrice(value.outputPer1M);
    if (inputPer1M == null && cachedInputPer1M == null && outputPer1M == null) return null;
    return { inputPer1M, cachedInputPer1M, outputPer1M };
  }

  function getPricing(payload = {}) {
    const provider = normalizeProvider(payload.provider);
    const baseUrl = normalizeBaseUrl(payload.baseUrl || officialBaseUrls[provider] || "");
    const model = normalizeModelId(payload.model);
    const key = pricingKey(provider, baseUrl, model);
    if (provider === "demo") {
      return { key, provider, baseUrl, model, source: "free", currency: "USD", inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 };
    }
    let official = null;
    if (officialBaseUrls[provider] && normalizeBaseUrl(officialBaseUrls[provider]) === baseUrl) {
      for (const record of officialPrices) {
        if (record.provider !== provider) continue;
        if (record.models.some((pattern) => matchesModel(model, pattern))) {
          official = { key, provider, baseUrl, model, source: "official", currency: "USD", inputPer1M: record.inputPer1M, cachedInputPer1M: record.cachedInputPer1M, outputPer1M: record.outputPer1M };
          break;
        }
      }
    }
    const override = normalizeRates(payload.pricingOverrides?.[key]);
    if (override) {
      return {
        ...(official || {}),
        key,
        provider,
        baseUrl,
        model,
        source: official ? "override+official" : "override",
        currency: "USD",
        inputPer1M: override.inputPer1M ?? official?.inputPer1M ?? null,
        cachedInputPer1M: override.cachedInputPer1M ?? official?.cachedInputPer1M ?? override.inputPer1M ?? official?.inputPer1M ?? null,
        outputPer1M: override.outputPer1M ?? official?.outputPer1M ?? null
      };
    }
    return official || { key, provider, baseUrl, model, source: "missing", currency: "USD", inputPer1M: null, cachedInputPer1M: null, outputPer1M: null, warning: "No pricing configured." };
  }

  function calculateCost(usage = emptyUsage(), pricing = null) {
    const rates = pricing || {};
    if (rates.inputPer1M == null || rates.cachedInputPer1M == null || rates.outputPer1M == null) {
      return { currency: "USD", input: null, cachedInput: null, output: null, total: null, priceUnavailable: true, pricing: pricing || null };
    }
    const input = (Number(usage.uncachedInputTokens || 0) / 1000000) * Number(rates.inputPer1M || 0);
    const cachedInput = (Number(usage.cachedInputTokens || 0) / 1000000) * Number(rates.cachedInputPer1M || 0);
    const output = (Number(usage.outputTokens || 0) / 1000000) * Number(rates.outputPer1M || 0);
    return { currency: rates.currency || "USD", input, cachedInput, output, total: input + cachedInput + output, priceUnavailable: false, pricing: rates };
  }

  function zeroCost(pricing, reason) {
    return { currency: "USD", input: 0, cachedInput: 0, output: 0, total: 0, priceUnavailable: false, pricing: pricing || null, reason };
  }

  function addCost(left, right) {
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
    const usage = payload.usage && typeof payload.usage === "object" ? normalizeUsage(payload.provider, payload.usage) : estimateSegmentsUsage(payload.segments || [], payload.estimateOptions || {});
    return { provider: normalizeProvider(payload.provider), baseUrl: normalizeBaseUrl(payload.baseUrl), model: normalizeModelId(payload.model), pricing, usage, cost: calculateCost(usage, pricing), estimated: true };
  }

  function publicConfig(config = {}) {
    const { apiKey, ...rest } = config;
    return rest;
  }

  async function sha256(value) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function stableStringify(value) {
    if (value == null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  async function buildCacheKey(payload = {}) {
    const input = {
      provider: payload.provider || "",
      model: payload.model || "",
      baseUrl: payload.baseUrl || "",
      sourceLanguage: payload.sourceLanguage || "",
      targetLanguage: payload.targetLanguage || "",
      temperature: Number(payload.temperature ?? payload.preset?.temperature ?? 0.35),
      preset: payload.preset ? { id: payload.preset.id || "", name: payload.preset.name || "", temperature: Number(payload.preset.temperature ?? 0.35), prompt: payload.preset.prompt || "" } : null,
      glossary: payload.glossary || "",
      context: payload.context || "",
      contextBank: payload.contextBank || [],
      promptOptions: payload.promptOptions || {},
      text: payload.text || ""
    };
    return sha256(stableStringify(input));
  }

  async function getCachedTranslation(cacheKey) {
    return nativeStore.readJson(`cache/${cacheKey}.json`, null);
  }

  async function setCachedTranslation(cacheKey, payload, translated) {
    await nativeStore.writeJson(`cache/${cacheKey}.json`, {
      key: cacheKey,
      text: translated.text || "",
      usage: translated.usage || null,
      provider: payload.provider || "",
      model: payload.model || "",
      createdAt: nowIso()
    });
  }

  async function cacheStats() {
    const entries = await listJson("cache");
    return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0) };
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
      } else if ((current + "\n\n" + paragraph).trim().length > maxChars && current) {
        chunks.push(current.trim());
        current = paragraph;
      } else {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function buildSegments(chapters, config) {
    const maxChars = Math.max(600, Number(config.chunkSize || 1800));
    const preserveParagraphs = config.preserveParagraphs !== false;
    return chapters.flatMap((chapter) => {
      const chunks = chunkText(chapter.text || "", maxChars, preserveParagraphs);
      return chunks.map((text, index) => ({
        id: `c${chapter.originalIndex + 1}-s${index + 1}`,
        chapterIndex: chapter.originalIndex,
        chapterTitle: chapter.title || `Chapter ${chapter.originalIndex + 1}`,
        segmentIndex: index + 1,
        segmentsTotal: chunks.length,
        text,
        translatedText: "",
        cacheKey: "",
        cacheHit: false,
        usage: null,
        cost: null,
        status: "pending",
        attempts: 0,
        error: null,
        startedAt: null,
        completedAt: null
      }));
    });
  }

  function summarizeProgress(segments) {
    const progress = { total: segments.length, pending: 0, running: 0, completed: 0, cached: 0, failed: 0, interrupted: 0 };
    for (const segment of segments) {
      if (progress[segment.status] == null) progress[segment.status] = 0;
      progress[segment.status] += 1;
    }
    progress.done = progress.completed + progress.cached;
    progress.percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return progress;
  }

  function buildBilling(job) {
    const billing = {
      usage: emptyUsage(),
      cost: { currency: "USD", input: 0, cachedInput: 0, output: 0, total: 0, knownTotal: 0, priceUnavailable: false },
      cacheHits: 0,
      pricedSegments: 0,
      unpricedSegments: 0
    };
    for (const segment of job.segments || []) {
      if (segment.status !== "completed" && segment.status !== "cached") continue;
      if (segment.cacheHit || segment.status === "cached") billing.cacheHits += 1;
      billing.usage = addUsage(billing.usage, normalizeUsage(job.config?.provider, segment.usage));
      if (segment.cost) {
        billing.cost = addCost(billing.cost, segment.cost);
        if (segment.cost.priceUnavailable) billing.unpricedSegments += 1;
        else billing.pricedSegments += 1;
      }
    }
    return billing;
  }

  function buildResults(job) {
    return (job.chapters || []).map((chapter) => {
      const chunks = (job.segments || [])
        .filter((segment) => segment.chapterIndex === chapter.originalIndex)
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .map((segment) => segment.translatedText || "")
        .filter(Boolean);
      return {
        title: chapter.title,
        originalIndex: chapter.originalIndex,
        sourcePath: chapter.sourcePath,
        epubSpineIndex: chapter.epubSpineIndex,
        sourceText: chapter.text,
        translatedText: chunks.join("\n\n")
      };
    }).filter((chapter) => chapter.translatedText);
  }

  function publicJob(job) {
    if (!job) return null;
    return { ...job, config: publicConfig(job.config || {}), results: buildResults(job), qaIssues: job.qaIssues || [], chapterSummaries: job.chapterSummaries || [], consistencyIssues: job.consistencyIssues || [] };
  }

  async function saveProject(project) {
    const id = project.id || randomId("project");
    const saved = { ...project, id, updatedAt: nowIso(), createdAt: project.createdAt || nowIso() };
    await nativeStore.writeJson(`projects/${id}.json`, saved);
    return saved;
  }

  async function getProject(id) {
    return nativeStore.readJson(`projects/${id}.json`, null);
  }

  async function listProjects() {
    const projects = await listJson("projects");
    return projects
      .map((project) => ({
        id: project.id,
        title: project.title || project.book?.title || "Untitled Project",
        updatedAt: project.updatedAt || project.createdAt || "",
        chapterCount: project.book?.chapters?.length || 0,
        resultChapters: project.results?.length || 0,
        lastJobStatus: project.lastJobStatus || ""
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function saveJob(job) {
    await nativeStore.writeJson(`jobs/${job.id}.json`, job);
    return job;
  }

  async function getJob(id) {
    return nativeStore.readJson(`jobs/${id}.json`, null);
  }

  async function persistJob(job) {
    job.progress = summarizeProgress(job.segments || []);
    job.billing = buildBilling(job);
    job.qaIssues = (job.segments || []).filter((segment) => (segment.status === "completed" || segment.status === "cached") && !String(segment.translatedText || "").trim()).map((segment) => ({ segmentId: segment.id, message: "Empty translation output" }));
    job.chapterSummaries = (job.chapters || []).map((chapter) => ({ title: chapter.title, summary: String(chapter.text || "").split(/[。.!?！？\n]/).find(Boolean)?.slice(0, 120) || "" }));
    job.consistencyIssues = [];
    await saveJob(job);
    if (job.projectId) {
      const existing = await getProject(job.projectId);
      await saveProject({
        ...(existing || {}),
        id: job.projectId,
        title: existing?.title || job.book?.title || "Untitled Project",
        book: job.book,
        settings: publicConfig(job.config || {}),
        results: buildResults(job),
        contextBank: job.contextBank || existing?.contextBank || [],
        chapterSummaries: job.chapterSummaries || [],
        qaIssues: job.qaIssues || [],
        consistencyIssues: job.consistencyIssues || [],
        billing: job.billing,
        lastJobId: job.id,
        lastJobStatus: job.status,
        lastJobProgress: job.progress
      });
    }
    return job;
  }

  function renderTemplate(template, values) {
    return String(template || "Translate the source fiction into {{targetLanguage}}. Preserve paragraph structure and only output the translation.")
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => values[key] == null ? "" : String(values[key]));
  }

  function buildMessages(payload) {
    const values = {
      sourceLanguage: payload.sourceLanguage || "auto",
      targetLanguage: payload.targetLanguage || "Chinese",
      chapterTitle: payload.chapterTitle || "",
      segmentIndex: payload.segmentIndex || 1,
      segmentsTotal: payload.segmentsTotal || 1,
      glossary: payload.glossary || "None",
      context: payload.context || "None",
      retrieval: "",
      text: payload.text || ""
    };
    const template = payload.preset?.prompt || "Translate {{sourceLanguage}} fiction into {{targetLanguage}}. Keep names, tone, and paragraph structure. Only output the translation.";
    if (template.includes("{{text}}")) return { system: "You are a literary translation assistant. Only output final translation.", user: renderTemplate(template, values) };
    return {
      system: renderTemplate(template, values),
      user: [
        `Chapter: ${values.chapterTitle}`,
        `Segment: ${values.segmentIndex}/${values.segmentsTotal}`,
        `Source language: ${values.sourceLanguage}`,
        `Target language: ${values.targetLanguage}`,
        `Glossary:\n${values.glossary}`,
        `Context:\n${values.context}`,
        "Source text:",
        values.text
      ].join("\n\n")
    };
  }

  function joinUrl(baseUrl, suffix) {
    return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
  }

  async function parseProviderResponse(provider, response) {
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
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
      return { text, usage: normalizeUsage(provider, data?.usageMetadata || null), rawUsage: data?.usageMetadata || null, raw: data };
    }
    if (provider === "claude") {
      const text = data?.content?.map((part) => part.text || "").join("") || "";
      return { text, usage: normalizeUsage(provider, data?.usage || null), rawUsage: data?.usage || null, raw: data };
    }
    const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    return { text, usage: normalizeUsage(provider, data?.usage || null), rawUsage: data?.usage || null, raw: data };
  }

  async function translateSegment(payload) {
    const provider = normalizeProvider(payload.provider);
    let model = String(payload.model || "").trim();
    if (provider === "gemini") model = model.replace(/^models\//, "");
    const temperature = Number(payload.temperature ?? payload.preset?.temperature ?? 0.35);
    const apiKey = payload.apiKey || "";
    const { system, user } = buildMessages(payload);
    if (provider === "demo") {
      return {
        text: `[Demo translation -> ${payload.targetLanguage || "Chinese"}]\n${String(payload.text || "").split("\n").filter(Boolean).map((line) => `Translated: ${line}`).join("\n")}`,
        usage: emptyUsage({ mode: "demo" }),
        provider
      };
    }
    if (!model) {
      const error = new Error("Choose or enter a model id first.");
      error.retryable = false;
      throw error;
    }
    if (provider === "gemini") {
      if (!apiKey) {
        const error = new Error("Gemini requires an API key.");
        error.retryable = false;
        throw error;
      }
      const baseUrl = payload.baseUrl || officialBaseUrls[provider];
      const response = await originalFetch(`${joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(apiKey)}`, {
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
        const error = new Error("Claude requires an API key.");
        error.retryable = false;
        throw error;
      }
      const response = await originalFetch(joinUrl(payload.baseUrl || officialBaseUrls[provider], "/messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: Number(payload.maxTokens || 4096), temperature, system, messages: [{ role: "user", content: user }] })
      });
      return { ...(await parseProviderResponse(provider, response)), provider };
    }
    if ((provider === "openai" || provider === "deepseek") && !apiKey) {
      const error = new Error(`${provider} requires an API key.`);
      error.retryable = false;
      throw error;
    }
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await originalFetch(joinUrl(payload.baseUrl || officialBaseUrls[provider] || officialBaseUrls["openai-compatible"], "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify({ model, temperature, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: user }] })
    });
    return { ...(await parseProviderResponse(provider, response)), provider };
  }

  async function translateWithCache(payload) {
    const cacheKey = await buildCacheKey(payload);
    if (payload.useCache !== false) {
      const cached = await getCachedTranslation(cacheKey);
      if (cached) return { text: cached.text, usage: normalizeUsage(payload.provider, cached.usage), provider: payload.provider, cacheHit: true };
    }
    const translated = await translateSegment(payload);
    if (payload.useCache !== false && translated.text) await setCachedTranslation(cacheKey, payload, translated);
    return { ...translated, cacheHit: false };
  }

  async function createAndStartJob(payload = {}) {
    if (!payload.book?.chapters?.length) throw new Error("Missing parsed book content.");
    const config = payload.config || {};
    const selectedChapters = (payload.chapters || []).map((chapter) => ({
      originalIndex: Number(chapter.originalIndex ?? chapter.index ?? 0),
      title: chapter.title || `Chapter ${Number(chapter.originalIndex ?? 0) + 1}`,
      text: chapter.text || "",
      sourcePath: chapter.sourcePath || "",
      epubSpineIndex: chapter.epubSpineIndex
    })).filter((chapter) => chapter.text.trim());
    if (!selectedChapters.length) throw new Error("No chapters selected for translation.");
    const project = await saveProject({
      id: payload.projectId,
      title: payload.book.title || "Untitled Project",
      book: payload.book,
      settings: publicConfig(config),
      results: payload.results || [],
      contextBank: payload.contextBank || [],
      chapterSummaries: payload.chapterSummaries || []
    });
    const job = {
      id: randomId("job"),
      projectId: project.id,
      title: `${payload.book.title || "Untitled Book"} translation job`,
      status: "queued",
      book: payload.book,
      chapters: selectedChapters,
      config: publicConfig(config),
      contextBank: payload.contextBank || project.contextBank || [],
      chapterSummaries: payload.chapterSummaries || project.chapterSummaries || [],
      qaIssues: [],
      consistencyIssues: [],
      maxRetries: Math.max(0, Math.min(8, Number(config.maxRetries ?? 2))),
      useCache: config.useCache !== false,
      segments: buildSegments(selectedChapters, config),
      progress: null,
      billing: null,
      startedAt: null,
      completedAt: null,
      error: null
    };
    activeJobs.set(job.id, { pauseRequested: false, retryFailed: false, secretConfig: { ...config } });
    await persistJob(job);
    setTimeout(() => runJob(job.id), 0);
    return publicJob(await getJob(job.id));
  }

  async function runJob(jobId) {
    const control = activeJobs.get(jobId);
    if (!control) return;
    let job = await getJob(jobId);
    if (!job) return;
    job.status = "running";
    job.startedAt = job.startedAt || nowIso();
    job.error = null;
    await persistJob(job);
    try {
      for (const segment of job.segments) {
        if (control.pauseRequested) {
          job.status = "paused";
          await persistJob(job);
          return;
        }
        if (segment.status === "completed" || segment.status === "cached") continue;
        if (segment.status === "failed" && !control.retryFailed) continue;
        segment.status = "running";
        segment.startedAt = nowIso();
        segment.error = null;
        await persistJob(job);
        const payload = {
          ...job.config,
          ...control.secretConfig,
          chapterIndex: segment.chapterIndex,
          chapterTitle: segment.chapterTitle,
          segmentIndex: segment.segmentIndex,
          segmentsTotal: segment.segmentsTotal,
          chapterSummaries: job.chapterSummaries || [],
          contextBank: job.contextBank || [],
          text: segment.text
        };
        const cacheKey = await buildCacheKey(payload);
        const pricing = getPricing(payload);
        segment.cacheKey = cacheKey;
        segment.cacheHit = false;
        segment.usage = null;
        segment.cost = null;
        if (job.useCache !== false) {
          const cached = await getCachedTranslation(cacheKey);
          if (cached) {
            segment.translatedText = String(cached.text || "").trim();
            segment.cacheHit = true;
            segment.usage = emptyUsage({ cacheHit: true, localCacheHit: true });
            segment.cost = zeroCost(pricing, "local-cache-hit");
            segment.status = "cached";
            segment.completedAt = nowIso();
            await persistJob(job);
            continue;
          }
        }
        try {
          const translated = await translateWithCache(payload);
          segment.translatedText = String(translated.text || "").trim();
          segment.usage = normalizeUsage(payload.provider, translated.usage);
          segment.cost = calculateCost(segment.usage, pricing);
          segment.status = "completed";
          segment.completedAt = nowIso();
          segment.error = null;
        } catch (error) {
          segment.status = "failed";
          segment.error = String(error.message || error).slice(0, 2000);
          job.error = segment.error;
        }
        await persistJob(job);
      }
      job.progress = summarizeProgress(job.segments);
      job.status = job.progress.failed > 0 && job.progress.done > 0 ? "completed_with_errors" : job.progress.failed > 0 ? "failed" : "completed";
      job.completedAt = nowIso();
      await persistJob(job);
    } finally {
      activeJobs.delete(jobId);
    }
  }

  async function pauseJob(jobId) {
    const control = activeJobs.get(jobId);
    if (control) control.pauseRequested = true;
    const job = await getJob(jobId);
    if (!job) throw new Error("Job not found.");
    if (!control) {
      job.status = "paused";
      await persistJob(job);
    }
    return publicJob(await getJob(jobId));
  }

  async function resumeJob(jobId, config = {}, retryFailed = false) {
    const job = await getJob(jobId);
    if (!job) throw new Error("Job not found.");
    job.status = "queued";
    await persistJob(job);
    activeJobs.set(jobId, { pauseRequested: false, retryFailed, secretConfig: { ...config } });
    setTimeout(() => runJob(jobId), 0);
    return publicJob(await getJob(jobId));
  }

  function modelFromItem(provider, item) {
    if (typeof item === "string") {
      const id = provider === "gemini" ? normalizeModelId(item) : item.trim();
      return id ? { id, label: id } : null;
    }
    if (!item || typeof item !== "object") return null;
    if (provider === "gemini" && Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent")) return null;
    const rawId = item.id || item.name || item.model || item.display_name || item.displayName;
    const id = provider === "gemini" ? normalizeModelId(rawId) : String(rawId || "").trim();
    if (!id) return null;
    return { id, label: item.display_name || item.displayName || item.name || id, description: item.description || "", ownedBy: item.owned_by || item.ownedBy || "" };
  }

  function normalizeModels(provider, data) {
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data?.items) ? data.items : [];
    const seen = new Set();
    const models = [];
    for (const item of items) {
      const model = modelFromItem(provider, item);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function fetchModels(payload = {}) {
    const provider = normalizeProvider(payload.provider);
    const apiKey = String(payload.apiKey || "").trim();
    if (provider === "demo") return { provider, baseUrl: "", models: [{ id: "demo-translator", label: "Demo translator" }] };
    if (provider !== "openai-compatible" && !apiKey) throw new Error(`${provider} requires an API key to refresh models.`);
    const baseUrl = String(payload.baseUrl || officialBaseUrls[provider] || "").trim();
    if (!baseUrl) throw new Error("Base URL is required to refresh models.");
    let url = joinUrl(baseUrl, "/models");
    const headers = {};
    if (provider === "gemini") url = `${url}?key=${encodeURIComponent(apiKey)}`;
    else if (provider === "claude") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = payload.anthropicVersion || "2023-06-01";
    } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await originalFetch(url, { method: "GET", headers });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Model API ${response.status} ${response.statusText}: ${raw.slice(0, 1200)}`);
    const data = raw ? JSON.parse(raw) : {};
    return { provider, baseUrl, models: normalizeModels(provider, data) };
  }

  async function handleApi(pathname, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET" && pathname === "/api/health") return { ok: true, version: "native-apk", node: "capacitor-webview" };
    if (method === "POST" && pathname === "/api/parse-book") return parseBook(await requestJson(init));
    if (method === "POST" && pathname === "/api/models") return fetchModels(await requestJson(init));
    if (method === "POST" && pathname === "/api/estimate-cost") return estimateTranslationCost(await requestJson(init));
    if (method === "POST" && pathname === "/api/export-epub") {
      const epub = await createEpub(await requestJson(init));
      return new Blob([epub], { type: "application/epub+zip" });
    }
    if (method === "GET" && pathname === "/api/projects") return { projects: await listProjects() };
    if (method === "POST" && pathname === "/api/projects") return saveProject(await requestJson(init));
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "GET" && projectMatch) {
      const project = await getProject(decodeURIComponent(projectMatch[1]));
      if (!project) {
        const error = new Error("Project not found.");
        error.status = 404;
        throw error;
      }
      return project;
    }
    if (method === "POST" && pathname === "/api/jobs/start") return createAndStartJob(await requestJson(init));
    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      const job = await getJob(decodeURIComponent(jobMatch[1]));
      if (!job) {
        const error = new Error("Job not found.");
        error.status = 404;
        throw error;
      }
      return publicJob(job);
    }
    const jobActionMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|retry-failed)$/);
    if (method === "POST" && jobActionMatch) {
      const jobId = decodeURIComponent(jobActionMatch[1]);
      const action = jobActionMatch[2];
      const payload = await requestJson(init);
      if (action === "pause") return pauseJob(jobId);
      return resumeJob(jobId, payload.config || payload, action === "retry-failed");
    }
    if (method === "GET" && pathname === "/api/cache/stats") return cacheStats();
    if (method === "POST" && pathname === "/api/glossary/preview") return { terms: [], matched: [], promptText: "" };
    const error = new Error(`Unknown local API route: ${method} ${pathname}`);
    error.status = 404;
    throw error;
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    if (!url.pathname.startsWith("/api/")) return originalFetch(input, init);
    try {
      const result = await handleApi(url.pathname, init);
      if (result instanceof Blob) return blobResponse(result);
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(error, error.status || 500);
    }
  };
})();
