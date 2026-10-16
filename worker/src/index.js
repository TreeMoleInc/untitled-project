// Sends scheduled push notifications. The app tells this job when reminders are due
// (POST /sync); a once-a-minute timer checks the clock and sends whatever is due.
import { buildPushPayload } from "@block65/webcrypto-web-push";

const STORE_KEY = "subs";
const MAX_SUBS = 10; // personal-use cap, so a stranger can't turn this into a push relay
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- storage ----------
async function loadAll(env) {
  return (await env.STORE.get(STORE_KEY, "json")) || {};
}
const saveAll = (env, all) => env.STORE.put(STORE_KEY, JSON.stringify(all));

async function idFor(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- time ----------
// Local date and HH:MM for a moment in a time zone.
export function localParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hm: `${get("hour")}:${get("minute")}` };
}

// ---------- validation ----------
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return typeof tz === "string"; } catch { return false; }
}

export function cleanSync(body) {
  const sub = body && body.subscription;
  if (!sub || !str(sub.endpoint, 600) || !sub.keys || !str(sub.keys.p256dh, 200) || !str(sub.keys.auth, 100)) return null;
  let url;
  try { url = new URL(sub.endpoint); } catch { return null; }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
  if (!validTz(body.tz)) return null;

  const items = [];
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 100) : []) {
    if (!it || !str(it.id, 40) || !str(it.title, 120)) continue;
    const times = (Array.isArray(it.times) ? it.times : []).filter((t) => HM.test(t)).slice(0, 6);
    if (!times.length) continue;
    items.push({ id: it.id, title: it.title, body: typeof it.body === "string" ? it.body.slice(0, 120) : "", times });
  }

  const c = body.checkin || {};
  const checkin = { on: c.on === true && HM.test(c.time), time: HM.test(c.time) ? c.time : "20:00" };

  const sk = body.skip || {};
  const skip = DATE.test(sk.date)
    ? { date: sk.date, ids: (Array.isArray(sk.ids) ? sk.ids : []).filter((x) => str(x, 40)).slice(0, 100), allDone: sk.allDone === true }
    : null;

  return { sub: { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, tz: body.tz, items, checkin, skip };
}

// ---------- HTTP ----------
function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

async function handleFetch(req, env) {
  const headers = cors(req, env);
  const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/") return reply(200, { ok: true });
  if (req.method !== "POST" || !["/sync", "/unsubscribe", "/test"].includes(path)) return reply(404, { error: "not found" });

  // only the app's own pages may call this from a browser
  if (!headers["Access-Control-Allow-Origin"]) return reply(403, { error: "origin not allowed" });

  const text = await req.text();
  if (text.length > 100_000) return reply(413, { error: "too large" });
  let body;
  try { body = JSON.parse(text); } catch { return reply(400, { error: "bad json" }); }

  if (path === "/test") {
    const ep = body && body.endpoint;
    if (!str(ep, 600)) return reply(400, { error: "bad request" });
    const rec = (await loadAll(env))[await idFor(ep)];
    if (!rec) return reply(404, { error: "not registered" });
    const res = await (env.sendOverride || sendPush)(rec, { title: "Test", body: "Notifications are working.", tag: "test" }, env);
    const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    return reply(res.ok ? 200 : 502, { ok: res.ok, status: res.status, detail });
  }

  if (path === "/unsubscribe") {
    const ep = body && body.endpoint;
    if (!str(ep, 600)) return reply(400, { error: "bad request" });
    const all = await loadAll(env);
    delete all[await idFor(ep)];
    await saveAll(env, all);
    return reply(200, { ok: true });
  }

  const clean = cleanSync(body);
  if (!clean) return reply(400, { error: "bad request" });
  const all = await loadAll(env);
  const id = await idFor(clean.sub.endpoint);
  if (!all[id] && Object.keys(all).length >= MAX_SUBS) return reply(429, { error: "too many devices" });
  all[id] = { ...clean, sent: (all[id] && all[id].sent) || {} }; // keep "already sent" memory across syncs
  await saveAll(env, all);
  return reply(200, { ok: true });
}

// ---------- the once-a-minute check ----------
async function sendPush(rec, message, env) {
  const vapid = { subject: env.VAPID_SUBJECT.trim(), publicKey: env.VAPID_PUBLIC.trim(), privateKey: env.VAPID_PRIVATE.trim() };
  const payload = await buildPushPayload({ data: JSON.stringify(message), options: { ttl: 3600, urgency: "high" } }, rec.sub, vapid);
  return fetch(rec.sub.endpoint, payload);
}

// `send` and `now` can be swapped out in tests.
export async function tick(env, now = Date.now(), send = sendPush) {
  const all = await loadAll(env);
  let changed = false;
  const minute = 60_000;
  const base = Math.floor(now / minute) * minute;

  for (const [id, rec] of Object.entries(all)) {
    const due = [];
    // look back two minutes too, so one late or missed timer run doesn't lose a reminder
    for (const ms of [base - 2 * minute, base - minute, base]) {
      const { date, hm } = localParts(ms, rec.tz);
      const skipToday = rec.skip && rec.skip.date === date ? rec.skip : null;
      for (const it of rec.items) {
        if (!it.times.includes(hm) || (skipToday && skipToday.ids.includes(it.id))) continue;
        due.push({ key: `${date}|${hm}|${it.id}`, message: { title: it.title, body: it.body, tag: `${it.id}` } });
      }
      if (rec.checkin.on && rec.checkin.time === hm && !(skipToday && skipToday.allDone)) {
        due.push({ key: `${date}|${hm}|checkin`, message: { title: "Check in", body: "Open the app to tick things off.", tag: "checkin" } });
      }
    }

    for (const d of due) {
      if (rec.sent[d.key]) continue;
      let res;
      try { res = await send(rec, d.message, env); } catch (e) { console.log("send failed", String(e)); continue; }
      if (res.status === 404 || res.status === 410) { delete all[id]; changed = true; break; } // phone unsubscribed
      if (res.ok) { rec.sent[d.key] = 1; changed = true; } else console.log("push rejected", res.status);
    }

    // forget old "already sent" markers
    if (all[id]) {
      const today = localParts(now, rec.tz).date;
      const yesterday = localParts(now - 86_400_000, rec.tz).date;
      for (const k of Object.keys(rec.sent)) if (k.slice(0, 10) < yesterday && k.slice(0, 10) !== today) { delete rec.sent[k]; changed = true; }
    }
  }
  if (changed) await saveAll(env, all);
}

export default {
  fetch: handleFetch,
  scheduled: (event, env, ctx) => ctx.waitUntil(tick(env)),
};
