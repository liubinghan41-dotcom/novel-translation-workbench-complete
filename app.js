const API_BASE = window.location.protocol === "file:" ? "http://localhost:4173" : "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const els = {
  fileInput: $("#fileInput"),
  dropZone: $("#dropZone"),
  fileName: $("#fileName"),
  fileSize: $("#fileSize"),
  parseState: $("#parseState"),
  chapterList: $("#chapterList"),
  chapterCount: $("#chapterCount"),
  sourceLanguage: $("#sourceLanguage"),
  targetLanguage: $("#targetLanguage"),
  provider: $("#provider"),
  model: $("#model"),
  baseUrl: $("#baseUrl"),
  apiKey: $("#apiKey"),
  temperature: $("#temperature"),
  temperatureValue: $("#temperatureValue"),
  startChapter: $("#startChapter"),
  endChapter: $("#endChapter"),
  selectAllChapters: $("#selectAllChapters"),
  sourcePreview: $("#sourcePreview"),
  translatedPreview: $("#translatedPreview"),
  sourcePreviewBadge: $("#sourcePreviewBadge"),
  targetPreviewBadge: $("#targetPreviewBadge"),
  sourceStats: $("#sourceStats"),
  targetStats: $("#targetStats"),
  copySourceButton: $("#copySourceButton"),
  copyResultButton: $("#copyResultButton"),
  progressFill: $("#progressFill"),
  progressText: $("#progressText"),
  segmentCount: $("#segmentCount"),
  costText: $("#costText"),
  jobStatus: $("#jobStatus"),
  startButton: $("#startButton"),
  pauseButton: $("#pauseButton"),
  resumeButton: $("#resumeButton"),
  retryFailedButton: $("#retryFailedButton"),
  saveProjectButton: $("#saveProjectButton"),
  projectSelect: $("#projectSelect"),
  loadProjectButton: $("#loadProjectButton"),
  exportProjectButton: $("#exportProjectButton"),
  importProjectInput: $("#importProjectInput"),
  exportTxtButton: $("#exportTxtButton"),
  exportEpubButton: $("#exportEpubButton"),
  presetSelect: $("#presetSelect"),
  presetName: $("#presetName"),
  presetTemperature: $("#presetTemperature"),
  presetPrompt: $("#presetPrompt"),
  newPresetButton: $("#newPresetButton"),
  savePresetButton: $("#savePresetButton"),
  deletePresetButton: $("#deletePresetButton"),
  presetImport: $("#presetImport"),
  exportPresetButton: $("#exportPresetButton"),
  glossary: $("#glossary"),
  contextSummary: $("#contextSummary"),
  contextBank: $("#contextBank"),
  chunkSize: $("#chunkSize"),
  maxRetries: $("#maxRetries"),
  glossaryLimit: $("#glossaryLimit"),
  retrievalCount: $("#retrievalCount"),
  preserveParagraphs: $("#preserveParagraphs"),
  useCache: $("#useCache"),
  rememberApiKey: $("#rememberApiKey"),
  qaIssueList: $("#qaIssueList"),
  summaryList: $("#summaryList"),
  consistencyList: $("#consistencyList"),
  healthButton: $("#healthButton"),
  toast: $("#toast"),
  logBox: $("#logBox"),
  cacheStats: $("#cacheStats"),
  sidebarBookCount: $("#sidebarBookCount"),
  sidebarMeter: $("#sidebarMeter")
};

const providerDefaults = {
  "openai-compatible": {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    note: "OpenAI 兼容格式：POST /chat/completions。"
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    note: "OpenAI 官方格式：POST /v1/chat/completions。"
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    note: "DeepSeek 使用 OpenAI 兼容格式。"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash-lite",
    note: "Gemini 格式：POST /models/{model}:generateContent。"
  },
  claude: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-3-5-haiku-latest",
    note: "Claude 格式：POST /v1/messages。"
  },
  demo: {
    baseUrl: "",
    model: "demo-translator",
    note: "Demo 离线模式不会调用外部 API。"
  }
};

