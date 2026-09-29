// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// web_status / web_login json shapes and the account cache, against a fake browser.
// No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebClient, memberIdFromGid, LOGIN_TIMEOUT_MS } from "../src/clients/web-client.js";
import { browserFromProgId } from "../src/utils/default-browser.js";
import { CookieExtractor } from "../src/clients/cookie-extractor.js";

const GID = Buffer.from("gid://api/MembersPreference/6541781").toString("base64");

/** api-router stand-in: counts queries by operation name. */
function fakeBrowser(opts: { loggedIn?: boolean; userFails?: boolean } = {}) {
  const calls: Record<string, number> = {};
  const b = {
    calls,
    closed: 0,
    cleared: 0,
    clearOnLaunch: 0,
    setCookies() {},
    async clearSiteCookies() {
      b.cleared++;
    },
    markClearOnLaunch() {
      b.clearOnLaunch++;
    },
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

const COOKIE = { name: "s", value: "x", domain: ".nexusmods.com", path: "/" };

function client(browser: ReturnType<typeof fakeBrowser>, cookies: unknown[] = [], dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"))) {
  const web = new WebClient({ cookiesPath: path.join(dir, "cookies.json") } as any);
  (web as any).browser = browser;
  (web as any).extractCookies = async () => ({ cookies, browser: "fake" });
  // never touch the real registry / default browser in tests
  (web as any).detectDefaultBrowser = async () => null;
  (web as any).openUrl = async () => {
    throw new Error("openUrl not stubbed");
  };
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
    sessionSource: "manual",
    sessionBrowser: null,
    loginVia: null,
    loginBrowser: null,
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

test("session source: browser extraction, window capture, manual; persisted across restarts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"));
  const web = client(fakeBrowser(), [COOKIE], dir);
  await web.login();
  assert.deepEqual(web.sessionSource(), { sessionSource: "browser", sessionBrowser: "fake" });
  const s = await web.statusJson();
  assert.equal(s.sessionSource, "browser");
  assert.equal(s.sessionBrowser, "fake");
  // restart: read back from the sidecar
  assert.deepEqual(client(fakeBrowser(), [], dir).sessionSource(), { sessionSource: "browser", sessionBrowser: "fake" });

  web.setCookiesFromString("a=1");
  assert.deepEqual(client(fakeBrowser(), [], dir).sessionSource(), { sessionSource: "manual", sessionBrowser: null });

  const w = client(fakeBrowser(), [], dir);
  await (w as any).pollForLogin(10_000);
  assert.deepEqual(w.sessionSource(), { sessionSource: "window", sessionBrowser: null });
});

test("session source: legacy cookies file without sidecar → null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"));
  writeFileSync(path.join(dir, "cookies.json"), JSON.stringify([COOKIE]));
  const web = client(fakeBrowser(), [], dir);
  assert.equal(web.hasCookies(), true);
  assert.deepEqual(web.sessionSource(), { sessionSource: null, sessionBrowser: null });
});

test("init: background extraction counts as browser", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"));
  const web = client(fakeBrowser(), [COOKIE], dir);
  web.init();
  await new Promise((r) => setImmediate(r));
  assert.equal(web.hasCookies(), true);
  assert.deepEqual(web.sessionSource(), { sessionSource: "browser", sessionBrowser: "fake" });
});

test("web_logout: clears everything, stops the sign-in poll, no re-extract at init until login", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-web-"));
  const b = fakeBrowser();
  const web = client(b, [], dir);
  web.setCookiesFromString("a=1");
  await web.statusJson(); // fills the account cache
  (web as any).extractCookies = async () => ({ cookies: [], browser: "fake" });
  await web.login(); // nothing to extract → sign-in window + poll
  assert.equal(web.loginInProgress(), true);

  assert.deepEqual(await web.logout(), { loggedOut: true, cookiesStored: false });
  assert.equal(web.loginInProgress(), false);
  assert.equal(web.hasCookies(), false);
  assert.equal((web as any).account, null);
  assert.equal(existsSync(path.join(dir, "cookies.json")), false);
  assert.equal(b.cleared, 1, "live browser cookies cleared");
  assert.equal(b.closed, 1, "browser/window closed");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "session.json"), "utf-8")).signedOut, true);
  assert.deepEqual(web.sessionSource(), { sessionSource: null, sessionBrowser: null });
  assert.equal(await web.logout().then((r) => r.loggedOut), true, "idempotent");

  await new Promise((r) => setTimeout(r, 3500)); // a poll tick after logout captures nothing
  assert.equal(web.hasCookies(), false);
  assert.equal(b.closed, 2, "only the second logout closed again, not the stale poll");

  // restart: installed browser still has a session, but init must not extract it
  const b2 = fakeBrowser();
  const again = client(b2, [COOKIE], dir);
  let extracted = 0;
  (again as any).extractCookies = async () => (extracted++, { cookies: [COOKIE], browser: "fake" });
  again.init();
  await new Promise((r) => setImmediate(r));
  assert.equal(extracted, 0);
  assert.equal(again.hasCookies(), false);
  assert.equal(b2.clearOnLaunch, 1, "profile cookies wiped on next launch");

  // explicit web_login lifts the marker
  await again.login();
  assert.equal(again.hasCookies(), true);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "session.json"), "utf-8")).signedOut, false);
});
/** Default browser "chrome" whose store is readable; returns the session cookie after `after` polls. */
function withDefaultBrowser(web: WebClient, opts: { readable?: boolean; after?: number } = {}) {
  const st = { opened: [] as string[], polls: 0 };
  (web as any).extractCookies = async () => ({ cookies: [], browser: "none", error: "none" });
  (web as any).detectDefaultBrowser = async () => ({ progId: "ChromeHTML", browser: "chrome" });
  (web as any).openUrl = async (u: string) => void st.opened.push(u);
  (web as any).defaultBrowserPollMs = 10;
  let probed = false;
  (web as any).extractFrom = async (b: string) => {
    if (opts.readable === false) return { browser: b, cookies: [], error: "app-bound encryption" };
    if (!probed) return (probed = true), { browser: b, cookies: [] };
    st.polls++;
    return { browser: b, cookies: st.polls > (opts.after ?? 2) ? [COOKIE] : [] };
  };
  return st;
}

