const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(process.env.NTW_DATA_DIR || path.join(ROOT_DIR, "data"));
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const CACHE_DIR = path.join(DATA_DIR, "cache");

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value, prefix = "item") {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function randomId(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.promises.rename(tmp, filePath);
}

function projectDir(projectId) {
  return path.join(PROJECTS_DIR, sanitizeId(projectId, "project"));
}

function projectFile(projectId) {
  return path.join(projectDir(projectId), "project.json");
}

function jobFile(jobId) {
  return path.join(JOBS_DIR, `${sanitizeId(jobId, "job")}.json`);
}

function cacheFile(cacheKey) {
  return path.join(CACHE_DIR, `${sanitizeId(cacheKey, "cache")}.json`);
}

async function initStorage() {
  await Promise.all([ensureDir(PROJECTS_DIR), ensureDir(JOBS_DIR), ensureDir(CACHE_DIR)]);
}

async function saveProject(project) {
  const id = sanitizeId(project.id || randomId("project"), "project");
  const existing = await readJson(projectFile(id), null);
  const saved = {
    ...existing,
    ...project,
    id,
    createdAt: existing?.createdAt || project.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await atomicWriteJson(projectFile(id), saved);
  return saved;
}

async function getProject(projectId) {
  return readJson(projectFile(projectId), null);
}

async function listProjects() {
  await ensureDir(PROJECTS_DIR);
  const entries = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await readJson(path.join(PROJECTS_DIR, entry.name, "project.json"), null);
    if (project) {
      projects.push({
        id: project.id,
        title: project.title || project.book?.title || "未命名项目",
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
        lastJobId: project.lastJobId || null,
        resultChapters: Array.isArray(project.results) ? project.results.length : 0,
        chapterCount: Array.isArray(project.book?.chapters) ? project.book.chapters.length : 0
      });
    }
  }
  return projects.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function saveJob(job) {
  const id = sanitizeId(job.id || randomId("job"), "job");
  const existing = await readJson(jobFile(id), null);
  const saved = {
    ...existing,
    ...job,
    id,
    createdAt: existing?.createdAt || job.createdAt || nowIso(),
    updatedAt: nowIso()
  };
  await atomicWriteJson(jobFile(id), saved);
  return saved;
}

async function getJob(jobId) {
  return readJson(jobFile(jobId), null);
}

async function listJobs() {
  await ensureDir(JOBS_DIR);
  const entries = await fs.promises.readdir(JOBS_DIR, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const job = await readJson(path.join(JOBS_DIR, entry.name), null);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function cacheStats() {
  await ensureDir(CACHE_DIR);
  const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true });
  let bytes = 0;
  let entriesCount = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const stat = await fs.promises.stat(path.join(CACHE_DIR, entry.name));
    bytes += stat.size;
    entriesCount += 1;
  }
  return { entries: entriesCount, bytes };
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  PROJECTS_DIR,
  JOBS_DIR,
  CACHE_DIR,
  ensureDir,
  nowIso,
  sanitizeId,
  randomId,
  readJson,
  atomicWriteJson,
  initStorage,
  saveProject,
  getProject,
  listProjects,
  saveJob,
  getJob,
  listJobs,
  cacheFile,
  cacheStats
};
