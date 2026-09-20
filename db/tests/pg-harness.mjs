// Starts a throwaway real PostgreSQL (npm `embedded-postgres`, dev-only) so
// migration and repository tests need neither Docker nor a cloud database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const START_TIMEOUT_MS = 90_000;
const START_ATTEMPTS = 3;

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);

// The OS-chosen port is released before Postgres binds it, so a parallel test process can take it in between (and
// Windows adds shared-memory contention). A lost race must be a retry with a fresh port and directory, never a hang.
async function startOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrt-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // Cloud SQL is UTF-8; the Windows default (WIN1252) would hide/produce encoding bugs.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await withTimeout(server.initialise(), START_TIMEOUT_MS, "initdb");
    await withTimeout(server.start(), START_TIMEOUT_MS, "postgres start");
  } catch (err) {
    await server.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { server, dir, port };
}

export async function startTestPostgres() {
  let last;
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++) {
    try {
      const { server, dir, port } = await startOnce();
      const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
      return {
        url,
        async newClient() {
          const c = new pg.Client({ connectionString: url });
          await c.connect();
          return c;
        },
        async stop() {
          await server.stop();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`embedded PostgreSQL failed to start after ${START_ATTEMPTS} attempts: ${last?.message}`);
}
