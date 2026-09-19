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

export async function startTestPostgres() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrt-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // Cloud SQL and Supabase are UTF-8; the Windows default (WIN1252) would hide/produce encoding bugs.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
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
}