test("browserFromProgId: ProgId map", () => {
  assert.equal(browserFromProgId("ChromeHTML"), "chrome");
  assert.equal(browserFromProgId("MSEdgeHTM"), "edge");
  assert.equal(browserFromProgId("FirefoxURL-308046B0AF4A39CB"), "firefox");
  assert.equal(browserFromProgId("BraveHTML"), "brave");
  assert.equal(browserFromProgId("OperaStable"), "opera");
  assert.equal(browserFromProgId("OperaGXStable"), "opera-gx");
  assert.equal(browserFromProgId("VivaldiHTM.ABC"), "vivaldi");
  assert.equal(browserFromProgId("YandexHTML"), "yandex");
  assert.equal(browserFromProgId("CentHTM.PVOYJF5YAEQRUHCVWLHIFLU56M"), "centbrowser");
  assert.equal(browserFromProgId("IE.HTTPS"), null);
});

test("web_login path 1: silent extraction → loginVia browser-extract, no default browser", async () => {
  const web = client(fakeBrowser(), [COOKIE]);
  let detected = 0;
  (web as any).detectDefaultBrowser = async () => (detected++, null);
  const r = await web.login();
  assert.equal(r.loggedIn, true);
  assert.equal(detected, 0);
  assert.deepEqual(web.loginState(), { loginInProgress: false, loginVia: "browser-extract", loginBrowser: null });
});

test("web_login path 2: default browser readable → opens it, polls, captures as browser/<name>", async () => {
  const b = fakeBrowser();
  const web = client(b);
  const st = withDefaultBrowser(web);
  const r = await web.login();
  assert.deepEqual({ ...r, detail: undefined }, { loggedIn: false, loginWindowOpened: false, detail: undefined });
  assert.equal(st.opened.length, 1);
  assert.match(st.opened[0], /users\.nexusmods\.com\/auth\/sign_in/);
  assert.deepEqual(web.loginState(), { loginInProgress: true, loginVia: "default-browser", loginBrowser: "chrome" });
  const s = await web.statusJson();
  assert.equal(s.loginVia, "default-browser");
  assert.equal(s.loginBrowser, "chrome");
  assert.equal(s.loginInProgress, true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(web.loginInProgress(), false);
  assert.deepEqual(web.sessionSource(), { sessionSource: "browser", sessionBrowser: "chrome" });
  assert.equal(b.closed, 0, "no own window involved");
});

test("web_login path 3: default browser unreadable → own sign-in window", async () => {
  const b = fakeBrowser();
  let openedLogin = 0;
  (b as any).openLoginPage = async () => void openedLogin++;
  const web = client(b);
  const st = withDefaultBrowser(web, { readable: false });
  const r = await web.login();
  assert.equal(r.loginWindowOpened, true);
  assert.equal(openedLogin, 1);
  assert.equal(st.opened.length, 0, "default browser not opened");
  assert.deepEqual(web.loginState(), { loginInProgress: true, loginVia: "window", loginBrowser: null });
  assert.deepEqual(await web.cancelLogin(), { cancelled: true });
});

test("web_login_cancel: stops the own-window poll and closes it; idempotent", async () => {
  const b = fakeBrowser();
  const web = client(b);
  await web.login();
  assert.equal(web.loginInProgress(), true);
  assert.deepEqual(await web.cancelLogin(), { cancelled: true });
  assert.deepEqual(web.loginState(), { loginInProgress: false, loginVia: null, loginBrowser: null });
  assert.equal(b.closed, 1);
  assert.deepEqual(await web.cancelLogin(), { cancelled: false });
  await new Promise((r) => setTimeout(r, 3500)); // stale poll tick captures nothing
  assert.equal(web.hasCookies(), false);
  assert.equal(b.closed, 1);
});

test("web_login_cancel: stops default-browser polling", async () => {
  const b = fakeBrowser();
  const web = client(b);
  const st = withDefaultBrowser(web, { after: 1_000_000 });
  await web.login();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(await web.cancelLogin(), { cancelled: true });
  const polls = st.polls;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(st.polls <= polls + 1, "polling stopped");
  assert.equal(web.hasCookies(), false);
  assert.equal(b.closed, 0, "user's browser page is not ours to close");
});
test("cookie extractor: all-empty values (undecryptable store) → unreadable", () => {
  const ex = new CookieExtractor() as any;
  const rows = (v: string) => [{ name: "a", value: v, domain: ".nexusmods.com", path: "/" }];
  const empty = ex.read({ chrome: () => rows("") }, "chrome");
  assert.match(empty.error, /could not be decrypted/);
  assert.deepEqual(empty.cookies, []);
  const ok = ex.read({ chrome: () => rows("x") }, "chrome");
  assert.equal(ok.error, undefined);
  assert.equal(ok.cookies.length, 1);
  assert.match(ex.read({ chrome: () => { throw new Error("locked\nmore"); } }, "chrome").error, /^locked$/);
  assert.match(ex.read({}, "yandex").error, /no cookie reader/);
});