const defaultPresets = [
  {
    id: "faithful",
    name: "忠实直译",
    temperature: 0.2,
    prompt:
      "你是严谨的文学翻译。请将{{sourceLanguage}}小说翻译为{{targetLanguage}}，保持原意、叙述顺序和段落结构。专有名词遵循术语表。只输出译文。"
  },
  {
    id: "smooth",
    name: "流畅自然",
    temperature: 0.35,
    prompt:
      "你是中文小说译者。请将{{sourceLanguage}}文本翻译成自然、流畅、适合阅读的{{targetLanguage}}，保留原文信息和人物语气。只输出译文。"
  },
  {
    id: "lightnovel",
    name: "轻小说风",
    temperature: 0.55,
    prompt:
      "你熟悉日式轻小说译文风格。请将{{sourceLanguage}}小说翻译为轻快、口语自然、适合轻小说阅读的{{targetLanguage}}。保留人物称呼差异和对话语气。只输出译文。"
  }
];

const state = {
  book: null,
  projectId: null,
  jobId: null,
  presets: [],
  activePresetId: "faithful",
  results: [],
  qaIssues: [],
  chapterSummaries: [],
  consistencyIssues: [],
  isPolling: false,
  pollTimer: null
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function log(message) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  els.logBox.textContent = `[${time}] ${message}\n${els.logBox.textContent}`.slice(0, 9000);
}

function formatSize(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || data.detail || response.statusText);
  return data;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraphsHtml(text, maxParagraphs = 6) {
  const paragraphs = String(text || "")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxParagraphs);
  if (!paragraphs.length) return "<p>暂无内容。</p>";
  return paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
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

function getSelectedChapters() {
  if (!state.book?.chapters?.length) return [];
  const start = Number(els.startChapter.value || 1) - 1;
  const end = Number(els.endChapter.value || state.book.chapters.length) - 1;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return state.book.chapters.slice(from, to + 1).map((chapter, index) => ({
    ...chapter,
    originalIndex: from + index
  }));
}

function updateProgress(value) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value || 0)));
  els.progressFill.style.width = `${safeValue}%`;
  els.progressText.textContent = `${safeValue}%`;
}

function estimate() {
  const chapters = getSelectedChapters();
  const chars = chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  const chunkSize = Math.max(600, Number(els.chunkSize.value || 1800));
  const chunks = chapters.reduce((sum, chapter) => sum + chunkText(chapter.text, chunkSize, els.preserveParagraphs.checked).length, 0);
  const roughRates = {
    openai: 0.0000012,
    deepseek: 0.00000035,
    gemini: 0.0000005,
    claude: 0.0000022,
    "openai-compatible": 0.0000002,
    demo: 0
  };
  const cost = chars * (roughRates[els.provider.value] ?? 0.000001);
  els.sourceStats.textContent = `共 ${chapters.length} 章 / 约 ${formatNumber(chars)} 字符`;
  els.targetStats.textContent = state.results.length
    ? `已生成 ${state.results.length} 章 / 约 ${formatNumber(resultText().length)} 字符`
    : `共 ${chapters.length} 章 / 约 ${formatNumber(chars)} 字符`;
  els.segmentCount.textContent = `${chunks} 个片段`;
  els.costText.textContent = `$${cost.toFixed(4)}`;
}

function renderChapters() {
  const chapters = state.book?.chapters || [];
  els.chapterCount.textContent = chapters.length;
  els.sidebarBookCount.textContent = state.book ? "1 本" : "0 本";
  els.sidebarMeter.style.width = state.book ? "35%" : "0%";
  if (!chapters.length) {
    els.chapterList.innerHTML = '<p class="empty-note">上传或加载项目后会列出章节。</p>';
    els.startChapter.innerHTML = "";
    els.endChapter.innerHTML = "";
    return;
  }
  els.chapterList.innerHTML = chapters
    .map((chapter, index) => `
      <button class="chapter-item" type="button" data-chapter-index="${index}">
        <strong>${index + 1}</strong>
        <span title="${escapeHtml(chapter.title)}">${escapeHtml(chapter.title || `第 ${index + 1} 章`)}</span>
        <small>${formatNumber(chapter.text.length)}</small>
      </button>
    `)
    .join("");
  const options = chapters
    .map((chapter, index) => `<option value="${index + 1}">第 ${index + 1} 章：${escapeHtml(chapter.title || "")}</option>`)
    .join("");
  els.startChapter.innerHTML = options;
  els.endChapter.innerHTML = options;
  els.startChapter.value = "1";
  els.endChapter.value = String(chapters.length);
  $$(".chapter-item").forEach((button) => {
    button.addEventListener("click", () => {
      els.startChapter.value = String(Number(button.dataset.chapterIndex) + 1);
      updatePreview();
    });
  });
}

