const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('xlsx');

const { createApp, getStartupUrls, listenOnAvailablePort } = require('../src/server');
const { createDefaultPricingResolver } = require('../src/pricing');

const getPricing = createDefaultPricingResolver();

function makeTempClaudeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-server-'));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
}

async function listen(app) {
  await new Promise((resolve) => app.listen(0, resolve));
  return app.address().port;
}

async function close(app) {
  await new Promise((resolve, reject) => app.close((error) => (error ? reject(error) : resolve())));
}

test('listenOnAvailablePort advances to a free port when the default is occupied', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  const app = createApp({ claudeDir: makeTempClaudeDir(), getPricing });

  try {
    const selectedPort = await listenOnAvailablePort(app, {
      port: occupiedPort,
      findAvailable: true,
    });
    assert.ok(selectedPort > occupiedPort);
    assert.equal(app.address().port, selectedPort);
  } finally {
    if (app.listening) await close(app);
    await close(blocker);
  }
});

test('listenOnAvailablePort preserves EADDRINUSE when an explicit port is occupied', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const occupiedPort = blocker.address().port;
  const app = createApp({ claudeDir: makeTempClaudeDir(), getPricing });

  try {
    await assert.rejects(
      listenOnAvailablePort(app, { port: occupiedPort, findAvailable: false }),
      (error) => error && error.code === 'EADDRINUSE'
    );
  } finally {
    if (app.listening) await close(app);
    await close(blocker);
  }
});

test('getStartupUrls returns a directly usable URL for a specific host', () => {
  assert.deepEqual(getStartupUrls('127.0.0.1', 3457), ['http://127.0.0.1:3457']);
  assert.deepEqual(getStartupUrls('::1', 3457), ['http://[::1]:3457']);
});

test('dashboard HTML includes the proxy-aware URL resolver', async () => {
  const app = createApp({ claudeDir: makeTempClaudeDir(), getPricing });
  const port = await listen(app);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /function resolveAppUrl/);
    assert.doesNotMatch(html, /\/\*__APP_URL_HELPER__\*\//);
  } finally {
    await close(app);
  }
});

async function readWorkbookRows(response) {
  const workbookBuffer = Buffer.from(await response.arrayBuffer());
  const workbook = XLSX.read(workbookBuffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Raw']);
  return XLSX.utils.sheet_to_json(workbook.Sheets.Raw, { defval: null });
}

async function fetchWorkbookRows(port, query = '') {
  const exportResponse = await fetch(`http://127.0.0.1:${port}/export.xlsx${query}`);
  assert.equal(exportResponse.status, 200);
  return readWorkbookRows(exportResponse);
}

async function fetchRawRows(port, query = '') {
  const apiResponse = await fetch(`http://127.0.0.1:${port}/api/raw${query}`);
  assert.equal(apiResponse.status, 200);
  return apiResponse.json();
}

function makeAssistantEntry(timestamp, user, inputTokens) {
  return {
    type: 'assistant',
    timestamp,
    sessionId: `${user}-${timestamp}`,
    userType: user,
    message: {
      role: 'assistant',
      model: 'auto',
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 10,
      },
    },
  };
}

test('/api/raw still returns all raw rows', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'today@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'yesterday-local@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'older@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const rows = await fetchRawRows(port, '?since=0');
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.User),
      ['today@example.com', 'yesterday-local@example.com', 'older@example.com']
    );
    assert.equal(rows[0].Model, 'auto');
    assert.equal(rows[0].Date, '2026-03-10T16:00:00.000Z');
  } finally {
    await close(app);
  }
});

