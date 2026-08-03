const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { __compactAssistantEntry, collectRawRows } = require('../src/parser');
const { createDefaultPricingResolver } = require('../src/pricing');

const getPricing = createDefaultPricingResolver();

function makeTempClaudeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-parser-'));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8'
  );
}

test('persistent-cache entries exclude conversation content and keep usage metadata', () => {
  const compact = __compactAssistantEntry({
    type: 'assistant',
    timestamp: '2026-08-03T00:00:00.000Z',
    sessionId: 'session-1',
    requestId: 'request-1',
    message: {
      id: 'message-1',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'private conversation text' }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });

  assert.equal(compact.message.content, undefined);
  assert.equal(compact.message.id, 'message-1');
  assert.equal(compact.message.model, 'claude-sonnet-4-6');
  assert.deepEqual(compact.message.usage, { input_tokens: 10, output_tokens: 2 });
});

test('collectRawRows maps assistant usage events into export rows', async () => {
  const claudeDir = makeTempClaudeDir();
  const sessionId = 'session-1';

  writeJsonl(
    path.join(claudeDir, 'projects', 'project-a', `${sessionId}.jsonl`),
    [
      {
        type: 'user',
        timestamp: '2026-02-27T10:46:00.000Z',
        sessionId,
        userType: 'external',
        message: {
          role: 'user',
          content: 'hello',
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-02-27T10:46:52.881Z',
        sessionId,
        requestId: 'req-1',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 8086,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 96256,
            output_tokens: 2058,
          },
        },
      },
    ]
  );

  const rows = await collectRawRows({ claudeDir, getPricing });

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    Date: '2026-02-27T10:46:52.881Z',
    Source: 'Claude Code',
    User: 'unknown',
    'Cloud Agent ID': '',
    'Automation ID': '',
    Kind: 'Included',
    Model: 'claude-opus-4-6',
    'Max Mode': 'No',
    'Input (w/ Cache Write)': 0,
    'Input (w/o Cache Write)': 8086,
    'Cache Read': 96256,
    'Output Tokens': 2058,
    'Total Tokens': 106400,
    Cost: 0.14,
  });
});

test('Claude Code source rows use OpenAI pricing when the recorded model is GPT', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'project-a', 'gpt-session.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-07-31T02:17:00.000Z',
      sessionId: 'gpt-session',
      cloudAgentId: 'a7a60929e04c2508f',
      message: {
        role: 'assistant',
        model: 'gpt-5.6-sol',
        usage: {
          input_tokens: 100000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 100000,
        },
      },
    },
  ]);

  const rows = await collectRawRows({ claudeDir, getPricing });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Source, 'Claude Code');
  assert.equal(rows[0].Provider, undefined);
  assert.equal(rows[0].Model, 'gpt-5.6-sol');
  assert.equal(rows[0].Cost, 3.5);
});

test('collectRawRows prefers project logs and dedupes transcript duplicates', async () => {
  const claudeDir = makeTempClaudeDir();
  const assistantEntry = {
    type: 'assistant',
    timestamp: '2026-02-26T06:40:20.792Z',
    sessionId: 'same-session',
    requestId: 'req-dup',
    userType: 'bilab.snu.1@proton.me',
    message: {
      role: 'assistant',
      model: 'claude-4.6-opus-high-thinking',
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 54799,
        cache_read_input_tokens: 13160,
        output_tokens: 376,
      },
    },
  };

  writeJsonl(
    path.join(claudeDir, 'projects', 'project-a', 'same-session.jsonl'),
    [assistantEntry]
  );
  writeJsonl(
    path.join(claudeDir, 'transcripts', 'ses_same-session.jsonl'),
    [assistantEntry]
  );

  const rows = await collectRawRows({ claudeDir, getPricing });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].User, 'bilab.snu.1@proton.me');
  assert.equal(rows[0]['Input (w/ Cache Write)'], 54799);
  assert.equal(rows[0]['Input (w/o Cache Write)'], 3);
  assert.equal(rows[0]['Cache Read'], 13160);
  assert.equal(rows[0]['Output Tokens'], 376);
  assert.equal(rows[0]['Total Tokens'], 68338);
  assert.equal(rows[0].Cost, 0.36);
});

