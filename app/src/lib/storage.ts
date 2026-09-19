import { Storage, type Bucket } from "@google-cloud/storage";
import { serverConfig } from "./config.ts";

/**
 * Private Cloud Storage bucket for chart SVGs. Authenticates with Application
 * Default Credentials (the runtime service account); no key file exists. Point
 * STORAGE_EMULATOR_HOST at a local fake-gcs-server to develop offline -- the
 * client library honours that variable automatically.
 */
export const CHART_BUCKET_ID = "direction-charts"; // logical bucket id kept in stored_objects.bucket

let storage: Storage | undefined;

export function chartBucket(): Bucket {
  const { CHART_BUCKET } = serverConfig();
  if (!CHART_BUCKET) throw new Error("CHART_BUCKET is not configured.");
  storage ??= new Storage();
  return storage.bucket(CHART_BUCKET);
}
