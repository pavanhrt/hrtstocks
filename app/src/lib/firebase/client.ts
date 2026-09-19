"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

// Public web configuration -- identifiers, not secrets. Injected at build time
// (NEXT_PUBLIC_*), never hard-coded, so each environment uses its own project.
let emulatorConnected = false;

export function clientAuth(): Auth {
  const app = getApps().length
    ? getApp()
    : initializeApp({
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });
  const auth = getAuth(app);
  const emulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL;
  if (emulator && !emulatorConnected) {
    connectAuthEmulator(auth, emulator, { disableWarnings: true });
    emulatorConnected = true;
  }
  return auth;
}