test('CLAUDE_USAGE_USER overrides the exported user without exposing a hard-coded identity', async () => {
  const claudeDir = makeTempClaudeDir();
  const previousUser = process.env.CLAUDE_USAGE_USER;
  process.env.CLAUDE_USAGE_USER = 'local-user@example.com';

  writeJsonl(path.join(claudeDir, 'projects', 'project-a', 'configured-user.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-02-27T10:46:52.881Z',
      sessionId: 'configured-user-session',
      requestId: 'configured-user-request',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
    },
  ]);

  try {
    const rows = await collectRawRows({ claudeDir, getPricing });
    assert.equal(rows[0].User, 'local-user@example.com');
  } finally {
    if (previousUser === undefined) {
      delete process.env.CLAUDE_USAGE_USER;
    } else {
      process.env.CLAUDE_USAGE_USER = previousUser;
    }
  }
});

test('collectRawRows skips synthetic assistant entries', async () => {
  const claudeDir = makeTempClaudeDir();

  writeJsonl(path.join(claudeDir, 'projects', 'project-a', 'synthetic.jsonl'), [
    {
      type: 'assistant',
      timestamp: '2026-03-25T16:15:32.665Z',
      sessionId: 'synthetic-session',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  ]);

  const rows = await collectRawRows({ claudeDir, getPricing });

  assert.equal(rows.length, 0);
});

test('collectRawRows with since option skips files whose mtime is older than the cutoff', async () => {
  const claudeDir = makeTempClaudeDir();
  const oldFile = path.join(claudeDir, 'projects', 'project-a', 'old-session.jsonl');
  const recentFile = path.join(claudeDir, 'projects', 'project-a', 'recent-session.jsonl');

  writeJsonl(oldFile, [
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'old',
      requestId: 'req-old',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 10,
        },
      },
    },
  ]);

  writeJsonl(recentFile, [
    {
      type: 'assistant',
      timestamp: '2026-05-20T00:00:00.000Z',
      sessionId: 'recent',
      requestId: 'req-recent',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 20,
        },
      },
    },
  ]);

  const oldMtime = new Date('2026-01-02T00:00:00.000Z');
  const recentMtime = new Date('2026-05-20T01:00:00.000Z');
  fs.utimesSync(oldFile, oldMtime, oldMtime);
  fs.utimesSync(recentFile, recentMtime, recentMtime);

  const since = Date.parse('2026-04-21T00:00:00.000Z');
  const rows = await collectRawRows({ claudeDir, getPricing, since });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Date, '2026-05-20T00:00:00.000Z');
});

test('collectRawRows with since option drops entries older than the cutoff inside recent files', async () => {
  const claudeDir = makeTempClaudeDir();
  const mixedFile = path.join(claudeDir, 'projects', 'project-a', 'mixed.jsonl');

  writeJsonl(mixedFile, [
    {
      type: 'assistant',
      timestamp: '2026-01-15T00:00:00.000Z',
      sessionId: 'mixed',
      requestId: 'req-stale',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 10,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-15T00:00:00.000Z',
      sessionId: 'mixed',
      requestId: 'req-fresh',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 20,
        },
      },
    },
  ]);

  const recentMtime = new Date('2026-05-15T01:00:00.000Z');
  fs.utimesSync(mixedFile, recentMtime, recentMtime);

  const since = Date.parse('2026-04-21T00:00:00.000Z');
  const rows = await collectRawRows({ claudeDir, getPricing, since });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Date, '2026-05-15T00:00:00.000Z');
});

