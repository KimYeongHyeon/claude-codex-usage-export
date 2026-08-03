const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createDefaultPricingResolver, initializePricingResolver } = require('./pricing');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const PERSISTENT_CACHE_PATH = path.join(os.homedir(), '.claude-usage-dashboard-cache.json');
const PERSISTENT_CACHE_VERSION = 1;

function roundCost(value) {
  return Number(value.toFixed(2));
}

async function listJsonlFiles(rootDir, options = {}) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const sinceMs = Number.isFinite(options.since) ? options.since : null;
  const files = [];
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
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      if (sinceMs !== null) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtimeMs < sinceMs) {
            continue;
          }
        } catch {
          continue;
        }
      }

      files.push(fullPath);
    }
  }

  return files.sort();
}

const ASSISTANT_LINE_MARKER = '"type":"assistant"';

async function* readJsonl(filePath, options = {}) {
  const assistantOnly = options.assistantOnly === true;
  const reader = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }

      if (assistantOnly && !line.includes(ASSISTANT_LINE_MARKER)) {
        continue;
      }

      try {
        yield JSON.parse(line);
      } catch {
        // Ignore malformed lines.
      }
    }
  } finally {
    reader.close();
  }
}

function extractEmail(value) {
  if (!value) {
    return null;
  }

  const match = String(value).match(EMAIL_PATTERN);
  return match ? match[0] : null;
}

function extractUser(entry) {
  const configuredUser = String(process.env.CLAUDE_USAGE_USER || '').trim();
  if (configuredUser) {
    return configuredUser;
  }

  const directCandidates = [
    entry.user,
    entry.userEmail,
    entry.email,
    entry.actor,
    entry.userType,
    entry.message && entry.message.user,
  ];

  for (const candidate of directCandidates) {
    const email = extractEmail(candidate);
    if (email) {
      return email;
    }
  }

  return 'unknown';
}

function extractCloudAgentId(entry) {
  const candidates = [entry.cloudAgentId, entry.cloud_agent_id, entry.agentId, entry.agent_id];
  for (const candidate of candidates) {
    if (candidate) {
      return String(candidate);
    }
  }
  return '';
}

function extractAutomationId(entry) {
  const candidates = [entry.automationId, entry.automation_id];
  for (const candidate of candidates) {
    if (candidate) {
      return String(candidate);
    }
  }
  return '';
}

function inferMaxMode(entry) {
  if (entry.maxMode === true) {
    return 'Yes';
  }

  if (entry.permissionMode && String(entry.permissionMode).toLowerCase().includes('max')) {
    return 'Yes';
  }

  return 'No';
}

function buildDedupKey(entry) {
  const messageId = entry.message && entry.message.id ? entry.message.id : null;
  if (messageId && entry.requestId) {
    return `message-request:${messageId}:${entry.requestId}`;
  }

  if (entry.requestId) {
    return `request:${entry.requestId}`;
  }

  const usage = entry.message && entry.message.usage ? entry.message.usage : {};
  return [
    entry.sessionId || '',
    entry.timestamp || '',
    entry.message && entry.message.model ? entry.message.model : '',
    usage.input_tokens || 0,
    usage.cache_creation_input_tokens || 0,
    usage.cache_read_input_tokens || 0,
    usage.output_tokens || 0,
  ].join('::');
}

function mapAssistantEntryToRow(entry, getPricing) {
  const usage = entry.message && entry.message.usage ? entry.message.usage : null;
  if (!usage) {
    return null;
  }

  const model = entry.message.model || 'unknown';
  if (model === '<synthetic>') {
    return null;
  }

  const inputWithoutCacheWrite = usage.input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const totalTokens = cacheWrite + inputWithoutCacheWrite + cacheRead + outputTokens;
  const pricing = getPricing(model);
  const cost =
    inputWithoutCacheWrite * pricing.input +
    cacheWrite * pricing.cacheWrite +
    cacheRead * pricing.cacheRead +
    outputTokens * pricing.output;

  return {
    Date: entry.timestamp || '',
    User: extractUser(entry),
    'Cloud Agent ID': extractCloudAgentId(entry),
    'Automation ID': extractAutomationId(entry),
    Kind: 'Included',
    Model: model,
    'Max Mode': inferMaxMode(entry),
    'Input (w/ Cache Write)': cacheWrite,
    'Input (w/o Cache Write)': inputWithoutCacheWrite,
    'Cache Read': cacheRead,
    'Output Tokens': outputTokens,
    'Total Tokens': totalTokens,
    Cost: roundCost(cost),
  };
}

