// Parses fundamentals/fundamental-score.yaml into the row shape stored in a
// future fundamental_score_versions table -- mirrors parse-strategies.mjs's
// own role for strategies/*.yaml + config/parameters.yaml. YAML stays the
// authored source of truth; this module only reads and normalizes it.
//
// Used by: scoring.test.js/sector-models.test.js (to exercise the real
// spec, not a hand-typed fixture) and, once a fundamental-data provider is
// approved, a seed-fundamental-score.mjs analogous to seed-strategies.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

export function parseFundamentalScoreSpec() {
  const full = path.join(ROOT, "fundamentals", "fundamental-score.yaml");
  const doc = yaml.load(readFileSync(full, "utf8"));
  return {
    scoreVersion: doc.definition.score_version,
    status: doc.definition.status,
    spec: doc,
  };
}