test('collectRawRows keeps only the latest assistant usage for the same requestId', async () => {
  const claudeDir = makeTempClaudeDir();
  const sessionId = 'session-dedupe';

  writeJsonl(path.join(claudeDir, 'projects', 'project-a', `${sessionId}.jsonl`), [
    {
      type: 'user',
      timestamp: '2026-03-26T00:24:40.000Z',
      sessionId,
      userType: 'external',
      message: {
        role: 'user',
        content: 'hello',
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-03-26T00:24:41.424Z',
      sessionId,
      requestId: 'req-same',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 161594,
          cache_read_input_tokens: 0,
          output_tokens: 8,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-03-26T00:24:43.160Z',
      sessionId,
      requestId: 'req-same',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 161594,
          cache_read_input_tokens: 0,
          output_tokens: 8,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-03-26T00:24:45.434Z',
      sessionId,
      requestId: 'req-same',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 161594,
          cache_read_input_tokens: 0,
          output_tokens: 632,
        },
      },
    },
  ]);

  const rows = await collectRawRows({ claudeDir, getPricing });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].Date, '2026-03-26T00:24:45.434Z');
  assert.equal(rows[0]['Output Tokens'], 632);
  assert.equal(rows[0]['Total Tokens'], 162229);
  assert.equal(rows[0].Cost, 1.03);
});

test('collectRawRows uses per-file mtime cache to skip re-parsing unchanged jsonl files', async () => {
  const claudeDir = makeTempClaudeDir();
  const filePath = path.join(claudeDir, 'projects', 'cache-test', 'session.jsonl');

  writeJsonl(filePath, [
    {
      type: 'assistant',
      timestamp: '2026-05-01T10:00:00.000Z',
      sessionId: 'cache-sess',
      requestId: 'r-cache-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 20,
        },
      },
    },
  ]);

  const parser = require('../src/parser');
  const { __clearParseCache, __getParseCacheStats } = parser;

  __clearParseCache();
  let stats = __getParseCacheStats();
  assert.equal(stats.size, 0);
  assert.equal(stats.hits || 0, 0);

  const rows1 = await collectRawRows({ claudeDir, getPricing });
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0]['Output Tokens'], 20);

  stats = __getParseCacheStats();
  assert.ok(stats.size >= 1, 'first collect should populate the file cache');
  const hitsAfterFirst = stats.hits || 0;
  const missesAfterFirst = stats.misses || 0;
  assert.ok(missesAfterFirst >= 1, 'first access should be a miss');

  // Second call with zero file changes → must hit cache and return identical data
  const rows2 = await collectRawRows({ claudeDir, getPricing });
  assert.deepEqual(rows2, rows1);

  stats = __getParseCacheStats();
  assert.ok((stats.hits || 0) > hitsAfterFirst, 'second collect on unchanged files must produce cache hits');

  // Mutate the file (content + mtime changes) → must reparse that file
  writeJsonl(filePath, [
    {
      type: 'assistant',
      timestamp: '2026-05-01T11:30:00.000Z',
      sessionId: 'cache-sess',
      requestId: 'r-cache-2',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 35,
        },
      },
    },
  ]);

  const rows3 = await collectRawRows({ claudeDir, getPricing });
  assert.equal(rows3.length, 1);
  assert.equal(rows3[0].Date, '2026-05-01T11:30:00.000Z');
  assert.equal(rows3[0]['Output Tokens'], 35);
  assert.equal(rows3[0]['Total Tokens'], 85);
});

test('createProgressTracker reports total, processed, percent and phase', () => {
  const { createProgressTracker } = require('../src/parser');
  const tracker = createProgressTracker();

  let p = tracker.get();
  assert.equal(p.phase, 'idle');
  assert.equal(p.total, 0);
  assert.equal(p.processed, 0);
  assert.equal(p.percent, 0);

  tracker.setTotal(1000);
  tracker.setPhase('parsing');
  tracker.increment();
  tracker.increment();

  p = tracker.get();
  assert.equal(p.phase, 'parsing');
  assert.equal(p.total, 1000);
  assert.equal(p.processed, 2);
  assert.equal(p.percent, 0); // still 0% at 2/1000

  // jump to near end
  for (let i = 0; i < 498; i++) tracker.increment();

  p = tracker.get();
  assert.equal(p.processed, 500);
  assert.equal(p.percent, 50);

  tracker.increment();
  p = tracker.get();
  assert.equal(p.percent, 50); // still 50 (floor)

  // reach 100%
  for (let i = 0; i < 499; i++) tracker.increment();
  p = tracker.get();
  assert.equal(p.percent, 100);
});