test('/api/raw merges Claude Code and Codex rows', async () => {
  const claudeDir = makeTempClaudeDir();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex usage 한글-'));
  writeJsonl(path.join(claudeDir, 'projects', 'p1', 'claude.jsonl'), [
    makeAssistantEntry('2026-08-03T01:00:00.000Z', 'claude-user', 100),
  ]);
  writeJsonl(path.join(codexHome, 'sessions', '2026', '08', 'codex.jsonl'), [
    { type: 'session_meta', payload: { id: 'codex-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-03T02:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3 } },
      },
    },
  ]);

  const app = createApp({ claudeDir, codexHome, includeCodex: true, getPricing });
  const port = await listen(app);
  try {
    const rows = await fetchRawRows(port, '?since=0');
    assert.deepEqual(rows.map((row) => row.Provider), ['Codex', 'Claude Code']);
    assert.equal(rows[0].Model, 'gpt-5.4-mini');

    const claudeRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=all&provider=claude'
    );
    assert.deepEqual(claudeRows.map((row) => row.Provider), ['Claude Code']);

    const claudeResponse = await fetch(
      `http://127.0.0.1:${port}/export.xlsx?since=0&preset=all&provider=claude`
    );
    assert.equal(
      claudeResponse.headers.get('content-disposition'),
      'attachment; filename="claude-code-usage.xlsx"'
    );
    await claudeResponse.arrayBuffer();

    const codexRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=all&provider=codex'
    );
    assert.deepEqual(codexRows.map((row) => row.Provider), ['Codex']);

    const codexResponse = await fetch(
      `http://127.0.0.1:${port}/export.xlsx?since=0&preset=all&provider=codex`
    );
    assert.equal(
      codexResponse.headers.get('content-disposition'),
      'attachment; filename="codex-usage.xlsx"'
    );
    await codexResponse.arrayBuffer();
  } finally {
    await close(app);
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('/api/raw defaults to the last 30 days when since is omitted', async () => {
  const claudeDir = makeTempClaudeDir();
  const now = Date.now();
  const recentTimestamp = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
  const staleTimestamp = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 'recent.jsonl'), [
    makeAssistantEntry(recentTimestamp, 'recent@example.com', 100),
  ]);
  writeJsonl(path.join(claudeDir, 'projects', 'p1', 'stale.jsonl'), [
    makeAssistantEntry(staleTimestamp, 'stale@example.com', 200),
  ]);

  const staleMtime = new Date(now - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(
    path.join(claudeDir, 'projects', 'p1', 'stale.jsonl'),
    staleMtime,
    staleMtime
  );

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const rows = await fetchRawRows(port);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Date, recentTimestamp);
  } finally {
    await close(app);
  }
});

test('/api/raw honors explicit since query param', async () => {
  const claudeDir = makeTempClaudeDir();
  const now = Date.now();
  const oldTimestamp = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString();
  const newTimestamp = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 'old.jsonl'), [
    makeAssistantEntry(oldTimestamp, 'old@example.com', 100),
  ]);
  writeJsonl(path.join(claudeDir, 'projects', 'p1', 'new.jsonl'), [
    makeAssistantEntry(newTimestamp, 'new@example.com', 200),
  ]);

  const oldMtime = new Date(now - 200 * 24 * 60 * 60 * 1000);
  fs.utimesSync(
    path.join(claudeDir, 'projects', 'p1', 'old.jsonl'),
    oldMtime,
    oldMtime
  );

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const allRows = await fetchRawRows(port, '?since=0');
    assert.equal(allRows.length, 2);

    const recentRows = await fetchRawRows(port, '?since=' + (now - 30 * 24 * 60 * 60 * 1000));
    assert.equal(recentRows.length, 1);
    assert.equal(recentRows[0].Date, newTimestamp);
  } finally {
    await close(app);
  }
});

