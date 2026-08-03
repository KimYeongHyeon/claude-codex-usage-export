function resolveAppUrl(relativePath, currentHref) {
  const currentUrl = new URL(currentHref);
  const basePath = currentUrl.pathname.endsWith('/')
    ? currentUrl.pathname
    : `${currentUrl.pathname}/`;
  const cleanRelativePath = String(relativePath || '').replace(/^\/+/, '');

  return new URL(cleanRelativePath, `${currentUrl.origin}${basePath}`);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveAppUrl };
}
