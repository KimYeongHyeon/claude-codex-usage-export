const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_CODEX_DIR = path.join(os.homedir(), '.codex');
const DEFAULT_CODEX_SESSIONS_DIR = path.join(DEFAULT_CODEX_DIR, 'sessions');
const DEFAULT_CODEX_ARCHIVED_SESSIONS_DIR = path.join(DEFAULT_CODEX_DIR, 'archived_sessions');
const PERSISTENT_CACHE_PATH = path.join(os.homedir(), '.claude-usage-dashboard-codex-cache.json');
const PERSISTENT_CACHE_VERSION = 2;
const FILE_CONCURRENCY = 16;
const MARKER = /"type"\s*:\s*"(?:session_meta|turn_context|token_count)"/;

const fileParseCache = new Map();
let cacheLoaded = false;
let cacheLoadPromise = null;
let cacheSavePromise = null;
let cacheSaveRequested = false;
let cacheDirty = false;

function defaultCodexDir() {
  return process.env.CODEX_HOME || DEFAULT_CODEX_DIR;
}

function resolveRoots(options) {
  if (Array.isArray(options.roots)) return options.roots;
  if (options.codexDir) return [options.codexDir];
  const codexHome = options.codexHome || defaultCodexDir();
  return [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
}

async function listJsonlFiles(rootDirs, options = {}) {
  const roots = Array.isArray(rootDirs) ? rootDirs : [rootDirs];
  const sinceMs = Number.isFinite(options.since) ? options.since : null;
  const files = [];

  for (const rootDir of roots) {
    const stack = [rootDir];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          if (sinceMs !== null) {
            try {
              const stat = await fs.promises.stat(fullPath);
              if (stat.mtimeMs < sinceMs) continue;
            } catch {
              continue;
            }
          }
          files.push(fullPath);
        }
      }
    }
  }
  return [...new Set(files)].sort();
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function roundCost(value) {
  return Number(value.toFixed(2));
}

function configuredUser() {
  return String(process.env.USAGE_EXPORT_USER || process.env.CODEX_USAGE_USER || '').trim() || 'unknown';
}

function mapCandidateToRow(candidate, user, getPricing) {
  const inputTokens = candidate.inputTokens;
  const cachedInputTokens = candidate.cachedInputTokens;
  const cacheWriteInputTokens = candidate.cacheWriteInputTokens;
  const directInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens);
  const pricing = getPricing(candidate.model, 'Codex', { inputTokens });
  const cost = pricing
    ? directInputTokens * pricing.input +
      cachedInputTokens * pricing.cacheRead +
      cacheWriteInputTokens * pricing.cacheWrite +
      candidate.outputTokens * pricing.output
    : null;

  return {
    Date: candidate.timestamp,
    Source: 'Codex',
    User: user,
    'Cloud Agent ID': '',
    'Automation ID': '',
    Kind: 'Included',
    Model: candidate.model,
    'Max Mode': 'No',
    'Input (w/ Cache Write)': cacheWriteInputTokens,
    'Input (w/o Cache Write)': directInputTokens,
    'Cache Read': cachedInputTokens,
    'Output Tokens': candidate.outputTokens,
    'Total Tokens': inputTokens + candidate.outputTokens,
    Cost: cost === null ? null : roundCost(cost),
  };
}

function buildDedupKey(sessionId, timestamp, model, total, usage) {
  if (!sessionId) return null;
  const source = total || usage;
  return [
    sessionId,
    timestamp || '',
    model || 'unknown',
    tokenCount(source.input_tokens),
    tokenCount(source.cached_input_tokens),
    tokenCount(source.cache_write_input_tokens),
    tokenCount(source.output_tokens),
    tokenCount(source.total_tokens),
  ].join('::');
}

async function parseCodexFile(filePath) {
  const candidates = [];
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let currentModel = 'unknown';
  let sessionId = '';

  try {
    for await (const line of reader) {
      if (!MARKER.test(line)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === 'session_meta' && entry.payload) {
        sessionId = String(entry.payload.id || entry.payload.session_id || sessionId);
      } else if (entry.type === 'turn_context' && entry.payload) {
        currentModel = String(entry.payload.model || currentModel);
      } else {
        const info = entry.payload && entry.payload.info;
        const usage = info && info.last_token_usage;
        if (entry.type !== 'event_msg' || entry.payload.type !== 'token_count' || !usage) continue;
        candidates.push({
          timestamp: entry.timestamp || '',
          model: currentModel,
          inputTokens: tokenCount(usage.input_tokens),
          cachedInputTokens: tokenCount(usage.cached_input_tokens),
          cacheWriteInputTokens: tokenCount(usage.cache_write_input_tokens),
          outputTokens: tokenCount(usage.output_tokens),
          dedupKey: buildDedupKey(sessionId, entry.timestamp, currentModel, info.total_token_usage, usage),
        });
      }
    }
  } catch {
    // A partially-written active rollout is normal; retain all complete events.
  } finally {
    reader.close();
    input.destroy();
  }
  return candidates;
}

