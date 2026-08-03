const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectCodexRawRows } = require('../src/codex-parser');

function makeTempCodexDir(t) {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-parser-'));
  t.after(() => fs.rmSync(codexDir, { recursive: true, force: true }));
  return codexDir;
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
}

const getPricing = () => ({
  input: 0.001,
  cacheWrite: 0.002,
  cacheRead: 0.0005,
  output: 0.002,
});

test('collectCodexRawRows maps each last_token_usage event without using cumulative totals', async (t) => {
  const codexDir = makeTempCodexDir(t);

  writeJsonl(path.join(codexDir, '2026', '08', '03', 'rollout.jsonl'), [
    {
      timestamp: '2026-08-03T01:00:00.000Z',
      type: 'turn_context',
      payload: { model: 'gpt-5-codex' },
    },
    {
      timestamp: '2026-08-03T01:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: null },
    },
    {
      timestamp: '2026-08-03T01:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 10,
            output_tokens: 10,
            reasoning_output_tokens: 3,
            total_tokens: 110,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 10,
            total_tokens: 110,
          },
        },
      },
    },
    {
      timestamp: '2026-08-03T01:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 20,
            output_tokens: 5,
            total_tokens: 55,
          },
          total_token_usage: {
            input_tokens: 150,
            cached_input_tokens: 60,
            output_tokens: 15,
            total_tokens: 165,
          },
        },
      },
    },
  ]);

  const rows = await collectCodexRawRows({ codexDir, getPricing });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    Date: '2026-08-03T01:00:03.000Z',
    User: 'unknown',
    'Cloud Agent ID': '',
    'Automation ID': '',
    Kind: 'Included',
    Provider: 'Codex',
    Model: 'gpt-5-codex',
    'Max Mode': 'No',
    'Input (w/ Cache Write)': 0,
    'Input (w/o Cache Write)': 30,
    'Cache Read': 20,
    'Output Tokens': 5,
    'Total Tokens': 55,
    Cost: 0.05,
  });
  assert.equal(rows[1]['Input (w/ Cache Write)'], 10);
  assert.equal(rows[1]['Input (w/o Cache Write)'], 50);
  assert.equal(rows[1]['Cache Read'], 40);
  assert.equal(rows[1]['Output Tokens'], 10);
  assert.equal(rows[1]['Total Tokens'], 110);
  assert.equal(rows[1].Cost, 0.11);
});

test('collectCodexRawRows tracks model changes and clamps direct input at zero', async (t) => {
  const codexDir = makeTempCodexDir(t);
  const previousExportUser = process.env.USAGE_EXPORT_USER;
  const previousCodexUser = process.env.CODEX_USAGE_USER;
  process.env.USAGE_EXPORT_USER = 'shared-user@example.com';
  process.env.CODEX_USAGE_USER = 'codex-user@example.com';

  t.after(() => {
    if (previousExportUser === undefined) delete process.env.USAGE_EXPORT_USER;
    else process.env.USAGE_EXPORT_USER = previousExportUser;
    if (previousCodexUser === undefined) delete process.env.CODEX_USAGE_USER;
    else process.env.CODEX_USAGE_USER = previousCodexUser;
  });

  writeJsonl(path.join(codexDir, 'rollout.jsonl'), [
    { type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-03T02:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 10, output_tokens: 2 } },
      },
    },
    { type: 'turn_context', payload: { model: 'gpt-5.6-codex' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-03T02:01:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 3 } },
      },
    },
    '{malformed json',
  ]);

  const rows = await collectCodexRawRows({ codexDir, getPricing });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].Model, 'gpt-5.6-codex');
  assert.equal(rows[0].User, 'shared-user@example.com');
  assert.equal(rows[1].Model, 'gpt-5.5-codex');
  assert.equal(rows[1]['Input (w/o Cache Write)'], 0);
  assert.equal(rows[1]['Cache Read'], 10);
  assert.equal(rows[1]['Total Tokens'], 7);
});

test('collectCodexRawRows applies since to files and events in recursively nested directories', async (t) => {
  const codexDir = makeTempCodexDir(t);
  const oldFile = path.join(codexDir, '2026', '01', 'old.jsonl');
  const mixedFile = path.join(codexDir, '2026', '08', 'mixed.jsonl');
  const usage = (timestamp, outputTokens) => ({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          output_tokens: outputTokens,
        },
      },
    },
  });

  writeJsonl(oldFile, [
    { type: 'turn_context', payload: { model: 'old-model' } },
    usage('2026-01-01T00:00:00.000Z', 1),
  ]);
  writeJsonl(mixedFile, [
    { type: 'turn_context', payload: { model: 'current-model' } },
    usage('2026-01-01T00:00:00.000Z', 2),
    usage('2026-08-02T00:00:00.000Z', 3),
  ]);

  const oldTime = new Date('2026-01-02T00:00:00.000Z');
  const currentTime = new Date('2026-08-02T01:00:00.000Z');
  fs.utimesSync(oldFile, oldTime, oldTime);
  fs.utimesSync(mixedFile, currentTime, currentTime);

  const rows = await collectCodexRawRows({
    codexDir,
    getPricing,
    since: Date.parse('2026-08-01T00:00:00.000Z'),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Date, '2026-08-02T00:00:00.000Z');
  assert.equal(rows[0].Model, 'current-model');
  assert.equal(rows[0]['Output Tokens'], 3);
});

test('collectCodexRawRows scans sessions and archived_sessions and ignores duplicate rollout paths', async (t) => {
  const codexHome = makeTempCodexDir(t);
  const entries = [
    { type: 'session_meta', payload: { id: 'shared-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-03T03:00:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 2 },
          total_token_usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 2, total_tokens: 14 },
        },
      },
    },
  ];

  writeJsonl(path.join(codexHome, 'sessions', '2026', '08', 'active.jsonl'), entries);
  writeJsonl(path.join(codexHome, 'archived_sessions', 'archived.jsonl'), [
    { type: 'session_meta', payload: { id: 'archived-session' } },
    { type: 'turn_context', payload: { model: 'archived-model' } },
    {
      type: 'event_msg',
      timestamp: '2026-07-01T03:00:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 1 },
        },
      },
    },
  ]);
  writeJsonl(path.join(codexHome, 'archived_sessions', 'active.jsonl'), entries);

  const rows = await collectCodexRawRows({ codexHome, getPricing });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.Model), ['gpt-5-codex', 'archived-model']);
});
