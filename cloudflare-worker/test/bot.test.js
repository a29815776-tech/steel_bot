import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { BotCoordinator, quoteTotal, isValidContactInfo } from "../src/index.js";

const OWNER = "U" + "1".repeat(32);
const CUSTOMER = "U" + "2".repeat(32);
const CONTACT = "測試/0910999888";
const QUOTE = { service: "天花板", material: "明架石膏", ping: 12, ping_range: "20坪內", waiting_contact: true };

class Storage {
  constructor() { this.data = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit)); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time) { this.alarm = time; }
}

function setup({ state = QUOTE, handler } = {}) {
  const storage = new Storage();
  const legacy = new Map([["owner:line_ids", JSON.stringify([OWNER])], [`state:${CUSTOMER}`, JSON.stringify(state)]]);
  let legacyWrites = 0;
  const kv = {
    async get(key) { return legacy.get(key) ?? null; },
    async put(key, value) {
      if (!key.startsWith("media:")) throw new Error("429: legacy state must not be written");
      legacyWrites++; legacy.set(key, value);
    },
    async getWithMetadata(key) { return { value: legacy.get(key) ?? null, metadata: null }; }
  };
  const env = { STEEL_BOT_KV: kv, LINE_CHANNEL_SECRET: "test-channel-secret", LINE_CHANNEL_ACCESS_TOKEN: "test-token", ADMIN_TOKEN: "test-private-admin-token" };
  const actor = new BotCoordinator({ storage }, env);
  env.BOT_COORDINATOR = { idFromName: name => name, get: () => ({ fetch: (input, init) => actor.fetch(input instanceof Request ? input : new Request(input, init)) }) };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), ...options, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const response = await handler?.(call);
    if (response) return response;
    if (call.url.includes("api-data.line.me")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    return Response.json({});
  };
  let sequence = 0;
  const f = {
    env, actor, storage, legacy, calls,
    restore() { globalThis.fetch = originalFetch; },
    async send(text, { uid = CUSTOMER, id = `event-${++sequence}`, image = false } = {}) {
      const body = JSON.stringify({ events: [{ type: "message", webhookEventId: id, replyToken: "reply-" + id, source: { userId: uid }, message: image ? { type: "image", id } : { type: "text", id, text } }] });
      const signature = createHmac("sha256", env.LINE_CHANNEL_SECRET).update(body).digest("base64");
      return worker.fetch(new Request("https://local.invalid/callback", { method: "POST", headers: { "x-line-signature": signature }, body }), env, {});
    },
    async flush() { storage.alarm = null; await actor.alarm(); },
    data(key) { return JSON.parse(storage.data.get(key)?.value ?? "null"); },
    async leads() { return Promise.all((f.data("lead:recent") || []).map(lead => f.data(lead.key))); },
    ownerCalls() { return calls.filter(call => call.url.endsWith("/push") && call.body.to === OWNER); },
    customerCalls() { return calls.filter(call => call.url.endsWith("/push") && call.body.to === CUSTOMER); },
    replyCalls() { return calls.filter(call => call.url.endsWith("/reply")); },
    get legacyWrites() { return legacyWrites; }
  };
  return f;
}

test("prices and flexible contact formats", () => {
  for (const [ping, total] of [[4, 6480], [12, 17820], [24, 34020], [30, 40500]]) assert.equal(quoteTotal("天花板", "明架石膏", ping), total);
  for (const value of [CONTACT, "王先生0912345678", "王先生 0912-345-678", "test/0100200300"]) assert.equal(isValidContactInfo(value), true);
  for (const value of ["000", "111", "33333"]) assert.equal(isValidContactInfo(value), false);
});

