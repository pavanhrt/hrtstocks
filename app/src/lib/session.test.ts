import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSessionUser } from "./session.ts";

const user = { id: "p1", email: "a@b.co", role: "researcher" as const };
const finder = async (uid: string) => (uid === "good-uid" ? user : null);

test("no cookie -> not authenticated", async () => {
  assert.equal(await resolveSessionUser(undefined, { verify: async () => ({ uid: "good-uid" }), find: finder }), null);
  assert.equal(await resolveSessionUser("", { verify: async () => ({ uid: "good-uid" }), find: finder }), null);
});

test("a forged / tampered / expired / revoked / wrong-project cookie never yields a user", async () => {
  for (const reason of ["invalid signature", "session cookie expired", "session cookie revoked", "wrong audience"]) {
    const verify = async () => {
      throw Object.assign(new Error(reason), { code: "auth/argument-error" });
    };
    assert.equal(await resolveSessionUser("forged.token.value", { verify, find: finder }), null, reason);
  }
});

test("a verified cookie is only as good as our database: unknown or unlinked identity -> null", async () => {
  assert.equal(await resolveSessionUser("valid", { verify: async () => ({ uid: "someone-else" }), find: finder }), null);
  assert.equal(await resolveSessionUser("valid", { verify: async () => ({ uid: "" }), find: finder }), null);
});

test("a valid cookie for an invited person yields the role stored in OUR database", async () => {
  assert.deepEqual(await resolveSessionUser("valid", { verify: async () => ({ uid: "good-uid" }), find: finder }), user);
});

test("cookie contents are never trusted: only the verified uid is used, a role smuggled into the claim is ignored", async () => {
  const verify = async () => ({ uid: "good-uid", role: "system_admin" } as { uid: string });
  assert.equal((await resolveSessionUser("valid", { verify, find: finder }))?.role, "researcher");
});
