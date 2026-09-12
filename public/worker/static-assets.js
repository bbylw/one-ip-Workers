import { assetEntry, assets } from "./assets.generated.js";

/**
 * Serves the SPA build packed into the Worker bundle by
 * scripts/build-worker-assets.mjs.
 *
 * The project deploys as a single Worker without Static Assets, so this module
 * replaces the `env.ASSETS.fetch(request)` delegation and implements the
 * behaviours the `[assets]` configuration used to provide:
 * `not_found_handling = "single-page-application"` and the `public/_headers`
 * entries.
 */

// Equivalent of `/*` in public/_headers.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

// Vite fingerprints every file under /assets/, so it is safe to cache forever.
const IMMUTABLE_PATH = /^\/assets\//;

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf("/"));
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

// File extensions this build actually ships. Anything else is an application
// route (including deep links such as /network/ip/1.1.1.1), not a file request.
const FILE_EXTENSIONS = new Set(
  Object.keys(assets)
    .map(extensionOf)
    .filter(
      (extension) => extension && extension !== ".html" && extension !== ".htm",
    ),
);

const decoded = new Map();

function bodyFor(path, record) {
  const cached = decoded.get(path);
  if (cached) return cached;
  const binary = atob(record.d);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  decoded.set(path, bytes);
  return bytes;
}

function headersFor(path, record) {
  return new Headers({
    ...SECURITY_HEADERS,
    "content-type": record.t,
    etag: record.h,
    "cache-control": IMMUTABLE_PATH.test(path)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
  });
}

function isFresh(request, etag) {
  const value = request.headers.get("If-None-Match");
  if (!value) return false;
  if (value.trim() === "*") return true;
  return value.split(",").some((tag) => {
    const trimmed = tag.trim();
    return trimmed === etag || trimmed === `W/${etag}`;
  });
}

function respond(request, path, record) {
  const headers = headersFor(path, record);
  if (isFresh(request, record.h))
    return new Response(null, { status: 304, headers });
  return new Response(
    request.method === "HEAD" ? null : bodyFor(path, record),
    {
      status: 200,
      headers,
    },
  );
}

function wantsPage(path) {
  const extension = extensionOf(path);
  // Retired .html pages and extension-less routes both resolve to the shell in
  // the same way `not_found_handling = "single-page-application"` served them.
  if (extension === ".html" || extension === ".htm") return true;
  return !FILE_EXTENSIONS.has(extension);
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: SECURITY_HEADERS,
  });
}

/**
 * @param {Request} request
 * @returns {Response}
 */
export function serveStatic(request) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...SECURITY_HEADERS, allow: "GET, HEAD" },
    });

  let path = new URL(request.url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return new Response("Invalid URL encoding", {
      status: 400,
      headers: SECURITY_HEADERS,
    });
  }
  // Lookups only ever hit the embedded map, so encoded traversal cannot escape.
  if (path.endsWith("/")) path += "index.html";

  const record = assets[path];
  if (record) return respond(request, path, record);

  const entry = assets[assetEntry];
  if (!entry) return notFound();
  // Mirrors `not_found_handling = "single-page-application"`: unknown routes and
  // retired .html pages get the SPA shell, while a missing file keeps its 404 so
  // callers never receive HTML in place of a script or image.
  if (!wantsPage(path)) return notFound();
  return respond(request, assetEntry, entry);
}