function updatePreview() {
  const chapters = getSelectedChapters();
  const first = chapters[0];
  if (!first) {
    els.sourcePreview.innerHTML = "<p>上传小说后会显示选中起始章节。</p>";
    els.sourcePreviewBadge.textContent = "未加载";
    estimate();
    return;
  }
  els.sourcePreview.innerHTML = paragraphsHtml(first.text, 7);
  els.sourcePreviewBadge.textContent = first.title || `第 ${first.originalIndex + 1} 章`;
  renderTranslatedPreview();
  estimate();
}

function resultText() {
  return state.results
    .map((chapter) => `# ${chapter.title}\n\n${chapter.translatedText || ""}`.trim())
    .join("\n\n\n");
}

function parseContextBank(raw) {
  return String(raw || "")
    .split(/\n{2,}/)
    .map((block, index) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
      const title = lines.length > 1 && lines[0].length <= 80 ? lines.shift() : `资料 ${index + 1}`;
      return {
        id: `ctx-${index + 1}`,
        title,
        text: lines.join("\n") || block
      };
    });
}

function serializeContextBank(items) {
  return (items || [])
    .map((item) => [item.title || "", item.text || item.content || ""].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

function renderTranslatedPreview() {
  if (!state.results.length) {
    els.translatedPreview.innerHTML = "<p>开始任务后会实时追加已完成章节。</p>";
    els.targetPreviewBadge.textContent = "等待翻译";
    renderInsights();
    return;
  }
  els.translatedPreview.innerHTML = paragraphsHtml(resultText(), 10);
  els.targetPreviewBadge.textContent = `${state.results.length} 章`;
  renderInsights();
}

function insightItem(message, severity = "") {
  return `<div class="insight-item ${escapeHtml(severity)}">${escapeHtml(message)}</div>`;
}

function renderInsights() {
  const issues = state.qaIssues || [];
  els.qaIssueList.innerHTML = issues.length
    ? issues
        .slice(0, 80)
        .map((issue) => insightItem(`${issue.chapterTitle || ""} #${issue.segmentIndex || "-"}：${issue.message}`, issue.severity))
        .join("")
    : "暂无问题。";

  const summaries = state.chapterSummaries || [];
  els.summaryList.innerHTML = summaries.length
    ? summaries
        .slice(0, 60)
        .map((summary) => insightItem(`${summary.title || `第 ${summary.chapterIndex + 1} 章`}：${summary.summary}`))
        .join("")
    : "暂无摘要。";

  const consistency = state.consistencyIssues || [];
  els.consistencyList.innerHTML = consistency.length
    ? consistency.slice(0, 60).map((issue) => insightItem(issue.message, issue.severity)).join("")
    : "暂无一致性问题。";
}

function activePreset() {
  return state.presets.find((preset) => preset.id === state.activePresetId) || state.presets[0];
}

function loadPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem("novelTranslator.presets") || "null");
    state.presets = Array.isArray(saved) && saved.length ? saved : defaultPresets;
  } catch {
    state.presets = defaultPresets;
  }
  state.presets = state.presets.map((preset) => ({
    id: preset.id || uid("preset"),
    name: preset.name || "未命名预设",
    temperature: Number(preset.temperature ?? 0.35),
    prompt: preset.prompt || ""
  }));
  state.activePresetId = localStorage.getItem("novelTranslator.activePresetId") || state.presets[0].id;
  if (!state.presets.some((preset) => preset.id === state.activePresetId)) state.activePresetId = state.presets[0].id;
}

