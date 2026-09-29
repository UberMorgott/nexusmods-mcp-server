// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// web_status / web_login json shapes and the account cache, against a fake browser.
// No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebClient, memberIdFromGid, LOGIN_TIMEOUT_MS } from "../src/clients/web-client.js";

const GID = Buffer.from("gid://api/MembersPreference/6541781").toString("base64");

/** api-router stand-in: counts queries by operation name. */
function fakeBrowser(opts: { loggedIn?: boolean; userFails?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const b = {
    calls,
    closed: 0,
    setCookies() {},
    async fetch(_url: string, init: { body?: string } = {}) {
      const { operationName, query } = JSON.parse(init.body || "{}");
      calls[operationName] = (calls[operationName] || 0) + 1;
      const unauth = { errors: [{ message: "UNAUTHORIZED", extensions: { code: "UNAUTHORIZED" } }] };
      let json: unknown;
      if (opts.loggedIn === false) json = unauth;
      else if (operationName === "Preferences")
        json = { data: { preferences: query.includes("{ id }") ? { id: GID } : { __typename: "Preference" } } };
      else if (operationName === "UserName")
        json = opts.userFails ? { errors: [{ message: "boom" }] } : { data: { user: { memberId: 6541781, name: "UberMorgott" } } };
      return { status: 200, url: "", contentType: "application/json", body: JSON.stringify(json) };
    },
    async openLoginPage() {},
    async getCookies() {
      return [{ name: "s", value: "x", domain: ".nexusmods.com", path: "/" }];
    },
    async close() {
      b.closed++;
    },
  };
  return b;
}

function client(browser: ReturnType<typeof fakeBrowser>, cookies: unknown[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"));
  const web = new WebClient({ cookiesPath: path.join(dir, "cookies.json") } as any);
  (web as any).browser = browser;
  (web as any).extractCookies = async () => ({ cookies, browser: "fake" });
  return web;
}

test("memberIdFromGid: base64 and plain gid, junk → null", () => {
  assert.equal(memberIdFromGid(GID), 6541781);
  assert.equal(memberIdFromGid("gid://api/MembersPreference/42"), 42);
  assert.equal(memberIdFromGid("abc"), null);
  assert.equal(memberIdFromGid(null), null);
});

test("web_status json: account when logged in, cached until cookies change", async () => {
  const b = fakeBrowser();
  const web = client(b);
  web.setCookiesFromString("a=1");
  const s = await web.statusJson();
  assert.deepEqual(s, {
    loggedIn: true,
    loginInProgress: false,
    cookiesStored: true,
    detail: "session valid",
    account: { memberId: 6541781, name: "UberMorgott" },
  });
  await web.statusJson();
  assert.equal(b.calls.UserName, 1, "identity cached");
  web.setCookiesFromString("a=2");
  await web.statusJson();
  assert.equal(b.calls.UserName, 2, "cookie change clears the cache");
});

test("web_status json: not logged in → account null, no lookup", async () => {
  const b = fakeBrowser({ loggedIn: false });
  const s = await client(b).statusJson();
  assert.equal(s.loggedIn, false);
  assert.equal(s.account, null);
  assert.equal("accountError" in s, false);
  assert.equal(b.calls.UserName, undefined);
});

test("web_status json: identity failure → account null + accountError, loggedIn kept", async () => {
  const s = await client(fakeBrowser({ userFails: true })).statusJson();
  assert.equal(s.loggedIn, true);
  assert.equal(s.account, null);
  assert.match(String(s.accountError), /boom/);
});

test("web_login json: silent extraction logs in without a window", async () => {
  const b = fakeBrowser();
  const r = await client(b, [{ name: "s", value: "x", domain: ".nexusmods.com", path: "/" }]).login();
  assert.equal(r.loggedIn, true);
  assert.equal(r.loginWindowOpened, false);
  assert.match(r.detail, /logged in/);
});

test("web_login json: opens the window, polls, closes it after capture", async () => {
  assert.equal(LOGIN_TIMEOUT_MS, 600_000);
  const b = fakeBrowser();
  const web = client(b);
  const r = await web.login();
  assert.deepEqual({ ...r, detail: undefined }, { loggedIn: false, loginWindowOpened: true, detail: undefined });
  assert.equal(web.loginInProgress(), true);
  const again = await web.login();
  assert.equal(again.loginWindowOpened, false, "second call reuses the open window");
  await new Promise((r) => setTimeout(r, 3500)); // one poll tick
  assert.equal(web.loginInProgress(), false);
  assert.equal(b.closed, 1, "window closed after capture");
  assert.equal(web.hasCookies(), true);
});