async function loadPersistentCache() {
  if (cacheLoaded) return;
  if (!cacheLoadPromise) {
    cacheLoadPromise = (async () => {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(PERSISTENT_CACHE_PATH, 'utf8'));
        if (parsed.version !== PERSISTENT_CACHE_VERSION || !Array.isArray(parsed.files)) return;
        for (const value of parsed.files) {
          if (!Array.isArray(value) || !Number.isFinite(value[1]) || !Array.isArray(value[2])) continue;
          fileParseCache.set(value[0], {
            mtimeMs: value[1],
            candidates: value[2].map((candidate) => ({
              timestamp: candidate[0],
              model: candidate[1],
              inputTokens: candidate[2],
              cachedInputTokens: candidate[3],
              cacheWriteInputTokens: candidate[4],
              outputTokens: candidate[5],
              dedupKey: candidate[6],
            })),
          });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Failed to load Codex usage cache:', error.message);
      } finally {
        cacheLoaded = true;
        cacheLoadPromise = null;
      }
    })();
  }
  await cacheLoadPromise;
}

async function savePersistentCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  const temporaryPath = `${PERSISTENT_CACHE_PATH}.${process.pid}.tmp`;
  try {
    const files = [...fileParseCache].map(([filePath, value]) => [
      filePath,
      value.mtimeMs,
      value.candidates.map((candidate) => [
        candidate.timestamp,
        candidate.model,
        candidate.inputTokens,
        candidate.cachedInputTokens,
        candidate.cacheWriteInputTokens,
        candidate.outputTokens,
        candidate.dedupKey,
      ]),
    ]);
    await fs.promises.writeFile(
      temporaryPath,
      JSON.stringify({ version: PERSISTENT_CACHE_VERSION, savedAt: Date.now(), files }),
      { encoding: 'utf8', mode: 0o600 }
    );
    await fs.promises.rename(temporaryPath, PERSISTENT_CACHE_PATH);
    await fs.promises.chmod(PERSISTENT_CACHE_PATH, 0o600);
  } catch (error) {
    cacheDirty = true;
    await fs.promises.unlink(temporaryPath).catch(() => {});
    console.warn('Failed to save Codex usage cache:', error.message);
  }
}

function requestPersistentCacheSave() {
  if (!cacheDirty) return;
  cacheSaveRequested = true;
  if (cacheSavePromise) return;
  cacheSavePromise = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    while (cacheSaveRequested) {
      cacheSaveRequested = false;
      await savePersistentCache();
    }
  })().finally(() => {
    cacheSavePromise = null;
    if (cacheSaveRequested) requestPersistentCacheSave();
  });
}

async function collectFileCandidates(filePath) {
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch { return []; }
  const cached = fileParseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.candidates;
  const candidates = await parseCodexFile(filePath);
  fileParseCache.set(filePath, { mtimeMs: stat.mtimeMs, candidates });
  cacheDirty = true;
  return candidates;
}

async function mapInPool(items, mapper, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function collectCodexRawRows(options = {}) {
  const sinceMs = Number.isFinite(options.since) ? options.since : null;
  const usePersistentCache = !options.roots && !options.codexDir &&
    (options.codexHome || defaultCodexDir()) === defaultCodexDir();
  if (usePersistentCache) await loadPersistentCache();

  const files = await listJsonlFiles(resolveRoots(options), sinceMs === null ? {} : { since: sinceMs });
  const progress = options.progress;
  if (progress) { progress.setTotal(files.length); progress.setPhase('parsing'); }
  const candidatesByFile = await mapInPool(files, async (filePath) => {
    const result = await collectFileCandidates(filePath);
    if (progress) progress.increment();
    return result;
  }, FILE_CONCURRENCY);

  const getPricing = options.getPricing || (() => null);
  const user = configuredUser();
  const seen = new Set();
  const rows = [];
  for (const candidates of candidatesByFile) {
    for (const candidate of candidates) {
      const timestamp = Date.parse(candidate.timestamp);
      if (sinceMs !== null && Number.isFinite(timestamp) && timestamp < sinceMs) continue;
      if (candidate.dedupKey && seen.has(candidate.dedupKey)) continue;
      if (candidate.dedupKey) seen.add(candidate.dedupKey);
      rows.push(mapCandidateToRow(candidate, user, getPricing));
    }
  }
  if (progress) progress.setPhase('complete');
  if (usePersistentCache) requestPersistentCacheSave();
  return rows.sort((left, right) => right.Date.localeCompare(left.Date));
}

module.exports = {
  DEFAULT_CODEX_DIR,
  DEFAULT_CODEX_SESSIONS_DIR,
  DEFAULT_CODEX_ARCHIVED_SESSIONS_DIR,
  PERSISTENT_CACHE_PATH,
  collectCodexRawRows,
  listJsonlFiles,
  loadPersistentCache,
  savePersistentCache,
};
