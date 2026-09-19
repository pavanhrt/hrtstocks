import { isExistingChartObjectError } from "../run-screening/charts/immutable-path.js";

/**
 * Chart SVG storage (private Cloud Storage bucket). Replaces Supabase Storage.
 *
 * Objects are content-addressed and immutable: `ifGenerationMatch: 0` makes the
 * upload a no-op error when the object already exists, which is treated as
 * success (identical bytes, identical path). Every stored object is registered
 * in `stored_objects` so publication (publish_*() SQL functions) can prove each
 * referenced chart exists, and the web app only serves registered paths.
 */
export const CHART_BUCKET_ID = "direction-charts"; // logical id kept in stored_objects.bucket

/** Upper bound for one chart. Generated charts are tens of KB; anything near this is a bug, not a chart. */
export const MAX_CHART_BYTES = 2 * 1024 * 1024;

const OBJECT_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-=&]*(\/[A-Za-z0-9][A-Za-z0-9._\-=&]*)*\.svg$/;
// Content that must never appear in a stored SVG (script execution, embedded documents, external references).
const FORBIDDEN_SVG = [/<\s*script/i, /\son[a-z]+\s*=/i, /javascript\s*:/i, /<\s*(iframe|object|embed|foreignObject)/i, /(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i, /<!ENTITY/i];

/**
 * Server-side validation before anything is written: file type, size and content. Throws on the first problem.
 * (There is no user upload path; only the pipeline writes charts, but the store still refuses anything unsafe.)
 */
export function validateChartUpload(objectPath, svg) {
  if (typeof objectPath !== "string" || objectPath.length > 512 || !OBJECT_PATH.test(objectPath)) throw new Error(`Refusing chart with an unsafe object path: ${String(objectPath).slice(0, 80)}`);
  if (typeof svg !== "string") throw new Error("Chart content must be an SVG string.");
  const size = Buffer.byteLength(svg);
  if (size === 0 || size > MAX_CHART_BYTES) throw new Error(`Chart size ${size} bytes is outside the allowed range (1..${MAX_CHART_BYTES}).`);
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(svg)) throw new Error("Chart content is not an SVG document.");
  for (const bad of FORBIDDEN_SVG) if (bad.test(svg)) throw new Error("Chart SVG contains disallowed content.");
}

/**
 * @param {import("../db/client.js").Db} db
 * @param {{ bucket: { file(name: string): { save(data: string, opts: object): Promise<void> } } }} objectBucket
 *        a @google-cloud/storage Bucket (or a compatible fake in tests)
 */
export function createChartStore(db, objectBucket) {
  return {
    /** Stores an SVG at `objectPath` (idempotently) and registers it. Throws on real storage failures. */
    async putSvg(objectPath, svg) {
      validateChartUpload(objectPath, svg);
      try {
        await objectBucket.file(objectPath).save(svg, {
          contentType: "image/svg+xml",
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (err) {
        if (!isExistingChartObjectError(err)) throw err;
      }
      await db.query(
        `insert into stored_objects (bucket, name, size_bytes, content_type)
         values ($1, $2, $3, 'image/svg+xml')
         on conflict (bucket, name) do nothing`,
        [CHART_BUCKET_ID, objectPath, Buffer.byteLength(svg)],
      );
    },
  };
}

/** Opens the real chart bucket from the environment (CHART_BUCKET). ADC credentials; no key files. */
export async function openChartStore(db, env = process.env) {
  if (!env.CHART_BUCKET) throw new Error("CHART_BUCKET is not set.");
  const { Storage } = await import("@google-cloud/storage");
  return createChartStore(db, new Storage().bucket(env.CHART_BUCKET));
}
