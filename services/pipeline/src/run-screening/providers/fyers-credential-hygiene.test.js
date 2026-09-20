import { test } from "node:test";
import assert from "node:assert/strict";
import { FyersAuthError, FyersRequestError, fyersAuthHeader, fyersFetch, NOT_CONFIGURED, readAccessToken } from "./fyers-credentials.js";
import { fetchOHLCVRange } from "./fyers.js";
import { redactDeep, redactSecrets, safeErrorMessage } from "../../security/redact.js";

// Fake credential values, shaped like the real ones (a JWT-looking token) so pattern-based redaction is exercised too.
const APP_ID = "TESTAPP123-100";
// A fake JWT-shaped token, assembled at runtime so no token-looking literal sits in the repository.
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: ["d:1"] })}.${b64("fake-signature-value")}`;
const env = (over = {}) => ({ FYERS_APP_ID: APP_ID, FYERS_ACCESS_TOKEN: TOKEN, ...over });

const realFetch = globalThis.fetch;
const restore = () => {
  globalThis.fetch = realFetch;
};

test("a trailing CR/LF on either credential is trimmed and the header has no control characters", () => {
  for (const over of [{ FYERS_APP_ID: `${APP_ID}\r\n` }, { FYERS_ACCESS_TOKEN: `${TOKEN}\r\n` }, { FYERS_APP_ID: `${APP_ID}\r\n`, FYERS_ACCESS_TOKEN: `${TOKEN}\n` }]) {
    const header = fyersAuthHeader(env(over));
    assert.equal(header, `${APP_ID}:${TOKEN}`);
    assert.doesNotMatch(header, /[\r\n]/);
  }
});

test("leading and trailing whitespace of any kind is trimmed", () => {
  assert.equal(fyersAuthHeader(env({ FYERS_APP_ID: `  \t${APP_ID} `, FYERS_ACCESS_TOKEN: `\r\n  ${TOKEN}\t\r\n` })), `${APP_ID}:${TOKEN}`);
  assert.equal(readAccessToken(env({ FYERS_ACCESS_TOKEN: `${TOKEN}   ` })), TOKEN);
});

test("a credential that is empty after trimming is refused, naming the variable and never a value", () => {
  for (const blank of ["", " ", "\r\n", " \t\r\n ", NOT_CONFIGURED, `${NOT_CONFIGURED}\r\n`]) {
    for (const name of ["FYERS_APP_ID", "FYERS_ACCESS_TOKEN"]) {
      assert.throws(
        () => fyersAuthHeader(env({ [name]: blank })),
        (err) => err instanceof FyersAuthError && err.message.includes(`${name} is not set`) && !err.message.includes(TOKEN) && !err.message.includes(APP_ID),
        `${name}=${JSON.stringify(blank)}`
      );
    }
  }
  assert.throws(() => fyersAuthHeader({}), FyersAuthError);
});

test("a CR/LF or other control character INSIDE a credential is rejected without echoing the value", () => {
  for (const bad of [`${APP_ID}\r\nX-Injected: 1`, `${APP_ID}\nmore`, `AB\rCD`, `AB\u0000CD`, `AB\tCD`]) {
    for (const name of ["FYERS_APP_ID", "FYERS_ACCESS_TOKEN"]) {
      const e = env({ [name]: bad });
      assert.throws(
        () => fyersAuthHeader(e),
        (err) => err instanceof FyersAuthError && /line break or control character/.test(err.message) && err.message.includes(name) && !err.message.includes("Injected") && !err.message.includes(TOKEN) && !err.message.includes(APP_ID),
        `${name}=${JSON.stringify(bad)}`
      );
    }
  }
});

test("fyersFetch sends a clean Authorization header", async () => {
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.headers.Authorization;
    return new Response("{}", { status: 200 });
  };
  try {
    await fyersFetch("https://api-t1.fyers.in/x", {}, env({ FYERS_APP_ID: `${APP_ID}\r\n` }));
    assert.equal(seen, `${APP_ID}:${TOKEN}`);
  } finally {
    restore();
  }
});

test("an upstream client error that ECHOES the header never reaches the caller: no header, no token, no app id, no cause", async () => {
  globalThis.fetch = async (_url, init) => {
    throw Object.assign(new TypeError(`Headers.append: "${init.headers.Authorization}" is an invalid header value.`), { code: "ERR_INVALID_ARG_VALUE", cause: new Error(init.headers.Authorization) });
  };
  try {
    await assert.rejects(
      fyersFetch("https://api-t1.fyers.in/x", {}, env()),
      (err) => {
        const everything = `${err.message}\n${err.stack}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
        assert.ok(err instanceof FyersRequestError);
        assert.equal(err.cause, undefined);
        assert.doesNotMatch(everything, new RegExp(TOKEN.slice(0, 20)));
        assert.doesNotMatch(everything, new RegExp(APP_ID));
        assert.doesNotMatch(everything, /Headers\.append|Authorization|eyJ/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("upstream FYERS failures surfaced by the history provider carry no credential (client error, HTTP error and echoing error body)", async () => {
  process.env.FYERS_APP_ID = `${APP_ID}\r\n`;
  process.env.FYERS_ACCESS_TOKEN = `${TOKEN}\r\n`;
  const from = new Date("2026-09-01T00:00:00Z");
  const to = new Date("2026-09-05T00:00:00Z");
  const leaks = (text) => text.includes(TOKEN) || text.includes(TOKEN.slice(0, 25)) || text.includes(APP_ID);
  try {
    const cases = {
      "client error echoing the header": async (_u, init) => {
        throw new TypeError(`Headers.append: "${init.headers.Authorization}" is an invalid header value.`);
      },
      "HTTP 500": async () => new Response(JSON.stringify({ s: "error", code: 500, message: "provider unavailable" }), { status: 500 }),
      "HTTP 200 with an error body that echoes the credentials": async (_u, init) => new Response(JSON.stringify({ s: "error", code: -300, message: `bad request ${init.headers.Authorization}` }), { status: 400 }),
    };
    for (const [name, impl] of Object.entries(cases)) {
      globalThis.fetch = impl;
      let caught;
      try {
        await fetchOHLCVRange("NSE_AAA", "AAA", from, to, null);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `${name}: expected a failure`);
      // What the pipeline would persist or log is safeErrorMessage(err): it must be clean whatever the source.
      assert.ok(!leaks(safeErrorMessage(caught)), `${name}: persisted message leaked a credential`);
      if (name === "client error echoing the header") assert.ok(!leaks(caught.message), "the raw error is clean too (nothing to redact)");
    }
  } finally {
    restore();
    delete process.env.FYERS_APP_ID;
    delete process.env.FYERS_ACCESS_TOKEN;
  }
});

test("redactSecrets removes header echoes, JWTs, Authorization values, known credential values and APP:TOKEN pairs", () => {
  const e = env();
  const samples = [
    `Headers.append: "${APP_ID}\r\n:${TOKEN}" is an invalid header value.`,
    `Headers.append: "${APP_ID}\r\n:${TOKEN.slice(0, 60)}`, // cut short, never closed
    `request failed with ${TOKEN}`,
    `Authorization: ${APP_ID}:${TOKEN}`,
    `authorization=Bearer ${TOKEN}`,
    `Bearer abcdef0123456789abcdef`,
    `${APP_ID}\r\n:${TOKEN}`,
    `${APP_ID}:${TOKEN}`,
    JSON.stringify({ error: `Headers.append: "${APP_ID}\r\n:${TOKEN}" invalid` }),
  ];
  for (const s of samples) {
    const out = redactSecrets(s, e);
    assert.doesNotMatch(out, /eyJ/, s);
    assert.ok(!out.includes(APP_ID), `app id survived in: ${out}`);
    assert.ok(!out.includes(TOKEN.slice(0, 30)), `token survived in: ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("redaction leaves ordinary pipeline text and data untouched", () => {
  const ordinary = [
    "NSE:M&M-EQ",
    "Fyers history request failed for RELIANCE: 500 {\"s\":\"error\",\"code\":500,\"message\":\"provider unavailable\"}",
    "status=partial universeCount=501 resultCount=501",
    "direction-charts/NSE_RELIANCE/daily/abc123.svg",
    "2026-09-18",
    "Nifty 50 Index",
  ];
  for (const s of ordinary) assert.equal(redactSecrets(s, env()), s);
  const obj = { a: 1, b: ["x", { c: "NSE:TCS-EQ" }], d: null, e: new Date(0) };
  assert.equal(redactDeep(obj, env()), obj, "unchanged values are returned as the same object");
});

test("redactDeep cleans nested JSON and leaves the input unmutated", () => {
  const input = { error: `Headers.append: "${APP_ID}\r\n:${TOKEN}"`, list: [`x ${TOKEN}`], n: 5 };
  const snapshot = JSON.stringify(input);
  const out = redactDeep(input, env());
  assert.equal(JSON.stringify(input), snapshot);
  assert.doesNotMatch(JSON.stringify(out), /eyJ|TESTAPP123/);
  assert.equal(out.n, 5);
});