const FILE_CONCURRENCY = 32;  // bumped for faster cold loads (disk + CPU overlap)

function createProgressTracker() {
  let phase = 'idle';
  let total = 0;
  let processed = 0;

  return {
    setTotal(n) {
      total = Number.isFinite(n) ? Math.max(0, n) : 0;
    },
    increment() {
      if (processed < total) processed += 1;
    },
    setPhase(p) {
      if (typeof p === 'string') phase = p;
    },
    get() {
      const percent = total > 0 ? Math.floor((processed / total) * 100) : 0;
      return { phase, total, processed, percent };
    },
  };
}

// Per-file parse cache: avoids re-reading + re-JSON.parsing unchanged .jsonl files on refresh / preset switches.
// Keyed by absolute file path. Value contains the mtime at cache time + the assistant candidate entries.
const fileParseCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

// Persistent cache (disk) for fast restarts.
// On first load after server start, we populate the in-memory cache from disk.
// mtime validation still happens on access, so stale entries get refreshed automatically.
let persistentCacheLoaded = false;

async function loadPersistentCache() {
  if (persistentCacheLoaded) return;
  persistentCacheLoaded = true;

  try {
    const data = await fs.promises.readFile(PERSISTENT_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(data);

    if (parsed.version !== PERSISTENT_CACHE_VERSION || !parsed.files || typeof parsed.files !== 'object') {
      return; // incompatible format, ignore
    }

    let loadedCount = 0;
    for (const [filePath, entry] of Object.entries(parsed.files)) {
      if (entry && typeof entry.mtimeMs === 'number' && Array.isArray(entry.candidates)) {
        fileParseCache.set(filePath, {
          mtimeMs: entry.mtimeMs,
          candidates: entry.candidates,
        });
        loadedCount++;
      }
    }
    if (loadedCount > 0) {
      console.log(`Loaded ${loadedCount} files from persistent cache (${PERSISTENT_CACHE_PATH})`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('Failed to load persistent usage cache:', err.message);
    }
    // No cache file or unreadable = normal on first run
  }
}

async function savePersistentCache() {
  try {
    const files = {};
    for (const [filePath, entry] of fileParseCache.entries()) {
      files[filePath] = {
        mtimeMs: entry.mtimeMs,
        candidates: entry.candidates,
      };
    }

    const payload = {
      version: PERSISTENT_CACHE_VERSION,
      savedAt: Date.now(),
      fileCount: Object.keys(files).length,
      files,
    };

    const tmpPath = PERSISTENT_CACHE_PATH + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
    await fs.promises.rename(tmpPath, PERSISTENT_CACHE_PATH);
  } catch (err) {
    console.warn('Failed to save persistent usage cache:', err.message);
  }
}

async function collectFileCandidates(filePath, sinceMs) {
  // Fast path: if we have a cached parse for this exact file mtime, reuse it (huge win on refresh).
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return [];
  }

  const cached = fileParseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    cacheHits += 1;
    // Re-apply the time cutoff filter against the cached (full) candidate list.
    return cached.candidates.filter((candidate) => {
      const ts = candidate && candidate.entry && candidate.entry.timestamp
        ? Date.parse(candidate.entry.timestamp)
        : NaN;
      if (!Number.isFinite(ts)) {
        return true;
      }
      return sinceMs === null || ts >= sinceMs;
    });
  }

  cacheMisses += 1;

  const latestEntriesByDedupKey = new Map();
  const requestlessEntries = [];

  for await (const entry of readJsonl(filePath, { assistantOnly: true })) {
    if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) {
      continue;
    }

    const candidate = {
      entry,
    };

    const dedupKey = buildDedupKey(entry);
    if (dedupKey.startsWith('message-request:') || dedupKey.startsWith('request:')) {
      latestEntriesByDedupKey.set(dedupKey, candidate);
    } else {
      requestlessEntries.push(candidate);
    }
  }

  const allCandidates = [...requestlessEntries, ...latestEntriesByDedupKey.values()];

  // Store the *complete* set of assistant candidates for this mtime.
  // Time-based filtering is applied on retrieval so the cache works for any 'since' value.
  fileParseCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    candidates: allCandidates,
  });

  // Apply cutoff only for the value returned to this particular caller.
  if (sinceMs === null) {
    return allCandidates;
  }
  return allCandidates.filter((candidate) => {
    const ts = candidate && candidate.entry && candidate.entry.timestamp
      ? Date.parse(candidate.entry.timestamp)
      : NaN;
    if (!Number.isFinite(ts)) {
      return true;
    }
    return ts >= sinceMs;
  });
}

