import { chunkText, createEpub, parseBook } from "../core/book.mjs";

const CACHE_VERSION = 1;
const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "paused", "interrupted"]);
const DEFAULT_PROMPT = "Translate the source fiction into {{targetLanguage}}. Preserve names, paragraph structure, tone, and only output the translation.";

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value, prefix = "item") {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || randomId(prefix);
}

function randomId(prefix = "item") {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (crypto.subtle?.digest) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(64, "0");
}

async function buildCacheKey(payload) {
  return sha256Hex(stableStringify(buildCacheInput(payload)));
}

function redactConfig(config = {}) {
  const { apiKey, ...publicConfig } = config;
  return publicConfig;
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

function buildResults(job) {
  return (job.chapters || [])
    .map((chapter) => {
      const chunks = (job.segments || [])
        .filter((segment) => segment.chapterIndex === chapter.originalIndex)
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .map((segment) => segment.translatedText || "")
        .filter(Boolean);
      return {
        title: chapter.title,
        sourceText: chapter.text,
        translatedText: chunks.join("\n\n")
      };
    })
    .filter((chapter) => chapter.translatedText);
}

function publicJob(job) {
  if (!job) return null;
  return {
    ...job,
    config: redactConfig(job.config || {}),
    results: buildResults(job),
    qaIssues: job.qaIssues || [],
    chapterSummaries: job.chapterSummaries || [],
    consistencyIssues: job.consistencyIssues || []
  };
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
      status: "pending",
      attempts: 0,
      error: null,
      startedAt: null,
      completedAt: null
    }));
  });
}

function renderTemplate(template, values) {
  return String(template || DEFAULT_PROMPT).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    return values[key] == null ? "" : String(values[key]);
  });
}

