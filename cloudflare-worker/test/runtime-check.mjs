import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, createFetchMock } = wranglerRequire("miniflare");
const mock = createFetchMock();
mock.disableNetConnect();
const sends = [];
mock.get("https://api.line.me").intercept({ path: /\/v2\/bot\/message\/(reply|push)/, method: "POST" }).reply(options => {
  sends.push({ path: options.path });
  return { statusCode: 200, data: "{}", responseOptions: { headers: { "content-type": "application/json" } } };
}).persist();

const mf = new Miniflare({
  modules: true, scriptPath: ".wrangler/verified-build/index.js", compatibilityDate: "2026-06-14",
  durableObjects: { BOT_COORDINATOR: { className: "BotCoordinator", useSQLite: true } },
  kvNamespaces: ["STEEL_BOT_KV"], fetchMock: mock,
  bindings: { ADMIN_TOKEN: "mock-admin", LINE_CHANNEL_SECRET: "mock-secret", LINE_CHANNEL_ACCESS_TOKEN: "mock-token" }
});
try {
  const kv = await mf.getKVNamespace("STEEL_BOT_KV");
  const owner = "U" + "1".repeat(32), user = "U" + "2".repeat(32);
  await kv.put("owner:line_ids", JSON.stringify([owner]));
  await kv.put(`state:${user}`, JSON.stringify({ service: "天花板", material: "明架石膏", ping: 12, ping_range: "20坪內", waiting_contact: true }));
  const body = JSON.stringify({ events: [{ type: "message", webhookEventId: "runtime-event", replyToken: "mock-reply", source: { userId: user }, message: { type: "text", id: "runtime-message", text: "測試/0910999888" } }] });
  const response = await mf.dispatchFetch("https://local.invalid/callback", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "mock-secret").update(body).digest("base64") } });
  assert.equal(response.status, 200);
  let recent;
  for (let i = 0; i < 30; i++) {
    recent = await (await mf.dispatchFetch("https://local.invalid/admin/recent", { headers: { authorization: "Bearer mock-admin" } })).json();
    if (recent.leads[0]?.queueStatus === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(recent.leads[0].queueStatus, "complete");
  assert.equal(recent.leads[0].customerConfirmed, true);
  assert.equal(sends.filter(send => send.path.endsWith("/push")).length, 2);
  const duplicate = await mf.dispatchFetch("https://local.invalid/callback", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "mock-secret").update(body).digest("base64") } });
  assert.equal(duplicate.status, 200);
  assert.equal(sends.filter(send => send.path.endsWith("/push")).length, 2);
  async function sendText(id, text) {
    const body = JSON.stringify({ events: [{ type: "message", webhookEventId: id, replyToken: "reply-" + id, source: { userId: user }, message: { type: "text", id, text } }] });
    const response = await mf.dispatchFetch("https://local.invalid/callback", { method: "POST", body, headers: { "x-line-signature": createHmac("sha256", "mock-secret").update(body).digest("base64") } });
    assert.equal(response.status, 200);
  }
  await sendText("runtime-appointment", "預約勘場");
  await sendText("runtime-appointment-again", "預約勘場");
  const beforeAddress = await (await mf.dispatchFetch("https://local.invalid/admin/recent", { headers: { authorization: "Bearer mock-admin" } })).json();
  assert.equal(beforeAddress.count, 1);
  assert.equal(sends.filter(send => send.path.endsWith("/push")).length, 2);
  await sendText("runtime-appointment-address", "台北市大安區和平東路一段12號");
  for (let i = 0; i < 30; i++) {
    recent = await (await mf.dispatchFetch("https://local.invalid/admin/recent", { headers: { authorization: "Bearer mock-admin" } })).json();
    if (recent.leads[0]?.queueStatus === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(recent.count, 2);
  assert.equal(recent.leads[0].address, "台北市大安區和平東路一段12號");
  assert.equal(recent.leads[0].queueStatus, "complete");
  assert.equal(sends.filter(send => send.path.endsWith("/push")).length, 4);
  console.log("Runtime verified: repeated appointment command creates no lead or owner notification; valid address creates one appointment.");
  console.log("Runtime verified: signed webhook, SQLite storage, automatic alarm, owner push, customer confirmation, and duplicate suppression. External network disabled.");
} finally {
  await mf.dispose();
  await mock.close();
}
