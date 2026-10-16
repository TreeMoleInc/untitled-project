import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { tick, cleanSync, localParts } from "../src/index.js";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const fakeKV = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => void m.set(k, v), raw: m };
};
const ENV = (extra = {}) => ({ STORE: fakeKV(), ALLOWED_ORIGINS: "https://app.example", VAPID_PUBLIC: "x", VAPID_PRIVATE: "y", VAPID_SUBJECT: "https://app.example/", ...extra });

const sub = { endpoint: "https://web.push.apple.com/abc123", keys: { p256dh: "p", auth: "a" } };
const body = (over = {}) => ({
  subscription: sub, tz: "Africa/Johannesburg",
  items: [{ id: "s1", title: "Take vitamins", body: "Health", times: ["09:00", "21:00"] }],
  checkin: { on: true, time: "20:00" }, skip: null, ...over,
});

// 2026-10-16 at HH:MM in Johannesburg (UTC+2) as a timestamp
const at = (hm) => Date.parse(`2026-10-16T${hm}:00+02:00`);

async function sync(env, b, origin = "https://app.example") {
  return worker.fetch(new Request("https://job.example/sync", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(b) }), env);
}
const recorder = () => { const sent = []; return { sent, send: async (rec, message) => { sent.push(message); return new Response(null, { status: 201 }); } }; };

test("local time is computed in the phone's time zone", () => {
  assert.deepEqual(localParts(Date.parse("2026-10-16T22:30:00Z"), "Africa/Johannesburg"), { date: "2026-10-17", hm: "00:30" });
  assert.deepEqual(localParts(Date.parse("2026-10-16T07:00:00Z"), "America/New_York"), { date: "2026-10-16", hm: "03:00" });
});

test("sync is accepted from the app's origin and refused from others", async () => {
  const env = ENV();
  assert.equal((await sync(env, body())).status, 200);
  assert.equal((await sync(env, body(), "https://evil.example")).status, 403);
});

test("rejects bad input: non-push hosts, bad time zone, bad shapes", async () => {
  assert.equal(cleanSync(body({ subscription: { ...sub, endpoint: "https://evil.example/x" } })), null);
  assert.equal(cleanSync(body({ subscription: { ...sub, endpoint: "http://web.push.apple.com/x" } })), null);
  assert.equal(cleanSync(body({ tz: "Not/AZone" })), null);
  assert.equal(cleanSync(null), null);
  const c = cleanSync(body({ items: [{ id: "a", title: "x", times: ["25:99"] }, { id: "b", title: "ok", times: ["07:05"] }] }));
  assert.deepEqual(c.items.map((i) => i.id), ["b"]);
});

test("sends a sub-goal reminder at its time with the habit as secondary text", async () => {
  const env = ENV(); await sync(env, body());
  const r = recorder();
  await tick(env, at("09:00"), r.send);
  assert.deepEqual(r.sent, [{ title: "Take vitamins", body: "Health", tag: "s1" }]);
});

test("check-in reminders say Check in, with no names", async () => {
  const env = ENV(); await sync(env, body());
  const r = recorder();
  await tick(env, at("20:00"), r.send);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].title, "Check in");
  assert.ok(!JSON.stringify(r.sent[0]).includes("vitamins"));
});

test("sends nothing at other times, and nothing twice", async () => {
  const env = ENV(); await sync(env, body());
  const r = recorder();
  await tick(env, at("12:00"), r.send);
  assert.equal(r.sent.length, 0);
  await tick(env, at("09:00"), r.send);
  await tick(env, at("09:00") + 20_000, r.send); // same minute again
  await tick(env, at("09:01"), r.send);          // next minute, still inside the look-back window
  assert.equal(r.sent.length, 1);
});

test("a missed minute is caught up on the next run", async () => {
  const env = ENV(); await sync(env, body());
  const r = recorder();
  await tick(env, at("09:02"), r.send);
  assert.equal(r.sent.length, 1);
});

test("things already done today are skipped, but tomorrow's are not", async () => {
  const env = ENV(); await sync(env, body({ skip: { date: "2026-10-16", ids: ["s1"], allDone: true } }));
  const r = recorder();
  await tick(env, at("09:00"), r.send);
  await tick(env, at("20:00"), r.send);
  assert.equal(r.sent.length, 0);
  await tick(env, at("09:00") + 86_400_000, r.send); // next day: the skip no longer applies
  assert.equal(r.sent.length, 1);
});

test("re-syncing doesn't cause a reminder to be sent again", async () => {
  const env = ENV(); await sync(env, body());
  const r = recorder();
  await tick(env, at("09:00"), r.send);
  await sync(env, body());
  await tick(env, at("09:01"), r.send);
  assert.equal(r.sent.length, 1);
});

test("a phone that has unsubscribed is forgotten", async () => {
  const env = ENV(); await sync(env, body());
  await tick(env, at("09:00"), async () => new Response(null, { status: 410 }));
  assert.deepEqual(await env.STORE.get("subs"), {});
});

test("a temporary failure is retried on the next run", async () => {
  const env = ENV(); await sync(env, body());
  await tick(env, at("09:00"), async () => new Response(null, { status: 503 }));
  const r = recorder();
  await tick(env, at("09:01"), r.send);
  assert.equal(r.sent.length, 1);
});

test("the test button sends a test notification, only to a registered phone", async () => {
  const r = recorder();
  const env = ENV({ sendOverride: r.send }); await sync(env, body());
  const call = (endpoint) => worker.fetch(new Request("https://job.example/test", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) }), env);
  assert.equal((await call(sub.endpoint)).status, 200);
  assert.deepEqual(r.sent, [{ title: "Test", body: "Notifications are working.", tag: "test" }]);
  assert.equal((await call("https://web.push.apple.com/unknown")).status, 404);
});

test("at most 10 devices", async () => {
  const env = ENV();
  for (let i = 0; i < 10; i++) assert.equal((await sync(env, body({ subscription: { ...sub, endpoint: `https://web.push.apple.com/${i}` } }))).status, 200);
  assert.equal((await sync(env, body({ subscription: { ...sub, endpoint: "https://web.push.apple.com/extra" } }))).status, 429);
});

test("the real encryption step accepts our push keys", async () => {
  const keys = JSON.parse(readFileSync(process.env.VAPID_FILE, "utf8"));
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const out = await buildPushPayload(
    { data: JSON.stringify({ title: "t" }), options: { ttl: 3600, urgency: "high" } },
    { endpoint: "https://web.push.apple.com/abc", expirationTime: null, keys: { p256dh: raw, auth } },
    { subject: "https://app.example/", publicKey: keys.publicKey, privateKey: keys.privateKey },
  );
  assert.equal(out.method.toUpperCase(), "POST");
  const authHeader = Object.entries(out.headers).find(([k]) => k.toLowerCase() === "authorization")[1];
  assert.ok(authHeader.startsWith("vapid "));
  assert.ok(out.body.byteLength > 100);
});