async function mapInPool(items, mapper, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function collectRowsFromFiles(filePaths, seenKeys, getPricing, sinceMs, progress) {
  const candidatesPerFile = await mapInPool(
    filePaths,
    async (filePath) => {
      const result = await collectFileCandidates(filePath, sinceMs);
      if (progress) progress.increment();
      return result;
    },
    FILE_CONCURRENCY
  );

  const rows = [];

  for (const candidates of candidatesPerFile) {
    for (const candidate of candidates) {
      const dedupKey = buildDedupKey(candidate.entry);
      if (seenKeys.has(dedupKey)) {
        continue;
      }

      seenKeys.add(dedupKey);
      const row = mapAssistantEntryToRow(candidate.entry, getPricing);
      if (row) {
        rows.push(row);
      }
    }
  }

  return rows;
}

async function collectRawRows(options = {}) {
  const claudeDir = options.claudeDir || DEFAULT_CLAUDE_DIR;
  const usePersistentCache = claudeDir === DEFAULT_CLAUDE_DIR;
  const sinceMs = Number.isFinite(options.since) ? options.since : null;
  const seenKeys = new Set();
  const getPricing =
    options.getPricing ||
    (await initializePricingResolver()).getPricing ||
    createDefaultPricingResolver();

  // Load persistent cache on first use (fast path for restarts)
  if (usePersistentCache && !persistentCacheLoaded) {
    await loadPersistentCache();
  }

  const listOptions = sinceMs !== null ? { since: sinceMs } : {};
  const progress = options.progress || null;

  const [projectFiles, transcriptFiles] = await Promise.all([
    listJsonlFiles(path.join(claudeDir, 'projects'), listOptions),
    listJsonlFiles(path.join(claudeDir, 'transcripts'), listOptions),
  ]);

  const totalFiles = projectFiles.length + transcriptFiles.length;
  if (progress) {
    progress.setTotal(totalFiles);
    progress.setPhase('parsing');
  }

  const projectRows = await collectRowsFromFiles(
    projectFiles,
    seenKeys,
    getPricing,
    sinceMs,
    progress
  );
  const transcriptRows = await collectRowsFromFiles(
    transcriptFiles,
    seenKeys,
    getPricing,
    sinceMs,
    progress
  );

  if (progress) {
    progress.setPhase('complete');
  }

  // Persist what we have now so the next server restart is fast
  // Fire-and-forget (don't block the response)
  if (usePersistentCache) {
    savePersistentCache().catch(() => {});
  }

  return [...projectRows, ...transcriptRows].sort((left, right) =>
    right.Date.localeCompare(left.Date)
  );
}

module.exports = {
  DEFAULT_CLAUDE_DIR,
  collectRawRows,
  createProgressTracker,
  // Test-only helpers (safe to call from tests; not part of public API)
  __clearParseCache() {
    fileParseCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
  },
  __getParseCacheStats() {
    return {
      size: fileParseCache.size,
      hits: cacheHits,
      misses: cacheMisses,
    };
  },
  loadPersistentCache,
  savePersistentCache,
  PERSISTENT_CACHE_PATH,
  // Test helper
  __clearPersistentCacheForTest() {
    try { fs.unlinkSync(PERSISTENT_CACHE_PATH); } catch {}
    try { fs.unlinkSync(PERSISTENT_CACHE_PATH + '.tmp'); } catch {}
  },
};
