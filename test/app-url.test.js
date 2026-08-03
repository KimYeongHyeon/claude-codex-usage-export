const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAppUrl } = require('../src/app-url');

test('resolveAppUrl preserves a reverse-proxy subpath', () => {
  assert.equal(
    resolveAppUrl('api/raw', 'https://workspace.example/proxy/3457/').href,
    'https://workspace.example/proxy/3457/api/raw'
  );
});

test('resolveAppUrl treats a proxy URL without a trailing slash as an app root', () => {
  assert.equal(
    resolveAppUrl('/export.xlsx', 'https://workspace.example/proxy/3457').href,
    'https://workspace.example/proxy/3457/export.xlsx'
  );
});

test('resolveAppUrl keeps direct localhost requests at the origin root', () => {
  assert.equal(
    resolveAppUrl('api/progress', 'http://127.0.0.1:3457/').href,
    'http://127.0.0.1:3457/api/progress'
  );
});
