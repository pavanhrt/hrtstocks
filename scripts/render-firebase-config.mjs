// Renders hosting/firebase.template.json into a firebase.json for the Firebase CLI.
//
//   FIREBASE_SITE_ID=hrtstocks-qa CLOUD_RUN_SERVICE_ID=hrtstocks-qa-app CLOUD_RUN_REGION=asia-south1 \
//     node scripts/render-firebase-config.mjs [output-path]
//
// Terraform (infra/terraform/firebase.tf) is the authoritative way to configure Hosting; this template exists so the
// same rewrite can be reproduced or checked with the Firebase CLI without ever hard-coding a project or site ID.
// The output is written to stdout unless a path is given. Nothing is deployed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hosting", "firebase.template.json");

const SHAPES = {
  FIREBASE_SITE_ID: /^[a-z0-9][a-z0-9-]{2,28}[a-z0-9]$/,
  CLOUD_RUN_SERVICE_ID: /^[a-z][a-z0-9-]{0,62}$/,
  CLOUD_RUN_REGION: /^[a-z]+-[a-z]+[0-9]+$/,
};

export function renderFirebaseConfig(env = process.env, template = fs.readFileSync(TEMPLATE, "utf8")) {
  const values = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    const v = env[name];
    if (!v || !shape.test(v)) throw new Error(`${name} is missing or malformed`);
    values[name] = v;
  }
  const rendered = template.replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Template placeholder \${${name}} has no value`);
    return values[name];
  });
  const config = JSON.parse(rendered); // fails loudly if the result is not valid JSON
  const rewrites = config.hosting?.rewrites ?? [];
  if (rewrites.length !== 1 || rewrites[0].source !== "**" || !rewrites[0].run?.serviceId) {
    throw new Error("Hosting must have exactly one catch-all rewrite to Cloud Run");
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = renderFirebaseConfig();
    if (process.argv[2]) fs.writeFileSync(process.argv[2], out);
    else process.stdout.write(out);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
