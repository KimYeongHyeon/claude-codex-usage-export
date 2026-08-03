const test = require('node:test');
const assert = require('node:assert/strict');

const { filterRows } = require('../src/filter');

test('filterRows returns all rows for all and unknown presets', () => {
  const rows = [
    { Date: '2026-03-26T10:00:00.000Z', id: 'valid' },
    { Date: '', id: 'missing' },
    { Date: 'not-a-date', id: 'invalid' },
  ];

  assert.deepEqual(filterRows(rows, { preset: 'all' }), rows);
  assert.deepEqual(filterRows(rows, { preset: 'unknown' }), rows);
});

test('filterRows excludes invalid or missing dates from non-all presets', () => {
  const rows = [
    { Date: '2026-03-26T11:59:59.000Z', id: 'valid' },
    { Date: '', id: 'missing' },
    { Date: 'not-a-date', id: 'invalid' },
  ];

  const filtered = filterRows(rows, {
    preset: 'last24h',
    now: '2026-03-26T12:00:00.000Z',
  });

  assert.deepEqual(filtered, [{ Date: '2026-03-26T11:59:59.000Z', id: 'valid' }]);
});

test('filterRows applies rolling last24h and last7d windows from now', () => {
  const rows = [
    { Date: '2026-03-26T12:00:00.000Z', id: 'now' },
    { Date: '2026-03-25T12:00:00.000Z', id: 'day-boundary' },
    { Date: '2026-03-25T11:59:59.999Z', id: 'before-day-boundary' },
    { Date: '2026-03-19T12:00:00.000Z', id: 'week-boundary' },
    { Date: '2026-03-19T11:59:59.999Z', id: 'before-week-boundary' },
  ];

  const options = { now: '2026-03-26T12:00:00.000Z' };

  assert.deepEqual(
    filterRows(rows, { ...options, preset: 'last24h' }).map((row) => row.id),
    ['now', 'day-boundary']
  );
  assert.deepEqual(
    filterRows(rows, { ...options, preset: 'last7d' }).map((row) => row.id),
    ['now', 'day-boundary', 'before-day-boundary', 'week-boundary']
  );
});

test('filterRows applies rolling last30d window from now', () => {
  const rows = [
    { Date: '2026-03-26T12:00:00.000Z', id: 'now' },
    { Date: '2026-02-24T12:00:00.000Z', id: 'month-boundary' },
    { Date: '2026-02-24T11:59:59.999Z', id: 'before-month-boundary' },
  ];

  const filtered = filterRows(rows, {
    preset: 'last30d',
    now: '2026-03-26T12:00:00.000Z',
  });

  assert.deepEqual(filtered.map((row) => row.id), ['now', 'month-boundary']);
});

test('filterRows uses browser-local day boundaries for today', () => {
  const rows = [
    { Date: '2026-03-26T04:59:59.999Z', id: 'before-local-midnight' },
    { Date: '2026-03-26T05:00:00.000Z', id: 'local-midnight' },
    { Date: '2026-03-26T12:00:00.000Z', id: 'today' },
    { Date: '2026-03-27T04:59:59.999Z', id: 'before-next-local-midnight' },
    { Date: '2026-03-27T05:00:00.000Z', id: 'next-local-midnight' },
  ];

  const filtered = filterRows(rows, {
    preset: 'today',
    tzOffsetMinutes: 300,
    now: '2026-03-26T12:00:00.000Z',
  });

  assert.deepEqual(filtered.map((row) => row.id), [
    'local-midnight',
    'today',
    'before-next-local-midnight',
  ]);
});

test('filterRows uses browser-local day boundaries for yesterday', () => {
  const rows = [
    { Date: '2026-03-25T04:59:59.999Z', id: 'before-yesterday' },
    { Date: '2026-03-25T05:00:00.000Z', id: 'yesterday-start' },
    { Date: '2026-03-26T04:59:59.999Z', id: 'yesterday-end' },
    { Date: '2026-03-26T05:00:00.000Z', id: 'today-start' },
  ];

  const filtered = filterRows(rows, {
    preset: 'yesterday',
    tzOffsetMinutes: 300,
    now: '2026-03-26T12:00:00.000Z',
  });

  assert.deepEqual(filtered.map((row) => row.id), [
    'yesterday-start',
    'yesterday-end',
  ]);
});

test('filterRows uses IANA timezone day boundaries for today across DST start', () => {
  const rows = [
    { Date: '2026-03-08T04:59:59.999Z', id: 'before-local-midnight' },
    { Date: '2026-03-08T05:00:00.000Z', id: 'local-midnight' },
    { Date: '2026-03-09T03:59:59.999Z', id: 'end-of-short-day' },
    { Date: '2026-03-09T04:00:00.000Z', id: 'next-local-midnight' },
  ];

  const filtered = filterRows(rows, {
    preset: 'today',
    timeZone: 'America/New_York',
    now: '2026-03-08T16:00:00.000Z',
  });

  assert.deepEqual(filtered.map((row) => row.id), [
    'local-midnight',
    'end-of-short-day',
  ]);
});

test('filterRows uses IANA timezone day boundaries for yesterday across DST start', () => {
  const rows = [
    { Date: '2026-03-07T05:00:00.000Z', id: 'yesterday-start' },
    { Date: '2026-03-08T04:59:59.999Z', id: 'yesterday-end' },
    { Date: '2026-03-08T05:00:00.000Z', id: 'today-start' },
  ];

  const filtered = filterRows(rows, {
    preset: 'yesterday',
    timeZone: 'America/New_York',
    now: '2026-03-08T16:00:00.000Z',
  });

  assert.deepEqual(filtered.map((row) => row.id), [
    'yesterday-start',
    'yesterday-end',
  ]);
});
