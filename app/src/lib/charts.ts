/**
 * Chart SVGs live in a private Cloud Storage bucket and are served to signed-in
 * users through the authenticated same-origin route app/api/charts/[...path].
 * (Replaces Supabase signed URLs.) Object paths are content-addressed and
 * immutable, so responses are safely cacheable by the browser.
 */
export function chartUrl(objectPath: string): string {
  return `/api/charts/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

// '&' is allowed because NSE symbols such as M&M appear in instrument ids (and therefore object paths); it is URL-encoded in links.
const SAFE_OBJECT_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-=&]*(\/[A-Za-z0-9][A-Za-z0-9._\-=&]*)*$/;

/** Rejects traversal, absolute paths, control characters and anything unusual before touching storage. */
export function isSafeObjectPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && SAFE_OBJECT_PATH.test(path);
}
