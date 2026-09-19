import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderFirebaseConfig } from "./render-firebase-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { FIREBASE_SITE_ID: "example-qa", CLOUD_RUN_SERVICE_ID: "example-qa-app", CLOUD_RUN_REGION: "asia-south1" };

test("renders one catch-all rewrite to the Cloud Run service in the configured region", () => {
  const cfg = JSON.parse(renderFirebaseConfig(env));
  assert.equal(cfg.hosting.site, "example-qa");
  assert.deepEqual(cfg.hosting.rewrites, [{ source: "**", run: { serviceId: "example-qa-app", region: "asia-south1" } }]);
});

test("refuses missing or malformed values instead of rendering a broken config", () => {
  assert.throws(() => renderFirebaseConfig({ ...env, FIREBASE_SITE_ID: undefined }), /FIREBASE_SITE_ID/);
  assert.throws(() => renderFirebaseConfig({ ...env, CLOUD_RUN_REGION: "asia south1" }), /CLOUD_RUN_REGION/);
  assert.throws(() => renderFirebaseConfig({ ...env, FIREBASE_SITE_ID: "Bad_Site" }), /FIREBASE_SITE_ID/);
});

test("the template hard-codes no project, site or host name", () => {
  const raw = fs.readFileSync(path.join(root, "hosting", "firebase.template.json"), "utf8");
  assert.doesNotMatch(raw, /hrtstocks|manaoorugpt|run\.app|web\.app/i);
});

test("the Terraform rewrite matches the template (one catch-all rewrite to Cloud Run)", () => {
  const tf = fs.readFileSync(path.join(root, "infra", "terraform", "firebase.tf"), "utf8");
  assert.match(tf, /rewrites\s*\{\s*glob\s*=\s*"\*\*"\s*run\s*\{/);
  assert.equal((tf.match(/rewrites\s*\{/g) ?? []).length, 1);
  assert.doesNotMatch(tf, /google_cloud_run_domain_mapping|google_compute_/);
});
