const XLSX = require('xlsx');

const RAW_COLUMNS = [
  'Date',
  'User',
  'Cloud Agent ID',
  'Automation ID',
  'Kind',
  'Model',
  'Max Mode',
  'Input (w/ Cache Write)',
  'Input (w/o Cache Write)',
  'Cache Read',
  'Output Tokens',
  'Total Tokens',
  'Cost',
];

function buildWorkbookBuffer(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const normalizedRows = rows.map((row) =>
    Object.fromEntries(
      RAW_COLUMNS.map((column) => [column, row && typeof row === 'object' ? row[column] : undefined]),
    ),
  );
  const worksheet = XLSX.utils.json_to_sheet(normalizedRows, {
    header: RAW_COLUMNS,
    skipHeader: false,
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Raw');

  return XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer',
  });
}

module.exports = {
  RAW_COLUMNS,
  buildWorkbookBuffer,
};