test('/export.xlsx can sort by a numeric column after filtering', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'high@example.com', 400),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'low@example.com', 150),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'outside-window@example.com', 50),
    makeAssistantEntry('2026-03-10T05:00:00.000Z', 'mid@example.com', 275),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const sheetRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=last24h&now=2026-03-10T18:00:00.000Z&sortBy=Input%20(w%2Fo%20Cache%20Write)&sortDirection=asc'
    );

    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['low@example.com', 'mid@example.com', 'high@example.com']
    );
    assert.deepEqual(
      sheetRows.map((row) => row['Input (w/o Cache Write)']),
      [150, 275, 400]
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx can sort by a text column', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'zoe@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'amy@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'mike@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const sheetRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=all&sortBy=User&sortDirection=asc'
    );

    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['amy@example.com', 'mike@example.com', 'zoe@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx preserves current filtered order for invalid sort params', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'most-recent@example.com', 100),
    makeAssistantEntry('2026-03-05T12:00:00.000Z', 'range-start@example.com', 200),
    makeAssistantEntry('2026-03-06T00:00:00.000Z', 'range-middle@example.com', 300),
    makeAssistantEntry('2026-03-07T00:00:00.000Z', 'range-end@example.com', 400),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const rangeQuery =
      '?since=0&start=2026-03-05T12:00:00.000Z&end=2026-03-07T00:00:00.000Z&inclusiveEnd=false';
    const baselineRows = await fetchWorkbookRows(port, rangeQuery);
    const invalidSortRows = await fetchWorkbookRows(
      port,
      `${rangeQuery}&sortBy=Not%20A%20Column&sortDirection=sideways`
    );

    assert.deepEqual(
      invalidSortRows.map((row) => row.User),
      baselineRows.map((row) => row.User)
    );
  } finally {
    await close(app);
  }
});

test('/api/raw remains unaffected by export sort params', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'third@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'first@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'second@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const rows = await fetchRawRows(port, '?since=0&sortBy=User&sortDirection=asc');
    assert.deepEqual(
      rows.map((row) => row.User),
      ['third@example.com', 'first@example.com', 'second@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx applies preset filtering', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'within-24h-a@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'within-24h-b@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'outside-window@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const exportResponse = await fetch(
      `http://127.0.0.1:${port}/export.xlsx?since=0&preset=last24h&now=2026-03-10T18:00:00.000Z`
    );
    assert.equal(exportResponse.status, 200);
    assert.match(
      exportResponse.headers.get('content-type'),
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/
    );
    assert.equal(
      exportResponse.headers.get('content-disposition'),
      'attachment; filename="claude-usage-raw.xlsx"'
    );

    const sheetRows = await readWorkbookRows(exportResponse);
    assert.equal(sheetRows.length, 2);
    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['within-24h-a@example.com', 'within-24h-b@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx honors explicit range params over preset filtering', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'preset-match@example.com', 100),
    makeAssistantEntry('2026-03-05T12:00:00.000Z', 'range-start@example.com', 200),
    makeAssistantEntry('2026-03-06T00:00:00.000Z', 'range-middle@example.com', 300),
    makeAssistantEntry('2026-03-07T00:00:00.000Z', 'range-end@example.com', 400),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const start = Date.parse('2026-03-05T12:00:00.000Z');
    const sheetRows = await fetchWorkbookRows(
      port,
      `?since=0&preset=last24h&now=2026-03-10T18:00:00.000Z&start=${start}&end=2026-03-07T00:00:00.000Z&inclusiveEnd=false`
    );

    assert.equal(sheetRows.length, 2);
    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['range-middle@example.com', 'range-start@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx falls back to preset filtering when explicit range params are invalid', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'within-24h@example.com', 100),
    makeAssistantEntry('2026-03-09T18:00:00.000Z', 'boundary@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'outside-window@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const sheetRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=last24h&now=2026-03-10T18:00:00.000Z&start=not-a-date&end=2026-03-10T17:00:00.000Z&inclusiveEnd=true'
    );

    assert.equal(sheetRows.length, 2);
    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['within-24h@example.com', 'boundary@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx falls back to preset filtering when explicit range is reversed', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'within-24h@example.com', 100),
    makeAssistantEntry('2026-03-09T18:00:00.000Z', 'boundary@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'outside-window@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const sheetRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=last24h&now=2026-03-10T18:00:00.000Z&start=2026-03-07T00:00:00.000Z&end=2026-03-05T12:00:00.000Z&inclusiveEnd=true'
    );

    assert.equal(sheetRows.length, 2);
    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['within-24h@example.com', 'boundary@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx treats unknown presets like all', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'first@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'second@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'third@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const exportResponse = await fetch(
      `http://127.0.0.1:${port}/export.xlsx?since=0&preset=not-a-real-preset&now=2026-03-10T18:00:00.000Z`
    );
    assert.equal(exportResponse.status, 200);

    const sheetRows = await readWorkbookRows(exportResponse);
    assert.equal(sheetRows.length, 3);
    assert.deepEqual(
      sheetRows.map((row) => row.User),
      ['first@example.com', 'second@example.com', 'third@example.com']
    );
  } finally {
    await close(app);
  }
});

