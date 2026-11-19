const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function parseOrigin(value, name) {
  const url = new URL(value);
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment.`);
  }
  return url;
}

export function resolveShortCaptureBrowserOrigin(appOrigin, browserOrigin) {
  const appUrl = parseOrigin(appOrigin, "SHORT_CAPTURE_APP_ORIGIN");
  if (!LOCAL_HOSTS.has(appUrl.hostname)) {
    throw new Error("SHORT_CAPTURE_APP_ORIGIN must use localhost or 127.0.0.1.");
  }

  const browserUrl = parseOrigin(browserOrigin ?? appOrigin, "SHORT_CAPTURE_BROWSER_ORIGIN");
  if (!LOCAL_HOSTS.has(browserUrl.hostname) && browserUrl.protocol !== "https:") {
    throw new Error("SHORT_CAPTURE_BROWSER_ORIGIN must use HTTPS unless it is localhost.");
  }

  return browserUrl.origin;
}
