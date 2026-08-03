#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { filterRows } = require('./filter');
const { DEFAULT_CLAUDE_DIR, collectRawRows, createProgressTracker } = require('./parser');
const { collectCodexRawRows, loadPersistentCache: loadCodexPersistentCache } = require('./codex-parser');
const { createDefaultPricingResolver, initializePricingResolver } = require('./pricing');
const { sortRows } = require('./sort');
const { buildWorkbookBuffer } = require('./workbook');

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_DAYS = 30;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response) {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(fs.readFileSync(INDEX_PATH, 'utf8'));
}

function sendWorkbook(response, workbookBuffer) {
  response.writeHead(200, {
    'Content-Type':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename=\"claude-usage-raw.xlsx\"',
    'Content-Length': String(workbookBuffer.length),
    'Cache-Control': 'no-store',
  });
  response.end(workbookBuffer);
}

function parseTimestampQueryParam(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  const numericValue = Number(trimmedValue);
  if (Number.isFinite(numericValue)) {
    return numericValue;
  }

  const parsedValue = Date.parse(trimmedValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseInclusiveEndQueryParam(value) {
  if (value === null) {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return null;
}

function parseExplicitExportRange(searchParams) {
  if (!searchParams.has('start') || !searchParams.has('end')) {
    return null;
  }

  const start = parseTimestampQueryParam(searchParams.get('start'));
  const end = parseTimestampQueryParam(searchParams.get('end'));
  const inclusiveEnd = parseInclusiveEndQueryParam(searchParams.get('inclusiveEnd'));

  if (start === null || end === null || inclusiveEnd === null) {
    return null;
  }

  if (start > end) {
    return null;
  }

  return { start, end, inclusiveEnd };
}

function filterRowsByExplicitRange(rows, range) {
  return rows.filter((row) => {
    const timestamp = parseTimestampQueryParam(row && row.Date);
    if (timestamp === null || timestamp < range.start) {
      return false;
    }

    if (range.inclusiveEnd) {
      return timestamp <= range.end;
    }

    return timestamp < range.end;
  });
}

function parseExportFilterOptions(searchParams) {
  const preset = searchParams.get('preset') || 'all';
  const hasTzOffsetMinutes = searchParams.has('tzOffsetMinutes');
  const tzOffsetMinutesValue = hasTzOffsetMinutes
    ? searchParams.get('tzOffsetMinutes')
    : null;
  const hasValidTzOffsetMinutes =
    typeof tzOffsetMinutesValue === 'string' && tzOffsetMinutesValue.trim() !== '';
  const tzOffsetMinutes = hasValidTzOffsetMinutes
    ? Number(tzOffsetMinutesValue)
    : Number.NaN;
  const timeZone = searchParams.get('timeZone');
  const now = searchParams.get('now');
  const validTimeZone = normalizeTimeZone(timeZone);

  return {
    preset,
    ...(hasTzOffsetMinutes &&
    hasValidTzOffsetMinutes &&
    Number.isFinite(tzOffsetMinutes)
      ? { tzOffsetMinutes }
      : {}),
    ...(validTimeZone ? { timeZone: validTimeZone } : {}),
    ...(now ? { now } : {}),
  };
}

function normalizeTimeZone(timeZone) {
  if (typeof timeZone !== 'string') {
    return null;
  }

  const trimmedTimeZone = timeZone.trim();
  if (!trimmedTimeZone) {
    return null;
  }

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: trimmedTimeZone });
    return trimmedTimeZone;
  } catch {
    return null;
  }
}

function resolveSinceMs(searchParams) {
  if (!searchParams.has('since')) {
    return Date.now() - DEFAULT_FETCH_DAYS * DAY_MS;
  }

  const parsed = parseTimestampQueryParam(searchParams.get('since'));
  if (parsed === null) {
    return Date.now() - DEFAULT_FETCH_DAYS * DAY_MS;
  }

  return parsed;
}

function parseExportSortOptions(searchParams) {
  return {
    sortBy: searchParams.get('sortBy'),
    sortDirection: searchParams.get('sortDirection'),
  };
}

function createApp(options = {}) {
  const claudeDir = options.claudeDir || DEFAULT_CLAUDE_DIR;
  const getPricing = options.getPricing;
  const includeCodex = options.includeCodex !== undefined
    ? options.includeCodex
    : Boolean(options.codexHome || options.codexDir || options.codexRoots || !options.claudeDir);

  async function collectAllRows({ since, progress }) {
    const claudeProgress = progress ? createProgressTracker() : null;
    const codexProgress = progress && includeCodex ? createProgressTracker() : null;
    if (progress) {
      progress.get = () => {
        const states = [claudeProgress, codexProgress].filter(Boolean).map((tracker) => tracker.get());
        const total = states.reduce((sum, state) => sum + state.total, 0);
        const processed = states.reduce((sum, state) => sum + state.processed, 0);
        return {
          phase: states.every((state) => state.phase === 'complete') ? 'complete' : 'parsing',
          total,
          processed,
          percent: total > 0 ? Math.floor((processed / total) * 100) : 0,
        };
      };
    }

    const collectors = [collectRawRows({ claudeDir, getPricing, since, progress: claudeProgress })];
    if (includeCodex) {
      collectors.push(collectCodexRawRows({
        codexHome: options.codexHome,
        codexDir: options.codexDir,
        roots: options.codexRoots,
        getPricing,
        since,
        progress: codexProgress,
      }));
    }
    const groups = await Promise.all(collectors);
    return groups.flat().sort((left, right) => right.Date.localeCompare(left.Date));
  }

  // Simple single active progress tracker.
  // For a local single-user dashboard this is sufficient and avoids any key mismatch issues.
  let currentProgress = null;

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/raw') {
        const since = resolveSinceMs(url.searchParams);
        const progress = createProgressTracker();
        currentProgress = progress;

        try {
          const rows = await collectAllRows({ since, progress });
          sendJson(response, 200, rows);
        } finally {
          // Keep the final 100% state briefly visible to the last poll.
          const resetTimer = setTimeout(() => {
            if (currentProgress === progress) currentProgress = null;
          }, 8000);
          resetTimer.unref?.();
        }
        return;
      }

      if (request.method === 'GET' && url.pathname === '/export.xlsx') {
        const since = resolveSinceMs(url.searchParams);
        const rows = await collectAllRows({ since });
        const explicitRange = parseExplicitExportRange(url.searchParams);
        const filteredRows = explicitRange
          ? filterRowsByExplicitRange(rows, explicitRange)
          : filterRows(rows, parseExportFilterOptions(url.searchParams));
        const sortedRows = sortRows(filteredRows, parseExportSortOptions(url.searchParams));
        sendWorkbook(response, buildWorkbookBuffer(sortedRows));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/progress') {
        const payload = currentProgress
          ? currentProgress.get()
          : { phase: 'idle', total: 0, processed: 0, percent: 0 };
        sendJson(response, 200, payload);
        return;
      }

      response.statusCode = 404;
      response.end('Not found');
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3456);
  let activePricing = createDefaultPricingResolver();
  const getPricing = (...args) => activePricing(...args);
  const app = createApp({ getPricing });

  const { loadPersistentCache } = require('./parser');
  loadPersistentCache().catch(() => {});
  loadCodexPersistentCache().catch(() => {});

  app.listen(port, '127.0.0.1', () => {
    console.log(`Claude + Codex usage dashboard running at http://127.0.0.1:${port}`);
  });

  initializePricingResolver().then((state) => {
    if (state && state.getPricing) activePricing = state.getPricing;
  }).catch(() => {});
}

module.exports = {
  createApp,
};