function persistPresets() {
  localStorage.setItem("novelTranslator.presets", JSON.stringify(state.presets));
  localStorage.setItem("novelTranslator.activePresetId", state.activePresetId);
}

function renderPresetSelect() {
  els.presetSelect.innerHTML = state.presets
    .map((preset) => `<option value="${preset.id}">${escapeHtml(preset.name)}</option>`)
    .join("");
  els.presetSelect.value = state.activePresetId;
  renderPresetEditor();
}

function renderPresetEditor() {
  const preset = activePreset();
  if (!preset) return;
  els.presetName.value = preset.name;
  els.presetTemperature.value = preset.temperature;
  els.presetPrompt.value = preset.prompt;
  els.temperature.value = String(preset.temperature);
  els.temperatureValue.textContent = Number(preset.temperature).toFixed(2);
}

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  return "";
}

function promptEntryContent(entry) {
  const fields = ["content", "prompt", "system_prompt", "main_prompt", "jailbreak_prompt", "story_string", "template", "message"];
  for (const field of fields) {
    const value = textValue(entry[field]);
    if (value) return value;
  }
  return "";
}

function parseImportedPresets(raw, fileName) {
  const parsed = JSON.parse(raw);
  const roots = Array.isArray(parsed) ? parsed : parsed?.presets || [parsed];
  return roots
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const prompt = Array.isArray(item.prompts)
        ? item.prompts.map(promptEntryContent).filter(Boolean).join("\n\n")
        : promptEntryContent(item);
      if (!prompt.trim()) return null;
      return {
        id: uid("preset"),
        name: item.name || item.preset_name || item.title || fileName.replace(/\.[^.]+$/, ""),
        temperature: Number(item.temperature ?? item.temp ?? 0.35),
        prompt
      };
    })
    .filter(Boolean);
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("novelTranslator.settings") || "{}");
    for (const [key, value] of Object.entries(saved)) {
      if (!els[key] || key === "apiKey") continue;
      if (els[key].type === "checkbox") els[key].checked = Boolean(value);
      else els[key].value = value;
    }
  } catch {
    // Ignore malformed local settings.
  }
  const rememberedKey = localStorage.getItem("novelTranslator.apiKey");
  const sessionKey = sessionStorage.getItem("novelTranslator.apiKey");
  if (rememberedKey) {
    els.apiKey.value = rememberedKey;
    els.rememberApiKey.checked = true;
  } else if (sessionKey) {
    els.apiKey.value = sessionKey;
  }
  els.temperatureValue.textContent = Number(els.temperature.value).toFixed(2);
}

function publicConfig(config) {
  const { apiKey, ...rest } = config;
  return rest;
}

function saveSettings() {
  const data = publicConfig(currentConfig());
  localStorage.setItem("novelTranslator.settings", JSON.stringify(data));
  if (els.rememberApiKey.checked) {
    localStorage.setItem("novelTranslator.apiKey", els.apiKey.value);
    sessionStorage.removeItem("novelTranslator.apiKey");
  } else {
    sessionStorage.setItem("novelTranslator.apiKey", els.apiKey.value);
    localStorage.removeItem("novelTranslator.apiKey");
  }
}

function currentConfig() {
  return {
    provider: els.provider.value,
    model: els.model.value.trim(),
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    sourceLanguage: els.sourceLanguage.value,
    targetLanguage: els.targetLanguage.value,
    temperature: Number(els.temperature.value),
    glossary: els.glossary.value.trim(),
    context: els.contextSummary.value.trim(),
    contextBank: parseContextBank(els.contextBank.value),
    promptOptions: {
      glossaryLimit: Math.max(0, Number(els.glossaryLimit.value || 80)),
      retrievalCount: Math.max(0, Number(els.retrievalCount.value || 5))
    },
    preserveParagraphs: els.preserveParagraphs.checked,
    useCache: els.useCache.checked,
    maxRetries: Math.max(0, Math.min(8, Number(els.maxRetries.value || 2))),
    chunkSize: Math.max(600, Number(els.chunkSize.value || 1800)),
    preset: activePreset()
  };
}