function buildMessages(payload) {
  const template = payload.preset?.prompt || DEFAULT_PROMPT;
  const values = {
    sourceLanguage: payload.sourceLanguage || "auto",
    targetLanguage: payload.targetLanguage || "Chinese",
    chapterTitle: payload.chapterTitle || "Untitled chapter",
    segmentIndex: payload.segmentIndex || 1,
    segmentsTotal: payload.segmentsTotal || 1,
    glossary: payload.glossary || "None",
    context: payload.context || "None",
    retrieval: "None",
    text: payload.text || ""
  };
  if (template.includes("{{text}}")) return { system: "Only output the final translation.", user: renderTemplate(template, values) };
  const user = [
    `Chapter: ${values.chapterTitle}`,
    `Segment: ${values.segmentIndex}/${values.segmentsTotal}`,
    `Source language: ${values.sourceLanguage}`,
    `Target language: ${values.targetLanguage}`,
    `Glossary:\n${values.glossary}`,
    `Context:\n${values.context}`,
    "Source text:",
    values.text
  ].join("\n\n");
  return { system: renderTemplate(template, values), user };
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

async function nativePostJson(url, headers, data) {
  const { CapacitorHttp } = await import("@capacitor/core");
  if (!CapacitorHttp?.post) throw new Error("CapacitorHttp is unavailable");
  const response = await CapacitorHttp.post({ url, headers, data });
  const body = typeof response.data === "string" ? JSON.parse(response.data || "{}") : response.data;
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`API ${response.status}: ${JSON.stringify(body).slice(0, 2000)}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return body;
}

async function fetchPostJson(url, headers, data) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(data) });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    const error = new Error(`API ${response.status} ${response.statusText}: ${raw.slice(0, 2000)}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return body;
}

async function postJson(url, headers, data) {
  try {
    return await nativePostJson(url, headers, data);
  } catch (error) {
    if (!String(error.message || "").includes("CapacitorHttp")) throw error;
    return fetchPostJson(url, headers, data);
  }
}

function parseProviderData(provider, data) {
  if (provider === "gemini") {
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    return { text, usage: data?.usageMetadata || null, raw: data };
  }
  if (provider === "claude") {
    const text = data?.content?.map((part) => part.text || "").join("") || "";
    return { text, usage: data?.usage || null, raw: data };
  }
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  return { text, usage: data?.usage || null, raw: data };
}

async function translateSegment(payload) {
  const provider = payload.provider || "openai-compatible";
  const model = payload.model || "gpt-4.1-mini";
  const temperature = Number(payload.temperature ?? payload.preset?.temperature ?? 0.35);
  const apiKey = payload.apiKey || "";
  const { system, user } = buildMessages(payload);

  if (provider === "demo") {
    return {
      text: `[Demo translation -> ${payload.targetLanguage || "Chinese"}]\n${String(payload.text || "")
        .split("\n")
        .filter(Boolean)
        .map((line) => `Translated: ${line}`)
        .join("\n")}`,
      usage: { mode: "demo" },
      provider
    };
  }

  if (provider === "gemini") {
    if (!apiKey) throw new Error("Gemini requires an API Key");
    const baseUrl = payload.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    const url = `${joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`)}?key=${encodeURIComponent(apiKey)}`;
    const data = await postJson(url, { "Content-Type": "application/json" }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature }
    });
    return { ...parseProviderData(provider, data), provider };
  }

  if (provider === "claude") {
    if (!apiKey) throw new Error("Claude requires an API Key");
    const baseUrl = payload.baseUrl || "https://api.anthropic.com/v1";
    const data = await postJson(joinUrl(baseUrl, "/messages"), {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }, {
      model,
      max_tokens: Number(payload.maxTokens || 4096),
      temperature,
      system,
      messages: [{ role: "user", content: user }]
    });
    return { ...parseProviderData(provider, data), provider };
  }

  const defaults = {
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    "openai-compatible": "http://localhost:11434/v1"
  };
  if ((provider === "openai" || provider === "deepseek") && !apiKey) throw new Error(`${provider} requires an API Key`);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await postJson(joinUrl(payload.baseUrl || defaults[provider] || defaults["openai-compatible"], "/chat/completions"), headers, {
    model,
    temperature,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return { ...parseProviderData(provider, data), provider };
}

async function createStore() {
  const native = await import("@capacitor/filesystem").catch(() => null);
  if (!native?.Filesystem) return createWebStore();
  const { Filesystem, Directory, Encoding } = native;
  const dataDirectory = Directory.Data;

  async function readText(path, fallback = null) {
    try {
      const result = await Filesystem.readFile({ path, directory: dataDirectory, encoding: Encoding.UTF8 });
      return typeof result.data === "string" ? result.data : await result.data.text();
    } catch {
      return fallback;
    }
  }

  return {
    kind: "capacitor",
    async readJson(path, fallback = null) {
      const text = await readText(path, null);
      return text == null ? fallback : JSON.parse(text);
    },
    async writeJson(path, value) {
      await Filesystem.writeFile({
        path,
        directory: dataDirectory,
        data: `${JSON.stringify(value, null, 2)}\n`,
        encoding: Encoding.UTF8,
        recursive: true
      });
      return value;
    },
    async listJson(dir) {
      try {
        const result = await Filesystem.readdir({ path: dir, directory: dataDirectory });
        const files = result.files || [];
        const rows = [];
        for (const file of files) {
          const name = typeof file === "string" ? file : file.name;
          if (!name || !name.endsWith(".json")) continue;
          const row = await this.readJson(`${dir}/${name}`, null);
          if (row) rows.push(row);
        }
        return rows;
      } catch {
        return [];
      }
    },
    async listProjectJson() {
      try {
        const result = await Filesystem.readdir({ path: "projects", directory: dataDirectory });
        const dirs = result.files || [];
        const rows = [];
        for (const dir of dirs) {
          const name = typeof dir === "string" ? dir : dir.name;
          const row = await this.readJson(`projects/${name}/project.json`, null);
          if (row) rows.push(row);
        }
        return rows;
      } catch {
        return [];
      }
    },
    async cacheStats() {
      const rows = await this.listJson("cache");
      const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
      return { entries: rows.length, bytes };
    },
    async saveBlob(blob, filename) {
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const path = `exports/${filename}`;
      await Filesystem.writeFile({ path, directory: Directory.Documents, data: btoa(binary), recursive: true });
      const uri = await Filesystem.getUri({ path, directory: Directory.Documents });
      const share = await import("@capacitor/share").catch(() => null);
      if (share?.Share?.share) await share.Share.share({ title: filename, url: uri.uri });
      else window.alert(`Saved to ${uri.uri}`);
    }
  };
}

function createWebStore() {
  const prefix = "novelTranslator.native.";
  return {
    kind: "web",
    async readJson(path, fallback = null) {
      const text = localStorage.getItem(prefix + path);
      return text == null ? fallback : JSON.parse(text);
    },
    async writeJson(path, value) {
      localStorage.setItem(prefix + path, JSON.stringify(value));
      return value;
    },
    async listJson(dir) {
      const rows = [];
      const base = `${prefix}${dir}/`;
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith(base) || !key.endsWith(".json")) continue;
        rows.push(JSON.parse(localStorage.getItem(key)));
      }
      return rows;
    },
    async listProjectJson() {
      const rows = [];
      const base = `${prefix}projects/`;
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key?.startsWith(base) || !key.endsWith("/project.json")) continue;
        rows.push(JSON.parse(localStorage.getItem(key)));
      }
      return rows;
    },
    async cacheStats() {
      const rows = await this.listJson("cache");
      const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
      return { entries: rows.length, bytes };
    },
    async saveBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }
  };
}

export function createLocalApi() {
  const active = new Map();
  const storePromise = createStore();

  async function store() {
    return storePromise;
  }

  async function saveProject(project) {
    const db = await store();
    const id = sanitizeId(project.id || randomId("project"), "project");
    const existing = await db.readJson(`projects/${id}/project.json`, null);
    const saved = { ...existing, ...project, id, createdAt: existing?.createdAt || project.createdAt || nowIso(), updatedAt: nowIso() };
    await db.writeJson(`projects/${id}/project.json`, saved);
    return saved;
  }

  async function getProject(projectId) {
    return (await store()).readJson(`projects/${sanitizeId(projectId, "project")}/project.json`, null);
  }

  async function listProjects() {
    const projects = await (await store()).listProjectJson();
    return projects
      .map((project) => ({
        id: project.id,
        title: project.title || project.book?.title || "Untitled project",
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
        lastJobId: project.lastJobId || null,
        resultChapters: Array.isArray(project.results) ? project.results.length : 0,
        chapterCount: Array.isArray(project.book?.chapters) ? project.book.chapters.length : 0
      }))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  async function saveJob(job) {
    const db = await store();
    const id = sanitizeId(job.id || randomId("job"), "job");
    const existing = await db.readJson(`jobs/${id}.json`, null);
    const saved = { ...existing, ...job, id, createdAt: existing?.createdAt || job.createdAt || nowIso(), updatedAt: nowIso() };
    await db.writeJson(`jobs/${id}.json`, saved);
    return saved;
  }

  async function getJob(jobId) {
    return (await store()).readJson(`jobs/${sanitizeId(jobId, "job")}.json`, null);
  }

  async function getCached(cacheKey) {
    const entry = await (await store()).readJson(`cache/${sanitizeId(cacheKey, "cache")}.json`, null);
    if (!entry || entry.version !== CACHE_VERSION || typeof entry.text !== "string") return null;
    return entry;
  }

  async function setCached(cacheKey, payload, translated) {
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
    await (await store()).writeJson(`cache/${sanitizeId(cacheKey, "cache")}.json`, entry);
    return entry;
  }

  async function syncProject(job) {
    if (!job.projectId) return;
    const existing = await getProject(job.projectId);
    await saveProject({
      ...(existing || {}),
      id: job.projectId,
      title: existing?.title || job.book?.title || "Untitled project",
      book: job.book,
      settings: redactConfig(job.config || {}),
      results: buildResults(job),
      glossary: job.config?.glossary || existing?.glossary || "",
      contextBank: job.contextBank || existing?.contextBank || [],
      chapterSummaries: job.chapterSummaries || [],
      qaIssues: job.qaIssues || [],
      consistencyIssues: job.consistencyIssues || [],
      lastJobId: job.id,
      lastJobStatus: job.status,
      lastJobProgress: job.progress,
      jobIds: Array.from(new Set([...(existing?.jobIds || []), job.id]))
    });
  }

  async function persistJob(job) {
    job.progress = summarizeProgress(job.segments || []);
    job.qaIssues = [];
    job.chapterSummaries = [];
    job.consistencyIssues = [];
    const saved = await saveJob(job);
    await syncProject(saved);
    return saved;
  }

  async function run(jobId, secretConfig = {}, control) {
    let job = await getJob(jobId);
    if (!job) throw new Error("Job does not exist");
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
          ...secretConfig,
          chapterIndex: segment.chapterIndex,
          chapterTitle: segment.chapterTitle,
          segmentIndex: segment.segmentIndex,
          segmentsTotal: segment.segmentsTotal,
          chapterSummaries: job.chapterSummaries || [],
          contextBank: job.contextBank || [],
          text: segment.text
        };
        const cacheKey = await buildCacheKey(payload);
        segment.cacheKey = cacheKey;

        if (job.useCache !== false) {
          const cached = await getCached(cacheKey);
          if (cached) {
            segment.translatedText = cached.text.trim();
            segment.status = "cached";
            segment.completedAt = nowIso();
            await persistJob(job);
            continue;
          }
        }

        try {
          const translated = await translateSegment(payload);
          segment.translatedText = String(translated.text || "").trim();
          segment.status = "completed";
          segment.completedAt = nowIso();
          segment.error = null;
          if (job.useCache !== false && segment.translatedText) await setCached(cacheKey, payload, translated);
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
      active.delete(jobId);
    }
  }

  function startRun(jobId, config = {}, options = {}) {
    if (active.has(jobId)) return;
    const control = { pauseRequested: false, retryFailed: Boolean(options.retryFailed) };
    active.set(jobId, control);
    run(jobId, config, control).catch(async (error) => {
      const job = await getJob(jobId);
      if (job) {
        job.status = "failed";
        job.error = String(error.message || error).slice(0, 2000);
        await persistJob(job);
      }
      active.delete(jobId);
    });
  }

  async function createAndStart(payload) {
    if (!payload.book?.chapters?.length) throw new Error("Missing parsed book");
    const config = payload.config || {};
    const selectedChapters = (payload.chapters || [])
      .map((chapter) => ({
        originalIndex: Number(chapter.originalIndex ?? chapter.index ?? 0),
        title: chapter.title || `Chapter ${Number(chapter.originalIndex ?? 0) + 1}`,
        text: chapter.text || ""
      }))
      .filter((chapter) => chapter.text.trim());
    if (!selectedChapters.length) throw new Error("No translatable chapters selected");

    const project = await saveProject({
      id: payload.projectId,
      title: payload.book.title || "Untitled project",
      book: payload.book,
      settings: redactConfig(config),
      results: payload.results || [],
      glossary: config.glossary || payload.glossary || "",
      contextBank: payload.contextBank || [],
      chapterSummaries: payload.chapterSummaries || []
    });
    const job = await saveJob({
      id: randomId("job"),
      projectId: project.id,
      title: `${payload.book.title || "Untitled project"} translation job`,
      status: "queued",
      book: payload.book,
      chapters: selectedChapters,
      config: redactConfig(config),
      contextBank: payload.contextBank || project.contextBank || [],
      chapterSummaries: payload.chapterSummaries || project.chapterSummaries || [],
      qaIssues: [],
      consistencyIssues: [],
      maxRetries: Math.max(0, Math.min(8, Number(config.maxRetries ?? 2))),
      useCache: config.useCache !== false,
      segments: buildSegments(selectedChapters, config),
      progress: null,
      startedAt: null,
      completedAt: null,
      error: null
    });
    startRun(job.id, config);
    return publicJob(await getJob(job.id));
  }

  async function markInterruptedOnStartup() {
    const jobs = await (await store()).listJson("jobs");
    for (const job of jobs) {
      if (job.status !== "running" && job.status !== "queued") continue;
      for (const segment of job.segments || []) {
        if (segment.status === "running") segment.status = "pending";
      }
      job.status = "interrupted";
      job.error = "App restarted while the job was active. You can resume it from the page.";
      await persistJob(job);
    }
  }

  const initialized = markInterruptedOnStartup().catch(() => {});

  async function route(path, options = {}) {
    await initialized;
    const method = String(options.method || "GET").toUpperCase();
    const payload = options.body ? JSON.parse(options.body) : {};
    if (method === "GET" && path === "/api/health") return { ok: true, version: "capacitor-core", node: "native-webview" };
    if (method === "POST" && path === "/api/parse-book") return parseBook(payload);
    if (method === "POST" && path === "/api/jobs/start") return createAndStart(payload);
    if (method === "GET" && path === "/api/projects") return { projects: await listProjects() };
    if (method === "POST" && path === "/api/projects") return saveProject(payload);
    if (method === "GET" && path === "/api/cache/stats") return (await store()).cacheStats();
    if (method === "POST" && path === "/api/glossary/preview") return { terms: [], matched: [], promptText: "" };

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (method === "GET" && projectMatch) {
      const project = await getProject(decodeURIComponent(projectMatch[1]));
      if (!project) throw new Error("Project does not exist");
      return project;
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      const job = await getJob(decodeURIComponent(jobMatch[1]));
      if (!job) throw new Error("Job does not exist");
      return publicJob(job);
    }

    const jobActionMatch = path.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|retry-failed)$/);
    if (method === "POST" && jobActionMatch) {
      const jobId = decodeURIComponent(jobActionMatch[1]);
      const action = jobActionMatch[2];
      if (action === "pause") {
        const control = active.get(jobId);
        if (control) control.pauseRequested = true;
        const job = await getJob(jobId);
        if (!job) throw new Error("Job does not exist");
        if (!control && !TERMINAL_STATUSES.has(job.status)) job.status = "paused";
        return publicJob(await persistJob(job));
      }
      const job = await getJob(jobId);
      if (!job) throw new Error("Job does not exist");
      if (active.has(jobId)) return publicJob(job);
      for (const segment of job.segments) {
        if (action === "retry-failed" && segment.status === "failed") {
          segment.status = "pending";
          segment.error = null;
        }
        if (segment.status === "running" || segment.status === "interrupted") segment.status = "pending";
      }
      job.status = "queued";
      await persistJob(job);
      startRun(jobId, payload.config || payload, { retryFailed: action === "retry-failed" });
      return publicJob(await getJob(jobId));
    }

    throw new Error(`Unknown local API route: ${method} ${path}`);
  }

  return {
    mode: "capacitor",
    async request(path, options = {}) {
      return route(path, options);
    },
    async requestBlob(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase();
      if (method === "POST" && path === "/api/export-epub") {
        const payload = options.body ? JSON.parse(options.body) : {};
        return new Blob([createEpub(payload)], { type: "application/epub+zip" });
      }
      throw new Error(`Unknown local blob route: ${method} ${path}`);
    },
    async saveBlob(blob, filename) {
      return (await store()).saveBlob(blob, filename);
    }
  };
}