test("unsigned callback rejected, no secret fails closed, malformed JSON is handled", async () => {
  const f = setup();
  try {
    const request = () => new Request("https://local.invalid/callback", { method: "POST", body: '{"events":[]}' });
    assert.equal((await worker.fetch(request(), f.env)).status, 401);
    assert.equal((await worker.fetch(request(), { ...f.env, LINE_CHANNEL_SECRET: "" })).status, 503);
    const body = "{";
    const signature = createHmac("sha256", f.env.LINE_CHANNEL_SECRET).update(body).digest("base64");
    assert.equal((await worker.fetch(new Request("https://local.invalid/callback", { method: "POST", body, headers: { "x-line-signature": signature } }), f.env)).status, 400);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test("old public admin code denied and mutations require POST", async () => {
  const f = setup();
  try {
    assert.equal((await worker.fetch(new Request("https://local.invalid/admin/recent?code=0973687898"), f.env)).status, 403);
    assert.equal((await worker.fetch(new Request("https://local.invalid/admin/bind-owner", { headers: { authorization: "Bearer " + f.env.ADMIN_TOKEN } }), f.env)).status, 405);
    await f.send("綁定老闆");
    assert.equal(f.replyCalls()[0].body.messages[0].text.includes("0973687898"), false);
    assert.deepEqual(f.data("owner:line_ids"), [OWNER]);
  } finally { f.restore(); }
});

test("quote persisted before acknowledgement, owner push then truthful customer confirmation", async () => {
  const f = setup();
  try {
    assert.equal((await f.send(CONTACT)).status, 200);
    assert.equal(f.ownerCalls().length, 0);
    assert.match(f.replyCalls()[0].body.messages[0].template.text, /正在/);
    await f.flush();
    assert.equal(f.ownerCalls().length, 1);
    assert.match(f.customerCalls()[0].body.messages[0].text, /已將.*轉告老闆/);
    assert.equal((await f.leads())[0].queueStatus, "complete");
    assert.equal(f.legacyWrites, 0);
    assert.equal([...f.storage.data.keys()].filter(key => key.startsWith("pending:")).length, 0);
  } finally { f.restore(); }
});

test("multiple photos retained and all forwarded with new contact", async () => {
  const f = setup({ state: {} });
  try {
    await f.send("", { image: true }); await f.send("", { image: true });
    await f.send(CONTACT); await f.flush();
    assert.equal(f.ownerCalls().filter(call => call.body.messages[0].type === "image").length, 2);
    assert.equal((await f.leads())[0].imageUrls.length, 2);
    assert.equal(f.legacyWrites, 2);
  } finally { f.restore(); }
});

test("restart, change area and decimal area while waiting for contact", async () => {
  for (const [message, expected] of [["重新", "restart"], ["我想改剛才坪數", "range"], ["改成12.5坪", "decimal"]]) {
    const f = setup();
    try {
      await f.send(message); const state = f.data(`state:${CUSTOMER}`);
      if (expected === "restart") assert.deepEqual(state, {});
      if (expected === "range") assert.equal(state.ping, undefined);
      if (expected === "decimal") { assert.equal(state.ping, 12.5); assert.match(f.replyCalls()[0].body.messages[0].text, /12\.5坪/); }
      assert.equal(f.ownerCalls().length, 0);
    } finally { f.restore(); }
  }
});

test("fresh appointment collects contact before address and notifies both parties", async () => {
  const f = setup({ state: {} });
  try {
    await f.send("預約勘場"); assert.equal(f.data(`state:${CUSTOMER}`).waiting_appointment_contact, true);
    await f.send(CONTACT); assert.equal(f.data(`state:${CUSTOMER}`).waiting_address, true);
    await f.send("台北市測試路現場1號"); await f.flush();
    assert.equal((await f.leads())[0].contact, CONTACT);
    assert.equal((await f.leads())[0].address, "台北市測試路現場1號");
    assert.equal(f.ownerCalls().length, 1); assert.equal(f.customerCalls().length, 1);
  } finally { f.restore(); }
});

test("concurrent customers and duplicate events preserve exactly one lead per event", async () => {
  const f = setup();
  try {
    const second = "U" + "3".repeat(32);
    f.legacy.set(`state:${second}`, JSON.stringify(QUOTE));
    const responses = await Promise.all([f.send(CONTACT, { id: "same-event" }), f.send(CONTACT, { id: "second-event", uid: second }), f.send(CONTACT, { id: "same-event" })]);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal((await f.leads()).length, 2);
    await f.flush(); assert.equal(f.ownerCalls().length, 2);
    assert.ok(f.ownerCalls().every(call => /^[a-f0-9-]{36}$/.test(call.headers["X-Line-Retry-Key"])));
  } finally { f.restore(); }
});

test("owner 429 and 500 retry without premature final confirmation", async () => {
  for (const status of [429, 500]) {
    let fail = true;
    const f = setup({ handler: call => fail && call.body?.to === OWNER ? Response.json({ message: "Transient" }, { status }) : null });
    try {
      await f.send(CONTACT); await f.flush();
      let lead = (await f.leads())[0]; assert.equal(lead.queueStatus, "retrying"); assert.equal(f.customerCalls().length, 0);
      assert.ok(f.storage.alarm > Date.now());
      const firstKey = f.ownerCalls()[0].headers["X-Line-Retry-Key"];
      fail = false; lead.nextAttemptAt = 0; f.storage.data.get(lead.key).value = JSON.stringify(lead);
      await f.flush();
      assert.equal((await f.leads())[0].queueStatus, "complete");
      assert.equal(f.ownerCalls()[1].headers["X-Line-Retry-Key"], firstKey);
      assert.equal(f.customerCalls().length, 1);
    } finally { f.restore(); }
  }
});

test("failed photo retries photo only; successful owner text is not resent", async () => {
  let fail = true;
  const f = setup({ state: {}, handler: call => fail && call.body?.messages?.[0]?.type === "image" ? Response.json({ message: "Transient" }, { status: 500 }) : null });
  try {
    await f.send("", { image: true }); await f.send(CONTACT); await f.flush();
    let lead = (await f.leads())[0]; assert.equal(lead.notified, false); assert.equal(lead.queueStatus, "retrying");
    fail = false; lead.nextAttemptAt = 0; f.storage.data.get(lead.key).value = JSON.stringify(lead);
    await f.flush();
    assert.equal(f.ownerCalls().filter(call => call.body.messages[0].type === "text").length, 1);
    assert.equal(f.ownerCalls().filter(call => call.body.messages[0].type === "image").length, 2);
    assert.equal(f.customerCalls().length, 1);
  } finally { f.restore(); }
});

test("LINE accepted retry key 409 is success", async () => {
  const f = setup({ handler: call => call.body?.to === OWNER ? Response.json({ message: "Already accepted" }, { status: 409, headers: { "x-line-accepted-request-id": "accepted-request" } }) : null });
  try { await f.send(CONTACT); await f.flush(); assert.equal((await f.leads())[0].queueStatus, "complete"); }
  finally { f.restore(); }
});

test("permanent failure retained for inspection without endless alarms", async () => {
  const f = setup({ handler: call => call.body?.to === OWNER ? Response.json({ message: "Invalid target" }, { status: 400 }) : null });
  try {
    await f.send(CONTACT); await f.flush();
    const lead = (await f.leads())[0]; assert.equal(lead.queueStatus, "failed");
    assert.equal(f.storage.data.has(`failed:${lead.id}`), true);
    assert.equal(f.customerCalls().length, 0);
  } finally { f.restore(); }
});

test("customer confirmation failure retries without repeating owner notification", async () => {
  let fail = true;
  const f = setup({ handler: call => fail && call.body?.to === CUSTOMER ? Response.json({ message: "Transient" }, { status: 500 }) : null });
  try {
    await f.send(CONTACT); await f.flush();
    let lead = (await f.leads())[0]; assert.equal(lead.notified, true); assert.equal(lead.queueStatus, "retrying");
    fail = false; lead.nextAttemptAt = 0; f.storage.data.get(lead.key).value = JSON.stringify(lead);
    await f.flush(); assert.equal(f.ownerCalls().length, 1); assert.equal((await f.leads())[0].customerConfirmed, true);
  } finally { f.restore(); }
});

test("expired reply token falls back to idempotent customer push", async () => {
  const f = setup({ handler: call => call.url.endsWith("/reply") ? Response.json({ message: "Invalid reply token" }, { status: 400 }) : null });
  try {
    await f.send(CONTACT); assert.equal(f.customerCalls().length, 1);
    assert.ok(f.customerCalls()[0].headers["X-Line-Retry-Key"]);
    await f.flush(); assert.equal((await f.leads())[0].queueStatus, "complete");
  } finally { f.restore(); }
});

test("pending work is not lost when it falls out of the recent 20 leads", async () => {
  const f = setup();
  try {
    for (let i = 0; i < 25; i++) {
      const uid = "U" + i.toString(16).padStart(32, "0");
      f.legacy.set(`state:${uid}`, JSON.stringify(QUOTE));
      assert.equal((await f.send(CONTACT, { uid, id: "backlog-" + i })).status, 200);
    }
    assert.equal((await f.leads()).length, 20);
    for (let i = 0; i < 5; i++) await f.flush();
    assert.equal(f.ownerCalls().length, 25);
    assert.equal([...f.storage.data.keys()].filter(key => key.startsWith("pending:")).length, 0);
  } finally { f.restore(); }
});

test("worker restart preserves persisted queue and successful photo progress", async () => {
  let fail = true;
  const f = setup({ state: {}, handler: call => fail && call.body?.messages?.[0]?.type === "image" ? Response.json({ message: "Transient" }, { status: 500 }) : null });
  try {
    await f.send("", { image: true }); await f.send(CONTACT); await f.flush();
    const lead = (await f.leads())[0]; lead.nextAttemptAt = 0;
    f.storage.data.get(lead.key).value = JSON.stringify(lead);
    fail = false;
    const restarted = new BotCoordinator({ storage: f.storage }, f.env);
    await restarted.alarm();
    assert.equal(f.ownerCalls().filter(call => call.body.messages[0].type === "text").length, 1);
    assert.equal((await f.leads())[0].queueStatus, "complete");
  } finally { f.restore(); }
});

test("storage exception returns failure and redelivery recovers the same lead", async () => {
  const f = setup();
  try {
    const originalPut = f.storage.put.bind(f.storage);
    let fail = true;
    f.storage.put = async (key, value) => {
      if (key === "lead:recent" && fail) { fail = false; throw new Error("Temporary storage error"); }
      return originalPut(key, value);
    };
    assert.equal((await f.send(CONTACT, { id: "retry-storage-event" })).status, 500);
    assert.equal(f.replyCalls().length, 0);
    assert.equal((await f.send(CONTACT, { id: "retry-storage-event" })).status, 200);
    await f.flush();
    assert.equal(f.ownerCalls().length, 1);
    assert.equal((await f.leads()).length, 1);
    assert.equal([...f.storage.data.keys()].filter(key => key.startsWith("lead:") && key !== "lead:recent").length, 1);
  } finally { f.restore(); }
});

test("network errors retain queued notification for retry", async () => {
  const f = setup({ handler: call => { if (call.body?.to === OWNER) throw new Error("Network disconnected"); } });
  try {
    await f.send(CONTACT); await f.flush();
    const lead = (await f.leads())[0]; assert.equal(lead.queueStatus, "retrying");
    assert.equal(lead.notifyStatus, 0); assert.equal(f.customerCalls().length, 0);
  } finally { f.restore(); }
});
