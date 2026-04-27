const {
  nowIso,
  randomId,
  saveJob,
  getJob,
  listJobs,
  saveProject,
  getProject
} = require("./storage");
const { buildCacheKey, getCachedTranslation, setCachedTranslation } = require("./cache");
const { checkJob } = require("./qa");
const { buildChapterSummaries, consistencyIssues } = require("./summaries");

const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "paused", "interrupted"]);

function redactConfig(config = {}) {
  const { apiKey, ...publicConfig } = config;
  return publicConfig;
}

function buildSegments(chapters, config, chunkText) {
  const maxChars = Math.max(600, Number(config.chunkSize || 1800));
  const preserveParagraphs = config.preserveParagraphs !== false;
  return chapters.flatMap((chapter) => {
    const chunks = chunkText(chapter.text || "", maxChars, preserveParagraphs);
    return chunks.map((text, index) => ({
      id: `c${chapter.originalIndex + 1}-s${index + 1}`,
      chapterIndex: chapter.originalIndex,
      chapterTitle: chapter.title || `第 ${chapter.originalIndex + 1} 章`,
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

function summarizeProgress(segments) {
  const progress = {
    total: segments.length,
    pending: 0,
    running: 0,
    completed: 0,
    cached: 0,
    failed: 0,
    interrupted: 0
  };
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

function retryDelayMs(attempt) {
  const base = Math.min(30000, 1000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 400);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error) {
  if (error?.retryable != null) return Boolean(error.retryable);
  if (!error?.status) return true;
  return error.status === 429 || error.status >= 500;
}

function createJobManager({ translateSegment, chunkText }) {
  const active = new Map();

  async function syncProject(job) {
    if (!job.projectId) return;
    const existing = await getProject(job.projectId);
    const project = {
      ...(existing || {}),
      id: job.projectId,
      title: existing?.title || job.book?.title || "未命名项目",
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
    };
    await saveProject(project);
  }

  async function persistJob(job) {
    job.progress = summarizeProgress(job.segments || []);
    job.qaIssues = checkJob(job);
    job.chapterSummaries = buildChapterSummaries(job);
    job.consistencyIssues = consistencyIssues(job);
    const saved = await saveJob(job);
    await syncProject(saved);
    return saved;
  }

  async function createAndStart(payload) {
    if (!payload.book?.chapters?.length) throw new Error("缺少已解析的书籍内容");
    const config = payload.config || {};
    const selectedChapters = (payload.chapters || []).map((chapter) => ({
      originalIndex: Number(chapter.originalIndex ?? chapter.index ?? 0),
      title: chapter.title || `第 ${Number(chapter.originalIndex ?? 0) + 1} 章`,
      text: chapter.text || ""
    })).filter((chapter) => chapter.text.trim());

    if (!selectedChapters.length) throw new Error("没有可翻译章节");

    const project = await saveProject({
      id: payload.projectId,
      title: payload.book.title || "未命名项目",
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
      title: `${payload.book.title || "未命名项目"} 翻译任务`,
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
      segments: buildSegments(selectedChapters, config, chunkText),
      progress: null,
      startedAt: null,
      completedAt: null,
      error: null
    });

    startRun(job.id, config);
    return publicJob(await getJob(job.id));
  }

  async function run(jobId, secretConfig = {}, control) {
    let job = await getJob(jobId);
    if (!job) throw new Error("任务不存在");
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
        const cacheKey = buildCacheKey(payload);
        segment.cacheKey = cacheKey;

        if (job.useCache !== false) {
          const cached = await getCachedTranslation(cacheKey);
          if (cached) {
            segment.translatedText = cached.text.trim();
            segment.status = "cached";
            segment.completedAt = nowIso();
            await persistJob(job);
            continue;
          }
        }

        try {
          const translated = await translateWithRetry(payload, segment, job, control);
          segment.translatedText = String(translated.text || "").trim();
          segment.status = "completed";
          segment.completedAt = nowIso();
          segment.error = null;
          if (job.useCache !== false && segment.translatedText) {
            await setCachedTranslation(cacheKey, payload, {
              text: segment.translatedText,
              usage: translated.usage || null
            });
          }
        } catch (error) {
          if (error?.paused) {
            segment.status = "pending";
            segment.error = null;
            job.status = "paused";
            await persistJob(job);
            return;
          }
          segment.status = "failed";
          segment.error = String(error.message || error).slice(0, 2000);
          job.error = segment.error;
        }

        await persistJob(job);
      }

      job.progress = summarizeProgress(job.segments);
      if (job.progress.failed > 0 && job.progress.done > 0) {
        job.status = "completed_with_errors";
      } else if (job.progress.failed > 0) {
        job.status = "failed";
      } else {
        job.status = "completed";
      }
      job.completedAt = nowIso();
      await persistJob(job);
    } finally {
      active.delete(jobId);
    }
  }

  async function translateWithRetry(payload, segment, job, control) {
    const maxRetries = Math.max(0, Number(job.maxRetries ?? 2));
    let lastError;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      if (control.pauseRequested) {
        const error = new Error("任务已暂停");
        error.paused = true;
        throw error;
      }
      segment.attempts += 1;
      segment.lastAttemptAt = nowIso();
      await persistJob(job);
      try {
        return await translateSegment(payload);
      } catch (error) {
        lastError = error;
        segment.error = String(error.message || error).slice(0, 2000);
        await persistJob(job);
        if (attempt > maxRetries || !isRetryable(error)) break;
        await sleep(retryDelayMs(attempt));
      }
    }
    throw lastError;
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

  async function getSnapshot(jobId) {
    const job = await getJob(jobId);
    return publicJob(job);
  }

  async function pause(jobId) {
    const control = active.get(jobId);
    if (control) {
      control.pauseRequested = true;
      return getSnapshot(jobId);
    }
    const job = await getJob(jobId);
    if (!job) throw new Error("任务不存在");
    if (!TERMINAL_STATUSES.has(job.status)) job.status = "paused";
    return publicJob(await persistJob(job));
  }

  async function resume(jobId, config = {}) {
    const job = await getJob(jobId);
    if (!job) throw new Error("任务不存在");
    if (active.has(jobId)) return publicJob(job);
    for (const segment of job.segments) {
      if (segment.status === "running" || segment.status === "interrupted") {
        segment.status = "pending";
      }
    }
    job.status = "queued";
    await persistJob(job);
    startRun(jobId, config);
    return getSnapshot(jobId);
  }

  async function retryFailed(jobId, config = {}) {
    const job = await getJob(jobId);
    if (!job) throw new Error("任务不存在");
    if (active.has(jobId)) return publicJob(job);
    for (const segment of job.segments) {
      if (segment.status === "failed") {
        segment.status = "pending";
        segment.error = null;
      }
      if (segment.status === "running" || segment.status === "interrupted") {
        segment.status = "pending";
      }
    }
    job.status = "queued";
    await persistJob(job);
    startRun(jobId, config, { retryFailed: true });
    return getSnapshot(jobId);
  }

  async function markInterruptedOnStartup() {
    const jobs = await listJobs();
    for (const job of jobs) {
      if (job.status !== "running" && job.status !== "queued") continue;
      for (const segment of job.segments || []) {
        if (segment.status === "running") segment.status = "pending";
      }
      job.status = "interrupted";
      job.error = "服务重启后任务已中断，可在页面中继续翻译。";
      await persistJob(job);
    }
  }

  return {
    createAndStart,
    getSnapshot,
    pause,
    resume,
    retryFailed,
    markInterruptedOnStartup
  };
}

module.exports = {
  createJobManager,
  buildResults,
  summarizeProgress,
  redactConfig
};
