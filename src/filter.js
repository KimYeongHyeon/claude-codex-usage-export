const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const timeZoneDateFormatters = new Map();

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

function resolveNowTimestamp(now) {
  const timestamp = toTimestamp(now);
  return timestamp === null ? Date.now() : timestamp;
}

function resolveTzOffsetMinutes(tzOffsetMinutes, nowTimestamp) {
  if (Number.isFinite(tzOffsetMinutes)) {
    return tzOffsetMinutes;
  }

  return new Date(nowTimestamp).getTimezoneOffset();
}

function getLocalDayStartUtc(timestamp, tzOffsetMinutes) {
  const localTimestamp = timestamp - tzOffsetMinutes * MINUTE_MS;
  const localDayStart = Math.floor(localTimestamp / DAY_MS) * DAY_MS;
  return localDayStart + tzOffsetMinutes * MINUTE_MS;
}

function getTimeZoneDateFormatter(timeZone) {
  let formatter = timeZoneDateFormatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    timeZoneDateFormatters.set(timeZone, formatter);
  }

  return formatter;
}

function getTimeZoneDateParts(timestamp, timeZone) {
  const formatter = getTimeZoneDateFormatter(timeZone);
  const parts = formatter.formatToParts(new Date(timestamp));

  return {
    year: Number(parts.find((part) => part.type === 'year').value),
    month: Number(parts.find((part) => part.type === 'month').value),
    day: Number(parts.find((part) => part.type === 'day').value),
  };
}

function compareDateParts(left, right) {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  if (left.month !== right.month) {
    return left.month - right.month;
  }

  return left.day - right.day;
}

function shiftDateParts(parts, days) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function getTimeZoneDayStartUtc(targetDateParts, timeZone) {
  const utcGuess = Date.UTC(
    targetDateParts.year,
    targetDateParts.month - 1,
    targetDateParts.day
  );

  let low = utcGuess - 2 * DAY_MS;
  let high = utcGuess + 2 * DAY_MS;

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const midDateParts = getTimeZoneDateParts(mid, timeZone);

    if (compareDateParts(midDateParts, targetDateParts) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getCalendarDayRange(nowTimestamp, timeZone, dayOffset) {
  const targetDateParts = shiftDateParts(
    getTimeZoneDateParts(nowTimestamp, timeZone),
    dayOffset
  );

  return {
    start: getTimeZoneDayStartUtc(targetDateParts, timeZone),
    end: getTimeZoneDayStartUtc(shiftDateParts(targetDateParts, 1), timeZone),
    inclusiveEnd: false,
  };
}

function getPresetRange(options = {}) {
  const preset = String(options.preset || 'all');
  if (preset === 'all') {
    return null;
  }

  const nowTimestamp = resolveNowTimestamp(options.now);
  const tzOffsetMinutes = resolveTzOffsetMinutes(options.tzOffsetMinutes, nowTimestamp);

  if (preset === 'last24h') {
    return {
      start: nowTimestamp - DAY_MS,
      end: nowTimestamp,
      inclusiveEnd: true,
    };
  }

  if (preset === 'last7d') {
    return {
      start: nowTimestamp - 7 * DAY_MS,
      end: nowTimestamp,
      inclusiveEnd: true,
    };
  }

  if (preset === 'last30d') {
    return {
      start: nowTimestamp - 30 * DAY_MS,
      end: nowTimestamp,
      inclusiveEnd: true,
    };
  }

  if (preset === 'today') {
    if (options.timeZone) {
      return getCalendarDayRange(nowTimestamp, options.timeZone, 0);
    }

    const start = getLocalDayStartUtc(nowTimestamp, tzOffsetMinutes);
    return {
      start,
      end: start + DAY_MS,
      inclusiveEnd: false,
    };
  }

  if (preset === 'yesterday') {
    if (options.timeZone) {
      return getCalendarDayRange(nowTimestamp, options.timeZone, -1);
    }

    const end = getLocalDayStartUtc(nowTimestamp, tzOffsetMinutes);
    return {
      start: end - DAY_MS,
      end,
      inclusiveEnd: false,
    };
  }

  return null;
}

function filterRows(rows, options = {}) {
  const range = getPresetRange(options);
  if (!range) {
    return rows.slice();
  }

  return rows.filter((row) => {
    const timestamp = toTimestamp(row && row.Date);
    if (timestamp === null) {
      return false;
    }

    if (timestamp < range.start) {
      return false;
    }

    if (range.inclusiveEnd) {
      return timestamp <= range.end;
    }

    return timestamp < range.end;
  });
}

module.exports = {
  filterRows,
  getPresetRange,
};