function applySettings(settings = {}) {
  if (Array.isArray(settings.contextBank)) {
    els.contextBank.value = serializeContextBank(settings.contextBank);
  }
  if (settings.promptOptions) {
    if (settings.promptOptions.glossaryLimit != null) els.glossaryLimit.value = settings.promptOptions.glossaryLimit;
    if (settings.promptOptions.retrievalCount != null) els.retrievalCount.value = settings.promptOptions.retrievalCount;
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!els[key] || key === "apiKey") continue;
    if (key === "contextBank" || key === "promptOptions") continue;
    if (els[key].type === "checkbox") els[key].checked = Boolean(value);
    else if (key !== "preset") els[key].value = value;
  }
  if (settings.preset?.id && state.presets.some((preset) => preset.id === settings.preset.id)) {
    state.activePresetId = settings.preset.id;
    renderPresetSelect();
  }
  els.temperatureValue.textContent = Number(els.temperature.value).toFixed(2);
}

async function parseFile(file) {
  if (!file) return;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatSize(file.size);
  els.parseState.textContent = "解析中";
  els.jobStatus.textContent = "解析文件中";
  updateProgress(0);
  log(`开始解析 ${file.name}`);
  try {
    const buffer = await file.arrayBuffer();
    const parsed = await api("/api/parse-book", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        type: file.type,
        contentBase64: arrayBufferToBase64(buffer)
      })
    });
    state.book = parsed;
    state.results = [];
    state.projectId = null;
    state.jobId = null;
    els.parseState.textContent = "解析成功";
    els.jobStatus.textContent = `已解析：${parsed.title}`;
    renderChapters();
    updatePreview();
    showToast(`已解析 ${parsed.chapters.length} 个章节`);
    log(`解析完成：${parsed.title}，${parsed.chapters.length} 章，格式 ${parsed.metadata?.format || "未知"}`);
  } catch (error) {
    els.parseState.textContent = "解析失败";
    els.jobStatus.textContent = "解析失败";
    showToast(error.message);
    log(`解析失败：${error.message}`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setProviderDefaults(provider) {
  const defaults = providerDefaults[provider];
  if (!defaults) return;
  els.baseUrl.value = defaults.baseUrl;
  els.model.value = defaults.model;
  log(defaults.note);
  estimate();
}

function requireApiKey(config) {
  return config.provider !== "demo" && config.provider !== "openai-compatible" && !config.apiKey;
}

async function startTranslation() {
  const chapters = getSelectedChapters();
  if (!chapters.length) {
    showToast("请先上传并解析小说文件");
    return;
  }
  const config = currentConfig();
  if (requireApiKey(config)) {
    showToast("当前服务商需要 API Key");
    return;
  }
  saveSettings();
  try {
    const job = await api("/api/jobs/start", {
      method: "POST",
      body: JSON.stringify({
        projectId: state.projectId,
        book: state.book,
        chapters,
        config,
        contextBank: config.contextBank,
        chapterSummaries: state.chapterSummaries,
        results: state.results
      })
    });
    state.projectId = job.projectId;
    state.jobId = job.id;
    applyJob(job);
    pollJob();
    showToast("翻译任务已启动");
    log(`启动任务：${job.id}`);
    await refreshProjectList();
  } catch (error) {
    showToast(error.message);
    log(`启动任务失败：${error.message}`);
  }
}

function statusLabel(status) {
  return {
    queued: "排队中",
    running: "翻译中",
    paused: "已暂停",
    interrupted: "已中断，可继续",
    completed: "翻译完成",
    completed_with_errors: "部分完成，有失败片段",
    failed: "失败"
  }[status] || status || "未知";
}

function applyJob(job) {
  if (!job) return;
  state.jobId = job.id;
  state.projectId = job.projectId || state.projectId;
  state.results = job.results || [];
  state.qaIssues = job.qaIssues || [];
  state.chapterSummaries = job.chapterSummaries || [];
  state.consistencyIssues = job.consistencyIssues || [];
  const progress = job.progress || {};
  updateProgress(progress.percent || 0);
  els.segmentCount.textContent = `${progress.done || 0}/${progress.total || 0} 完成 · ${progress.cached || 0} 缓存 · ${progress.failed || 0} 失败`;
  els.jobStatus.textContent = `${statusLabel(job.status)}${job.error ? `：${job.error}` : ""}`;
  els.targetPreviewBadge.textContent = statusLabel(job.status);
  renderTranslatedPreview();
  estimate();
  const active = job.status === "queued" || job.status === "running";
  els.startButton.disabled = active;
  els.pauseButton.disabled = !active;
  els.resumeButton.disabled = active || !state.jobId;
  els.retryFailedButton.disabled = active || !(progress.failed > 0);
}

function stopPolling() {
  state.isPolling = false;
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function pollJob() {
  if (!state.jobId) return;
  stopPolling();
  state.isPolling = true;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}`);
    applyJob(job);
    if (job.status === "queued" || job.status === "running") {
      state.pollTimer = window.setTimeout(pollJob, 1200);
    } else {
      state.isPolling = false;
      await refreshCacheStats();
      await refreshProjectList();
      if (job.status === "completed") showToast("翻译完成，可以导出结果");
    }
  } catch (error) {
    log(`刷新任务失败：${error.message}`);
    state.pollTimer = window.setTimeout(pollJob, 2200);
  }
}

async function pauseJob() {
  if (!state.jobId) return;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/pause`, { method: "POST", body: "{}" });
    applyJob(job);
    showToast("已请求暂停");
    log("任务将在当前片段结束后暂停");
  } catch (error) {
    showToast(error.message);
  }
}