test('/export.xlsx today honors IANA time zone with deterministic now override', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'ny-today@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'ny-previous-day@example.com', 200),
    makeAssistantEntry('2026-03-09T04:30:00.000Z', 'ny-yesterday-boundary@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const exportResponse = await fetch(
      `http://127.0.0.1:${port}/export.xlsx?since=0&preset=today&timeZone=America%2FNew_York&now=2026-03-10T18:00:00.000Z`
    );
    assert.equal(exportResponse.status, 200);

    const sheetRows = await readWorkbookRows(exportResponse);
    assert.equal(sheetRows.length, 1);
    assert.equal(sheetRows[0].User, 'ny-today@example.com');
    assert.equal(sheetRows[0].Date, '2026-03-10T16:00:00.000Z');
  } finally {
    await close(app);
  }
});

test('/export.xlsx today honors numeric tzOffsetMinutes', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'offset-today@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'offset-previous-day@example.com', 200),
    makeAssistantEntry('2026-03-09T04:30:00.000Z', 'offset-yesterday-boundary@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const sheetRows = await fetchWorkbookRows(
      port,
      '?since=0&preset=today&tzOffsetMinutes=240&now=2026-03-10T18:00:00.000Z'
    );

    assert.equal(sheetRows.length, 1);
    assert.equal(sheetRows[0].User, 'offset-today@example.com');
    assert.equal(sheetRows[0].Date, '2026-03-10T16:00:00.000Z');
  } finally {
    await close(app);
  }
});

test('/export.xlsx ignores empty or malformed timezone-related params', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'baseline-today@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'baseline-earlier@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'baseline-old@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const baselineRows = await fetchWorkbookRows(
      port,
      '?preset=today&now=2026-03-10T18:00:00.000Z'
    );
    const emptyRows = await fetchWorkbookRows(
      port,
      '?preset=today&tzOffsetMinutes=&timeZone=&now=2026-03-10T18:00:00.000Z'
    );
    const malformedRows = await fetchWorkbookRows(
      port,
      '?preset=today&tzOffsetMinutes=abc&timeZone=&now=2026-03-10T18:00:00.000Z'
    );

    assert.deepEqual(emptyRows, baselineRows);
    assert.deepEqual(malformedRows, baselineRows);
  } finally {
    await close(app);
  }
});

test('/export.xlsx safely falls back when timeZone is an invalid non-empty IANA value', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'p1', 's1.jsonl'), [
    makeAssistantEntry('2026-03-10T16:00:00.000Z', 'baseline-today@example.com', 100),
    makeAssistantEntry('2026-03-10T03:30:00.000Z', 'baseline-earlier@example.com', 200),
    makeAssistantEntry('2026-03-01T12:00:00.000Z', 'baseline-old@example.com', 300),
  ]);

  const app = createApp({ claudeDir, getPricing });
  const port = await listen(app);

  try {
    const baselineRows = await fetchWorkbookRows(
      port,
      '?preset=today&now=2026-03-10T18:00:00.000Z'
    );
    const invalidTimeZoneRows = await fetchWorkbookRows(
      port,
      '?preset=today&timeZone=Not%2FAZone&now=2026-03-10T18:00:00.000Z'
    );

    assert.deepEqual(invalidTimeZoneRows, baselineRows);
  } finally {
    await close(app);
  }
});
