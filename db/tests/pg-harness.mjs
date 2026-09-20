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

/**
 * Waits until no client connection is left on the server. Stopping PostgreSQL (SIGINT, a "fast shutdown", on Linux)
 * while a client socket is still closing makes the backend send "terminating connection due to administrator
 * command"; pg then emits an 'error' on a client nobody listens to and Node reports an uncaught exception. Pools
 * return from end() before their sockets are fully gone, so a stop right after end() races. Draining removes the race.
 */
async function drainConnections(url, timeoutMs = 5000) {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {}); // this client itself must never be the one to blow up during shutdown
  try {
    await c.connect();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await c.query("select count(*)::int n from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()");
      if (rows[0].n === 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  } catch {
    /* the server may already be gone: nothing left to drain */
  } finally {
    await c.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 30)); // let our own socket finish closing before the shutdown signal
  }
}

const START_TIMEOUT_MS = 90_000;
const START_ATTEMPTS = 3;

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);

// The OS-chosen port is released before Postgres binds it, so a parallel test process can take it in between. A failed
// or stalled start must be a retry with a fresh port and directory, never a hang.
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
          await drainConnections(url);
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