async function resumeJob() {
  if (!state.jobId) return;
  const config = currentConfig();
  if (requireApiKey(config)) {
    showToast("继续真实模型任务需要重新填写 API Key");
    return;
  }
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ config })
    });
    applyJob(job);
    pollJob();
    showToast("任务已继续");
    log(`继续任务：${state.jobId}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function retryFailedJob() {
  if (!state.jobId) return;
  const config = currentConfig();
  if (requireApiKey(config)) {
    showToast("重试真实模型任务需要重新填写 API Key");
    return;
  }
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.jobId)}/retry-failed`, {
      method: "POST",
      body: JSON.stringify({ config })
    });
    applyJob(job);
    pollJob();
    showToast("失败片段已重新排队");
    log(`重试失败片段：${state.jobId}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function saveCurrentProject() {
  if (!state.book) {
    showToast("请先上传或加载小说");
    return;
  }
  try {
    const saved = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        id: state.projectId,
        title: state.book.title || "未命名项目",
        book: state.book,
        settings: publicConfig(currentConfig()),
        contextBank: parseContextBank(els.contextBank.value),
        chapterSummaries: state.chapterSummaries,
        qaIssues: state.qaIssues,
        consistencyIssues: state.consistencyIssues,
        results: state.results,
        lastJobId: state.jobId
      })
    });
    state.projectId = saved.id;
    showToast("项目已保存");
    log(`保存项目：${saved.title || saved.id}`);
    await refreshProjectList();
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshProjectList() {
  try {
    const data = await api("/api/projects");
    const projects = data.projects || [];
    els.projectSelect.innerHTML = projects.length
      ? projects.map((project) => `<option value="${project.id}">${escapeHtml(project.title)} · ${project.resultChapters || 0}/${project.chapterCount || 0}</option>`).join("")
      : '<option value="">暂无已保存项目</option>';
    if (state.projectId) els.projectSelect.value = state.projectId;
  } catch (error) {
    log(`加载项目列表失败：${error.message}`);
  }
}

async function loadSelectedProject() {
  const projectId = els.projectSelect.value;
  if (!projectId) return;
  try {
    const project = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    applyProject(project);
    showToast("项目已加载");
    log(`加载项目：${project.title || project.id}`);
  } catch (error) {
    showToast(error.message);
  }
}

function applyProject(project) {
  state.projectId = project.id;
  state.book = project.book || null;
  state.results = project.results || [];
  state.qaIssues = project.qaIssues || [];
  state.chapterSummaries = project.chapterSummaries || [];
  state.consistencyIssues = project.consistencyIssues || [];
  state.jobId = project.lastJobId || null;
  if (project.contextBank && !project.settings?.contextBank) {
    els.contextBank.value = serializeContextBank(project.contextBank);
  }
  if (project.settings) applySettings(project.settings);
  els.fileName.textContent = state.book?.title || project.title || "已加载项目";
  els.fileSize.textContent = "-";
  els.parseState.textContent = state.book ? "已加载" : "未解析";
  renderChapters();
  updatePreview();
  renderTranslatedPreview();
  if (state.jobId) pollJob();
}

async function exportProject() {
  if (!state.book) {
    showToast("没有可导出的项目");
    return;
  }
  const project = {
    id: state.projectId,
    title: state.book.title || "未命名项目",
    book: state.book,
    settings: publicConfig(currentConfig()),
    contextBank: parseContextBank(els.contextBank.value),
    chapterSummaries: state.chapterSummaries,
    qaIssues: state.qaIssues,
    consistencyIssues: state.consistencyIssues,
    results: state.results,
    lastJobId: state.jobId,
    exportedAt: new Date().toISOString()
  };
  downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json;charset=utf-8" }), `${project.title}.json`);
}

async function importProject(file) {
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    const saved = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify(project)
    });
    applyProject(saved);
    await refreshProjectList();
    showToast("项目已导入");
  } catch (error) {
    showToast(`导入失败：${error.message}`);
  } finally {
    els.importProjectInput.value = "";
  }
}

async function exportEpub() {
  if (!state.results.length) {
    showToast("请先完成至少一个章节的翻译");
    return;
  }
  const response = await fetch(`${API_BASE}/api/export-epub`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `${state.book?.title || "translated-novel"} - 译文`,
      chapters: state.results.map((chapter) => ({
        title: chapter.title,
        text: chapter.translatedText
      }))
    })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  const blob = await response.blob();
  downloadBlob(blob, `${state.book?.title || "translated-novel"}-译文.epub`);
  log("已导出 EPUB");
}

async function refreshCacheStats() {
  try {
    const stats = await api("/api/cache/stats");
    els.cacheStats.textContent = `缓存：${stats.entries || 0} 条 · ${formatSize(stats.bytes || 0)}`;
  } catch {
    els.cacheStats.textContent = "缓存：不可用";
  }
}

function bindEvents() {
  els.fileInput.addEventListener("change", (event) => parseFile(event.target.files[0]));
  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("is-dragover");
    });
  });
  els.dropZone.addEventListener("drop", (event) => parseFile(event.dataTransfer.files[0]));

  [els.startChapter, els.endChapter, els.chunkSize, els.preserveParagraphs, els.provider].forEach((element) => {
    element.addEventListener("change", () => {
      if (element === els.provider) setProviderDefaults(els.provider.value);
      updatePreview();
      saveSettings();
    });
  });

  [
    els.sourceLanguage,
    els.targetLanguage,
    els.model,
    els.baseUrl,
    els.glossary,
    els.contextSummary,
    els.contextBank,
    els.maxRetries,
    els.glossaryLimit,
    els.retrievalCount,
    els.useCache
  ].forEach((element) => {
    element.addEventListener("change", saveSettings);
  });

  els.selectAllChapters.addEventListener("click", () => {
    if (!state.book?.chapters?.length) return;
    els.startChapter.value = "1";
    els.endChapter.value = String(state.book.chapters.length);
    updatePreview();
  });

  els.temperature.addEventListener("input", () => {
    els.temperatureValue.textContent = Number(els.temperature.value).toFixed(2);
  });

  els.presetSelect.addEventListener("change", () => {
    state.activePresetId = els.presetSelect.value;
    persistPresets();
    renderPresetEditor();
    saveSettings();
  });

  els.newPresetButton.addEventListener("click", () => {
    const preset = {
      id: uid("preset"),
      name: "新建预设",
      temperature: Number(els.temperature.value || 0.35),
      prompt: "请将{{sourceLanguage}}文本翻译为{{targetLanguage}}。只输出译文。\n\n{{text}}"
    };
    state.presets.push(preset);
    state.activePresetId = preset.id;
    persistPresets();
    renderPresetSelect();
  });

  els.savePresetButton.addEventListener("click", () => {
    const preset = activePreset();
    if (!preset) return;
    preset.name = els.presetName.value.trim() || preset.name;
    preset.temperature = Number(els.presetTemperature.value || els.temperature.value || 0.35);
    preset.prompt = els.presetPrompt.value.trim();
    persistPresets();
    renderPresetSelect();
    showToast("预设已保存");
  });

  els.deletePresetButton.addEventListener("click", () => {
    if (state.presets.length <= 1) {
      showToast("至少保留一个预设");
      return;
    }
    state.presets = state.presets.filter((preset) => preset.id !== state.activePresetId);
    state.activePresetId = state.presets[0].id;
    persistPresets();
    renderPresetSelect();
  });

  els.presetImport.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const imported = parseImportedPresets(await file.text(), file.name);
      if (!imported.length) throw new Error("JSON 中没有可用 prompt");
      state.presets.push(...imported);
      state.activePresetId = imported[0].id;
      persistPresets();
      renderPresetSelect();
      showToast(`已导入 ${imported.length} 个预设`);
    } catch (error) {
      showToast(`导入失败：${error.message}`);
    } finally {
      event.target.value = "";
    }
  });

  els.exportPresetButton.addEventListener("click", () => {
    const preset = activePreset();
    downloadBlob(new Blob([JSON.stringify(preset, null, 2)], { type: "application/json;charset=utf-8" }), `${preset.name}.json`);
  });

  els.startButton.addEventListener("click", startTranslation);
  els.pauseButton.addEventListener("click", pauseJob);
  els.resumeButton.addEventListener("click", resumeJob);
  els.retryFailedButton.addEventListener("click", retryFailedJob);
  els.saveProjectButton.addEventListener("click", saveCurrentProject);
  els.loadProjectButton.addEventListener("click", loadSelectedProject);
  els.exportProjectButton.addEventListener("click", exportProject);
  els.importProjectInput.addEventListener("change", (event) => importProject(event.target.files[0]));

  els.exportTxtButton.addEventListener("click", () => {
    if (!state.results.length) {
      showToast("请先完成至少一个章节的翻译");
      return;
    }
    downloadBlob(new Blob([resultText()], { type: "text/plain;charset=utf-8" }), `${state.book?.title || "translated-novel"}-译文.txt`);
    log("已导出 TXT");
  });

  els.exportEpubButton.addEventListener("click", () => {
    exportEpub().catch((error) => {
      showToast(error.message);
      log(`EPUB 导出失败：${error.message}`);
    });
  });

  els.copySourceButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(getSelectedChapters().map((chapter) => chapter.text).join("\n\n"));
    showToast("已复制原文");
  });

  els.copyResultButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(resultText());
    showToast("已复制译文");
  });

  els.healthButton.addEventListener("click", async () => {
    try {
      const health = await api("/api/health");
      showToast(`本地服务正常：${health.version}`);
      log(`服务状态正常：${health.node}`);
    } catch (error) {
      showToast("本地服务未启动，请运行 npm start");
      log(`服务检查失败：${error.message}`);
    }
  });
}

async function init() {
  loadPresets();
  loadSettings();
  bindEvents();
  renderPresetSelect();
  updateProgress(0);
  renderChapters();
  updatePreview();
  await refreshProjectList();
  await refreshCacheStats();
  log(`工作台已启动。当前页面 ${window.location.protocol === "file:" ? "通过 file:// 打开，API 将请求 http://localhost:4173" : "通过本地服务打开"}`);
  log(providerDefaults[els.provider.value]?.note || "");
}

init();
