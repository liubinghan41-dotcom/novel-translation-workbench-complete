import { unzipSync, strFromU8 } from "fflate";

const textEncoder = new TextEncoder();

function bytesFromBase64(base64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64 || "", "base64"));
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function basename(name, ext = "") {
  const clean = String(name || "").replace(/\\/g, "/").split("/").pop() || "";
  return ext && clean.toLowerCase().endsWith(ext) ? clean.slice(0, -ext.length) : clean;
}

function extname(name) {
  const clean = String(name || "").toLowerCase();
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot) : "";
}

export function tryDecode(bytes) {
  const labels = ["utf-8", "utf-16le", "shift_jis", "euc-jp", "gb18030", "big5", "latin1"];
  const nullRatio = bytes.length ? bytes.filter((byte) => byte === 0).length / bytes.length : 0;
  let best = { label: "utf-8", text: strFromU8(bytes), score: Number.POSITIVE_INFINITY };
  for (const label of labels) {
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(bytes);
      const bad = (text.match(/\uFFFD/g) || []).length;
      const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g) || []).length;
      const readableCjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
      let score = bad * 1000 + controls * 60 - Math.min(readableCjk, 200) * 0.5;
      if (label.startsWith("utf-16") && nullRatio < 0.05) score += 10000;
      if (score < best.score) best = { label, text, score };
    } catch {
      // Some runtimes omit legacy encodings.
    }
  }
  return best;
}

export function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function splitPlainTextChapters(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split("\n");
  const headingRe =
    /^\s*(第\s*[0-9０-９一二三四五六七八九十百千万零〇两]+\s*[章节回话卷部].{0,80}|[Cc][Hh][Aa][Pp][Tt][Ee][Rr]\s+\d+.{0,80}|序章|终章|尾声|后记|番外.{0,40})\s*$/;
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

function extractAttrs(tag) {
  const attrs = {};
  String(tag || "").replace(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g, (_, key, _quote, value) => {
    attrs[key] = htmlDecode(value);
    return "";
  });
  return attrs;
}

function extractHtmlText(htmlBytes, fallbackTitle) {
  const decoded = tryDecode(htmlBytes).text;
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

function resolveZipPath(baseDir, href) {
  const parts = `${baseDir || ""}/${href || ""}`.replace(/\\/g, "/").split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function parseEpub(bytes) {
  const entries = unzipSync(bytes);
  const container = entries["META-INF/container.xml"];
  if (!container) throw new Error("Invalid EPUB: missing META-INF/container.xml");
  const containerXml = strFromU8(container);
  const rootfileMatch = containerXml.match(/<rootfile\b[^>]*full-path=(["'])(.*?)\1/i);
  if (!rootfileMatch) throw new Error("Invalid EPUB: missing OPF path");
  const opfPath = rootfileMatch[2].replace(/\\/g, "/");
  const opfBytes = entries[opfPath];
  if (!opfBytes) throw new Error(`Invalid EPUB: missing OPF file ${opfPath}`);
  const opf = strFromU8(opfBytes);
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const title = stripTags((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1]) || "Untitled Novel";
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
      const html = entries[chapterPath];
      if (!html) return null;
      const parsed = extractHtmlText(html, `Chapter ${index + 1}`);
      return { title: parsed.title || `Chapter ${index + 1}`, text: parsed.text, sourcePath: chapterPath };
    })
    .filter((chapter) => chapter && chapter.text);
  if (!chapters.length) throw new Error("Invalid EPUB: no readable XHTML chapters");
  return { title, chapters, metadata: { format: "epub", files: Object.keys(entries).length } };
}

export function parseBook({ name, contentBase64 }) {
  const bytes = bytesFromBase64(contentBase64 || "");
  const ext = extname(name || "");
  if (ext === ".epub") return parseEpub(bytes);
  if (ext === ".txt" || !ext) {
    const decoded = tryDecode(bytes);
    return {
      title: basename(name || "Untitled Novel", ext || ".txt"),
      chapters: splitPlainTextChapters(decoded.text),
      metadata: { format: "txt", encoding: decoded.label }
    };
  }
  throw new Error("Only .txt and .epub files are supported");
}

export function chunkText(text, maxChars, preserveParagraphs) {
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

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    const nameBytes = textEncoder.encode(file.name);
    const data = file.data instanceof Uint8Array ? file.data : textEncoder.encode(String(file.data));
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, stamp.time);
    writeU16(localView, 12, stamp.date);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, data.length);
    writeU32(localView, 22, data.length);
    writeU16(localView, 26, nameBytes.length);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, stamp.time);
    writeU16(centralView, 14, stamp.date);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, data.length);
    writeU32(centralView, 24, data.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }

  const centralDir = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 8, files.length);
  writeU16(eocdView, 10, files.length);
  writeU32(eocdView, 12, centralDir.length);
  writeU32(eocdView, 16, offset);
  return concatBytes([...localParts, centralDir, eocd]);
}

export function createEpub({ title, chapters }) {
  const safeTitle = xmlEscape(title || "translated-novel");
  const chapterFiles = (chapters || []).map((chapter, index) => {
    const paragraphs = String(chapter.text || "")
      .split(/\n{1,}/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<p>${xmlEscape(line)}</p>`)
      .join("\n");
    const chapterTitle = chapter.title || `Chapter ${index + 1}`;
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
      data: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${navItems}</ol></nav></body></html>`
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${Date.now()}</dc:identifier><dc:title>${safeTitle}</dc:title><dc:language>zh-CN</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>${manifestItems}</manifest><spine>${spineItems}</spine></package>`
    },
    ...chapterFiles
  ]);
}
