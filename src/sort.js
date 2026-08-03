const RAW_SORT_COLUMNS = [
  'Date',
  'Source',
  'Model',
  'User',
  'Cloud Agent ID',
  'Automation ID',
  'Kind',
  'Max Mode',
  'Input (w/ Cache Write)',
  'Input (w/o Cache Write)',
  'Cache Read',
  'Output Tokens',
  'Total Tokens',
  'Cost',
];

const NUMERIC_COLUMNS = new Set([
  'Input (w/ Cache Write)',
  'Input (w/o Cache Write)',
  'Cache Read',
  'Output Tokens',
  'Total Tokens',
  'Cost',
]);

const TEXT_COLLATOR = new Intl.Collator(undefined, {
  numeric: false,
  sensitivity: 'base',
});

function isEmptyValue(value) {
  return value === null || value === undefined || value === '';
}

function toNumericValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value !== '') {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  return null;
}

function toTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  return null;
}

function getComparableValue(sortBy, value) {
  if (isEmptyValue(value)) {
    return null;
  }

  if (sortBy === 'Date') {
    return toTimestamp(value);
  }

  if (NUMERIC_COLUMNS.has(sortBy)) {
    return toNumericValue(value);
  }

  return String(value);
}

function compareValues(sortBy, left, right) {
  if (sortBy === 'Date' || NUMERIC_COLUMNS.has(sortBy)) {
    return left - right;
  }

  return TEXT_COLLATOR.compare(left, right);
}

function normalizeSortDirection(direction) {
  if (direction === 'asc' || direction === 'desc') {
    return direction;
  }

  return null;
}

function sortRows(rows, options = {}) {
  const { sortBy } = options;
  const sortDirection = normalizeSortDirection(options.sortDirection);

  if (!RAW_SORT_COLUMNS.includes(sortBy) || !sortDirection) {
    return rows.slice();
  }

  const directionMultiplier = sortDirection === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((leftEntry, rightEntry) => {
      const leftValue = getComparableValue(sortBy, leftEntry.row && leftEntry.row[sortBy]);
      const rightValue = getComparableValue(sortBy, rightEntry.row && rightEntry.row[sortBy]);
      const leftEmpty = leftValue === null;
      const rightEmpty = rightValue === null;

      if (leftEmpty || rightEmpty) {
        if (leftEmpty && rightEmpty) {
          return leftEntry.index - rightEntry.index;
        }

        return leftEmpty ? 1 : -1;
      }

      const comparison = compareValues(sortBy, leftValue, rightValue);
      if (comparison !== 0) {
        return comparison * directionMultiplier;
      }

      return leftEntry.index - rightEntry.index;
    })
    .map((entry) => entry.row);
}

module.exports = {
  NUMERIC_COLUMNS,
  RAW_SORT_COLUMNS,
  sortRows,
};
