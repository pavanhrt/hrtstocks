import { getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { serverConfig } from "../config.ts";

/**
 * Firebase Admin SDK, used only on the server to verify identity. On Cloud Run
 * it authenticates with the runtime service account through Application
 * Default Credentials -- there is no key file anywhere. Locally, setting
 * FIREBASE_AUTH_EMULATOR_HOST points the SDK at the Auth emulator.
 */
function adminApp(): App {
  if (getApps().length > 0) return getApp();
  const { NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId } = serverConfig();
  if (!projectId) throw new Error("NEXT_PUBLIC_FIREBASE_PROJECT_ID is required for authentication.");
  return initializeApp({ projectId });
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}
