const test = require('node:test');
const assert = require('node:assert/strict');

const { sortRows } = require('../src/sort');

test('sortRows preserves input order when sort params are absent or invalid', () => {
  const rows = [
    { Date: '2026-03-26T12:00:00.000Z', User: 'Charlie' },
    { Date: '2026-03-25T12:00:00.000Z', User: 'Bravo' },
    { Date: '2026-03-24T12:00:00.000Z', User: 'Alpha' },
  ];

  assert.deepEqual(sortRows(rows), rows);
  assert.deepEqual(sortRows(rows, { sortBy: 'Unknown', sortDirection: 'asc' }), rows);
  assert.deepEqual(sortRows(rows, { sortBy: 'User', sortDirection: 'sideways' }), rows);
  assert.deepEqual(rows.map((row) => row.User), ['Charlie', 'Bravo', 'Alpha']);
});

test('sortRows sorts dates by actual timestamp', () => {
  const rows = [
    { id: 'latest', Date: '2026-03-26T12:00:00.000Z' },
    { id: 'middle', Date: new Date('2026-03-25T12:00:00.000Z') },
    { id: 'earliest', Date: 1774353600000 },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'Date', sortDirection: 'asc' }).map((row) => row.id),
    ['earliest', 'middle', 'latest']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Date', sortDirection: 'desc' }).map((row) => row.id),
    ['latest', 'middle', 'earliest']
  );
});

test('sortRows sorts numeric columns numerically', () => {
  const rows = [
    { id: 'ten', 'Total Tokens': 10 },
    { id: 'two', 'Total Tokens': '2' },
    { id: 'thirty', 'Total Tokens': 30 },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'Total Tokens', sortDirection: 'asc' }).map((row) => row.id),
    ['two', 'ten', 'thirty']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Total Tokens', sortDirection: 'desc' }).map((row) => row.id),
    ['thirty', 'ten', 'two']
  );
});

test('sortRows sorts text columns with locale-aware comparison', () => {
  const collator = new Intl.Collator(undefined, {
    numeric: false,
    sensitivity: 'base',
  });
  const rows = [
    { id: 'charlie', User: 'charlie' },
    { id: 'alpha', User: 'Alpha' },
    { id: 'bravo', User: 'bravo' },
  ];
  const ascendingExpected = rows
    .slice()
    .sort((left, right) => collator.compare(left.User, right.User))
    .map((row) => row.id);

  assert.deepEqual(
    sortRows(rows, { sortBy: 'User', sortDirection: 'asc' }).map((row) => row.id),
    ascendingExpected
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'User', sortDirection: 'desc' }).map((row) => row.id),
    ascendingExpected.slice().reverse()
  );
});

test('sortRows always pushes empty values to the end', () => {
  const rows = [
    { id: 'missing', Cost: null },
    { id: 'zero', Cost: 0 },
    { id: 'blank', Cost: '' },
    { id: 'low', Cost: 1.25 },
    { id: 'undefined', Cost: undefined },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'Cost', sortDirection: 'asc' }).map((row) => row.id),
    ['zero', 'low', 'missing', 'blank', 'undefined']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Cost', sortDirection: 'desc' }).map((row) => row.id),
    ['low', 'zero', 'missing', 'blank', 'undefined']
  );
});

test('sortRows treats invalid dates like missing values and sorts them last', () => {
  const rows = [
    { id: 'invalid', Date: 'not-a-date' },
    { id: 'middle', Date: '2026-03-25T12:00:00.000Z' },
    { id: 'earliest', Date: '2026-03-24T12:00:00.000Z' },
    { id: 'empty', Date: '' },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'Date', sortDirection: 'asc' }).map((row) => row.id),
    ['earliest', 'middle', 'invalid', 'empty']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Date', sortDirection: 'desc' }).map((row) => row.id),
    ['middle', 'earliest', 'invalid', 'empty']
  );
});

test('sortRows treats invalid numeric values like missing values and sorts them last', () => {
  const rows = [
    { id: 'invalid', Cost: 'not-a-number' },
    { id: 'high', Cost: 3.5 },
    { id: 'low', Cost: '1.25' },
    { id: 'missing', Cost: null },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'Cost', sortDirection: 'asc' }).map((row) => row.id),
    ['low', 'high', 'invalid', 'missing']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Cost', sortDirection: 'desc' }).map((row) => row.id),
    ['high', 'low', 'invalid', 'missing']
  );
});

test('sortRows preserves input order for equal sort keys', () => {
  const rows = [
    { id: 'first', User: 'Alpha', Cost: 2 },
    { id: 'second', User: 'alpha', Cost: 2 },
    { id: 'third', User: 'Bravo', Cost: 2 },
  ];

  assert.deepEqual(
    sortRows(rows, { sortBy: 'User', sortDirection: 'asc' }).map((row) => row.id),
    ['first', 'second', 'third']
  );
  assert.deepEqual(
    sortRows(rows, { sortBy: 'Cost', sortDirection: 'desc' }).map((row) => row.id),
    ['first', 'second', 'third']
  );
});
