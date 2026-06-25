const OWNER_LINE_URL = "https://line.me/ti/p/~0973687898";

const MATERIAL_PRICES = {
  "天花板|明架石膏": 1350,
  "天花板|明架矽酸": 1500,
  "天花板|明架塑膠": 1700,
  "天花板|暗架矽酸": 3000,
  "天花板|暗架廚廁長條塑膠板": 2250,
  "天花板|暗架企口鋁板": 4500,
  "輕隔間|石膏板": 3000,
  "輕隔間|矽酸鈣板": 4000,
  "輕隔間|水泥板": 4500
};

const CEILING_MATERIALS = ["明架石膏", "明架矽酸", "明架塑膠", "暗架矽酸", "暗架廚廁長條塑膠板", "暗架企口鋁板"];
const PARTITION_MATERIALS = ["石膏板", "矽酸鈣板", "水泥板"];
const PING_OPTIONS = ["30坪以上", "30坪內", "20坪內", "10坪內"];
const PING_SUB_OPTIONS = {
  "30坪以上": ["30坪", "35坪", "40坪", "45坪", "50坪", "55坪", "60坪", "70坪", "80坪", "90坪"],
  "30坪內": ["20坪", "21坪", "22坪", "23坪", "24坪", "25坪", "26坪", "27坪", "28坪", "29坪"],
  "20坪內": ["10坪", "11坪", "12坪", "13坪", "14坪", "15坪", "16坪", "17坪", "18坪", "19坪"],
  "10坪內": ["1坪", "2坪", "3坪", "4坪", "5坪", "6坪", "7坪", "8坪", "9坪"]
};

const CONTACT_PROMPT = "請留下您的姓名及電話，方便專人服務與您確認丈量時間 😊\n（例如：王先生 / 0912-345-678）";
const OWNER_COMMANDS = ["查詢單", "查詢詢問單", "詢問單", "查紀錄", "最近紀錄"];
const NOTIFY_STATUS_COMMANDS = ["查通知", "通知狀態"];

const GH = "https://raw.githubusercontent.com/a29815776-tech/steel-bot/main/";
const MATERIAL_IMAGES = {
  "明架石膏": img("明架石膏天花板.jpg"),
  "明架矽酸": img("明架矽酸鈣天花板.jpg"),
  "明架塑膠": img("明架塑膠天花板.jpg"),
  "暗架矽酸": img("暗架天花板.jpg"),
  "暗架廚廁長條塑膠板": img("暗架.jpg"),
  "暗架企口鋁板": img("企口鋁板.jpg"),
  "石膏板": img("輕隔間.jpg"),
  "矽酸鈣板": img("矽酸鈣板輕隔間.jpg"),
  "水泥板": img("輕隔間 (2).jpg")
};

function img(name) {
  return GH + encodeURIComponent(name);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return new Response("ok", { status: 200 });
    }
    if (request.method === "GET" && url.pathname === "/diag/line-token") {
      return checkLineToken(env);
    }
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      return serveMedia(url.pathname.slice("/media/".length), env);
    }
    if (request.method !== "POST" || url.pathname !== "/callback") {
      return new Response("not found", { status: 404 });
    }

    const body = await request.text();
    const payload = JSON.parse(body);
    const signature = request.headers.get("x-line-signature") || "";
    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      return new Response("OK", { status: 200 });
    }
    if (!(await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      console.log(`bad signature: events=${payload.events.length}, bodyLength=${body.length}, signatureLength=${signature.length}`);
    }

    try {
      for (const event of payload.events) {
        await handleEvent(event, env, url.origin, ctx);
      }
    } catch (error) {
      console.log(`event handling error: ${error?.name || "Error"}: ${error?.message || error}`);
      return new Response("event handling error", { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }
};

async function handleEvent(event, env, origin, ctx) {
  if (event.type !== "message" || !event.source?.userId) return;
  const uid = event.source.userId;

  if (event.message?.type === "image" || event.message?.type === "video") {
    if (event.message.type === "image") {
      const media = await storeLineImage(event, env, origin);
      await setState(env, uid, {
        waiting_photo_contact: true,
        mediaId: media?.mediaId || "",
        imageUrl: media?.imageUrl || "",
        imageSaved: Boolean(media?.imageUrl),
        imageReceivedAt: new Date().toISOString()
      });
      await reply(env, event.replyToken, [
        text(`感謝你上傳照片！\n\n${CONTACT_PROMPT}`)
      ]);
    } else {
      await setState(env, uid, {
        waiting_video_contact: true,
        videoReceivedAt: new Date().toISOString()
      });
      await reply(env, event.replyToken, [
        text(`感謝你上傳影片！\n\n${CONTACT_PROMPT}`)
      ]);
    }
    return;
  }

  if (event.message?.type !== "text") return;
  const msg = event.message.text.trim();
  let state = await getState(env, uid);

  if (isOwner(env, uid) && OWNER_COMMANDS.includes(msg)) {
    await reply(env, event.replyToken, [text(await formatRecentLeads(env))]);
    return;
  }

  if (isOwner(env, uid) && NOTIFY_STATUS_COMMANDS.includes(msg)) {
    await reply(env, event.replyToken, [text(await formatLastNotifyStatus(env))]);
    return;
  }

  if (msg === "我的id") {
    await reply(env, event.replyToken, [text(`您的 ID：${uid}`)]);
    return;
  }

  if (["你好", "哈囉", "哈啰", "嗨", "hi", "hello"].includes(msg.toLowerCase())) {
    state = {};
    await setState(env, uid, state);
    await reply(env, event.replyToken, [quick("歡迎來到百工宅修！👋\n請選擇您要的裝修需求：", ["天花板", "輕隔間"])]);
    return;
  }

  if (isStartQuoteIntent(msg)) {
    await startQuote(env, uid, event.replyToken);
    return;
  }

  if (msg === "預約勘場") {
    state = { waiting_address: true, contact: state.contact || "" };
    await setState(env, uid, state);
    await reply(env, event.replyToken, [text("請留下詳細地址，我們將安排專人與您聯繫 😊\n（例如：台北市大安區XX路XX號X樓）")]);
    return;
  }

  if (state.waiting_address) {
    const lead = {
      type: "預約勘場",
      userId: uid,
      contact: state.contact || "",
      address: msg
    };
    await setState(env, uid, { post_quote: true, contact: state.contact || "" });
    await reply(env, event.replyToken, [text("收到！我們會儘快安排專人與您聯繫確認勘場時間 😊")]);
    notifyLeadInBackground(ctx, env, lead);
    return;
  }

  if (state.waiting_contact) {
    const lead = {
      type: "估價詢問",
      userId: uid,
      contact: msg,
      service: state.service,
      material: state.material,
      ping: state.ping,
      total: quoteTotal(state.service, state.material, state.ping)
    };
    await setState(env, uid, { post_quote: true, contact: msg });
    await reply(env, event.replyToken, [
      buttons("收到！已將您的估價需求通知專人，我們會儘快與您聯繫 😊", [
        { type: "message", label: "預約勘場", text: "預約勘場" },
        { type: "uri", label: "專人服務", uri: OWNER_LINE_URL }
      ], ["繼續估價"])
    ]);
    notifyLeadInBackground(ctx, env, lead);
    return;
  }

  if (state.waiting_photo_contact || state.waiting_video_contact) {
    const lead = {
      type: state.waiting_photo_contact ? "照片詢問" : "影片詢問",
      userId: uid,
      contact: msg,
      imageUrl: state.imageUrl || "",
      imageSaved: Boolean(state.imageUrl)
    };
    await setState(env, uid, { post_quote: true, contact: msg });
    await reply(env, event.replyToken, [
      buttons("收到！已將資料通知專人，我們會儘快與您聯繫 😊", [
        { type: "message", label: "預約勘場", text: "預約勘場" },
        { type: "uri", label: "專人服務", uri: OWNER_LINE_URL }
      ], ["繼續估價"])
    ]);
    notifyLeadInBackground(ctx, env, lead);
    return;
  }

  if (state.post_quote) {
    await reply(env, event.replyToken, [
      buttons("需要繼續估價、預約勘場，或由專人服務嗎？", [
        { type: "message", label: "繼續估價", text: "繼續估價" },
        { type: "message", label: "預約勘場", text: "預約勘場" },
        { type: "uri", label: "專人服務", uri: OWNER_LINE_URL }
      ])
    ]);
    return;
  }

  if (!state.service) {
    if (["天花板", "輕隔間"].includes(msg)) {
      state.service = msg;
      await setState(env, uid, state);
      await reply(env, event.replyToken, [
        textWithQuick("請選擇材質：", ["上一步 ↩"]),
        materialCarousel(msg)
      ]);
    } else {
      await reply(env, event.replyToken, [quick("歡迎來到百工宅修！👋\n專業天花板・輕隔間工程\n\n點下方按鈕開始估價：", ["我要估價"])]);
    }
    return;
  }

  if (msg === "上一步 ↩") {
    await goBack(env, uid, event.replyToken, state);
    return;
  }

  if (!state.material) {
    const materialOptions = state.service === "天花板" ? CEILING_MATERIALS : PARTITION_MATERIALS;
    if (materialOptions.includes(msg)) {
      state.material = msg;
      await setState(env, uid, state);
      await reply(env, event.replyToken, [quick("請選擇坪數範圍：", [...PING_OPTIONS, "上一步 ↩"])]);
    } else {
      await reply(env, event.replyToken, [quick("請選擇材質：", [...materialOptions, "上一步 ↩"])]);
    }
    return;
  }

  if (!state.ping_range) {
    if (PING_OPTIONS.includes(msg)) {
      state.ping_range = msg;
      await setState(env, uid, state);
      await reply(env, event.replyToken, [quick("請選擇實際坪數：", [...PING_SUB_OPTIONS[msg], "上一步 ↩"])]);
    } else {
      await reply(env, event.replyToken, [quick("請選擇坪數範圍：", [...PING_OPTIONS, "上一步 ↩"])]);
    }
    return;
  }

  if (!state.ping) {
    const options = PING_SUB_OPTIONS[state.ping_range] || [];
    if (options.includes(msg)) {
      state.ping = Number(msg.replace("坪", ""));
      const quote = formatQuote(state.service, state.material, state.ping);
      await setState(env, uid, { ...state, waiting_contact: true });
      await reply(env, event.replyToken, [
        text(`${quote}\n\n${CONTACT_PROMPT}`)
      ]);
    } else {
      await reply(env, event.replyToken, [quick("請選擇實際坪數：", [...options, "上一步 ↩"])]);
    }
  }
}

async function goBack(env, uid, replyToken, state) {
  if (state.ping_range) {
    delete state.ping_range;
    await setState(env, uid, state);
    await reply(env, replyToken, [quick("請重新選擇坪數範圍：", [...PING_OPTIONS, "上一步 ↩"])]);
  } else if (state.material) {
    delete state.material;
    await setState(env, uid, state);
    await reply(env, replyToken, [materialCarousel(state.service)]);
  } else {
    await setState(env, uid, {});
    await reply(env, replyToken, [quick("請選擇施工項目：", ["天花板", "輕隔間"])]);
  }
}

function formatQuote(service, material, ping) {
  const total = quoteTotal(service, material, ping);
  return [
    "📋 報價結果",
    "─────────────",
    `項目：${service}`,
    `材質：${material}`,
    `坪數：${Math.trunc(ping)}坪`,
    "─────────────",
    `💰 預估總價：${total.toLocaleString("zh-TW")} 元`,
    "─────────────",
    "以上為預估價，實際費用依現場丈量為準。"
  ].join("\n");
}

function quoteTotal(service, material, ping) {
  const base = MATERIAL_PRICES[`${service}|${material}`] || 0;
  const rate = ping < 10 ? 1.2 : ping < 20 ? 1.1 : ping < 30 ? 1.05 : 1;
  return Math.round(base * ping * rate);
}

function materialCarousel(service) {
  const items = service === "天花板" ? CEILING_MATERIALS : PARTITION_MATERIALS;
  return {
    type: "template",
    altText: "請選擇材質",
    template: {
      type: "carousel",
      columns: items.map((mat) => ({
        thumbnailImageUrl: MATERIAL_IMAGES[mat],
        title: mat,
        text: "點選下方按鈕選擇",
        actions: [{ type: "message", label: "選擇此材質", text: mat }]
      }))
    }
  };
}

function text(message) {
  return { type: "text", text: message };
}

function textWithQuick(message, options) {
  return { ...text(message), quickReply: quickReply(options) };
}

function quick(message, options) {
  return { ...text(message), quickReply: quickReply(options) };
}

function buttons(message, actions, quickOptions = []) {
  const msg = {
    type: "template",
    altText: message,
    template: { type: "buttons", text: message, actions }
  };
  if (quickOptions.length) msg.quickReply = quickReply(quickOptions);
  return msg;
}

function quickReply(options) {
  return {
    items: options.map((option) => ({
      type: "action",
      action: { type: "message", label: option, text: option }
    }))
  };
}

async function startQuote(env, uid, replyToken) {
  await setState(env, uid, {});
  await reply(env, replyToken, [
    quick("請選擇您要的裝修需求：\n\n（急件請點這裡）\nhttps://line.me/ti/p/~0973687898", ["天花板", "輕隔間"])
  ]);
}

function isStartQuoteIntent(message) {
  const normalized = String(message || "")
    .trim()
    .replace(/\s+/g, "");
  if (!normalized) return false;

  const exact = new Set([
    "重新",
    "重來",
    "開始",
    "報價",
    "估價",
    "我要估價",
    "我要報價",
    "繼續估價",
    "繼續報價",
    "繼續估價請按這裡",
    "再估一個",
    "再估一次",
    "再報價一次"
  ]);
  if (exact.has(normalized)) return true;

  return /(繼續|重新|重來|再|另|新).*(估價|報價)/.test(normalized)
    || /(估價|報價).*(繼續|重新|重來|再|另|新)/.test(normalized);
}

function isOwner(env, uid) {
  return Boolean(env.OWNER_LINE_ID) && uid === String(env.OWNER_LINE_ID).trim();
}

function notifyLeadInBackground(ctx, env, lead) {
  const task = notifyLead(env, lead).catch((error) => {
    console.log(`lead notify failed: ${error?.name || "Error"}: ${error?.message || error}`);
  });
  if (ctx?.waitUntil) {
    ctx.waitUntil(task);
  }
}

async function notifyLead(env, lead) {
  const savedLead = await recordLead(env, lead);
  if (savedLead.type === "照片詢問" && savedLead.imageUrl) {
    await pushOwnerMessages(env, [
      text(ownerLeadMessage(savedLead)),
      {
        type: "image",
        originalContentUrl: savedLead.imageUrl,
        previewImageUrl: savedLead.imageUrl
      }
    ]);
    return;
  }
  await pushOwner(env, ownerLeadMessage(savedLead));
}

async function recordLead(env, lead) {
  const createdAt = formatTaipeiTime(new Date());
  const item = {
    id: crypto.randomUUID(),
    createdAt,
    ...lead
  };

  await env.STEEL_BOT_KV.put(`lead:${Date.now()}:${item.id}`, JSON.stringify(item), {
    expirationTtl: 60 * 60 * 24 * 180
  });

  let recent = [];
  try {
    recent = JSON.parse((await env.STEEL_BOT_KV.get("lead:recent")) || "[]");
  } catch (_) {
    recent = [];
  }
  recent.unshift(item);
  await env.STEEL_BOT_KV.put("lead:recent", JSON.stringify(recent.slice(0, 20)), {
    expirationTtl: 60 * 60 * 24 * 180
  });

  return item;
}

async function formatRecentLeads(env) {
  let recent = [];
  try {
    recent = JSON.parse((await env.STEEL_BOT_KV.get("lead:recent")) || "[]");
  } catch (_) {
    recent = [];
  }
  if (!recent.length) {
    return "目前還沒有詢問單紀錄。";
  }
  return [
    "最近詢問單",
    "─────────────",
    ...recent.slice(0, 10).map((lead, index) => `${index + 1}. ${lead.createdAt}\n${leadSummary(lead)}`)
  ].join("\n\n");
}

async function formatLastNotifyStatus(env) {
  const raw = await env.STEEL_BOT_KV.get("notify:last");
  if (!raw) return "目前還沒有通知狀態紀錄。";
  let status;
  try {
    status = JSON.parse(raw);
  } catch (_) {
    return "通知狀態紀錄格式異常。";
  }
  return [
    "最近通知狀態",
    "─────────────",
    `結果：${status.ok ? "成功" : "失敗"}`,
    `時間：${status.time || "未知"}`,
    `狀態碼：${status.status || "無"}`,
    `說明：${status.message || "無"}`
  ].join("\n");
}

async function setLastNotifyStatus(env, status) {
  await env.STEEL_BOT_KV.put("notify:last", JSON.stringify({
    time: formatTaipeiTime(new Date()),
    ...status
  }), { expirationTtl: 60 * 60 * 24 * 30 });
}

function ownerLeadMessage(lead) {
  return [
    `🔔 新${lead.type}`,
    "─────────────",
    ...leadSummaryLines(lead),
    "─────────────",
    `時間：${lead.createdAt || formatTaipeiTime(new Date())}`
  ].join("\n");
}

function leadSummary(lead) {
  return leadSummaryLines(lead).join("\n");
}

function leadSummaryLines(lead) {
  const lines = [
    `客戶資料：${lead.contact || "未留"}`,
    `LINE ID：${lead.userId || "未知"}`
  ];
  if (lead.service || lead.material || lead.ping) {
    lines.push(`項目：${lead.service || "未選"}／${lead.material || "未選"}`);
    lines.push(`坪數：${lead.ping || "未選"}坪`);
  }
  if (Number.isFinite(lead.total)) {
    lines.push(`預估：${lead.total.toLocaleString("zh-TW")} 元`);
  }
  if (lead.address) {
    lines.push(`地址：${lead.address}`);
  }
  if (lead.type === "照片詢問") {
    lines.push(lead.imageSaved ? "照片：已附上" : "照片：暫存失敗，請客戶重傳");
  }
  if (lead.type === "影片詢問") {
    lines.push("影片：LINE 影片無法直接轉傳，請聯絡客戶確認");
  }
  return lines;
}

function formatTaipeiTime(date) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

async function reply(env, replyToken, messages) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lineAccessToken(env)}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!response.ok) {
    console.log(`LINE reply failed: ${response.status} ${await response.text()}`);
  }
}

async function pushOwner(env, message) {
  return pushOwnerMessages(env, [text(message)]);
}

async function pushOwnerMessages(env, messages) {
  const ownerLineId = String(env.OWNER_LINE_ID || "").trim();
  if (!ownerLineId) {
    await setLastNotifyStatus(env, {
      ok: false,
      status: 0,
      message: "OWNER_LINE_ID 未設定"
    });
    console.log("LINE push skipped: missing OWNER_LINE_ID");
    return false;
  }
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lineAccessToken(env)}`
    },
    body: JSON.stringify({ to: ownerLineId, messages })
  });
  if (!response.ok) {
    const body = await response.text();
    await setLastNotifyStatus(env, {
      ok: false,
      status: response.status,
      message: body.slice(0, 300)
    });
    console.log(`LINE push failed: ${response.status} ${body}`);
    return false;
  }
  await setLastNotifyStatus(env, {
    ok: true,
    status: response.status,
    message: "已推播到 OWNER_LINE_ID"
  });
  return true;
}

async function checkLineToken(env) {
  const rawToken = String(env.LINE_CHANNEL_ACCESS_TOKEN || "");
  const token = lineAccessToken(env);
  const response = await fetch("https://api.line.me/v2/bot/info", {
    headers: { authorization: `Bearer ${token}` }
  });
  return Response.json({
    ok: response.ok,
    status: response.status,
    tokenPresent: token.length > 0,
    rawLength: rawToken.length,
    normalizedLength: token.length,
    hasWhitespace: /\s/.test(rawToken),
    startsWithBearer: /^Bearer\s+/i.test(rawToken)
  }, { status: response.ok ? 200 : 500 });
}

async function storeLineImage(event, env, origin) {
  const mediaId = crypto.randomUUID();
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
    headers: { authorization: `Bearer ${lineAccessToken(env)}` }
  });
  if (!response.ok) {
    console.log(`LINE image fetch failed: ${response.status} ${await response.text()}`);
    return null;
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  const bytes = await response.arrayBuffer();
  await env.STEEL_BOT_KV.put(`media:${mediaId}`, bytes, {
    expirationTtl: 60 * 60 * 24 * 7,
    metadata: { contentType }
  });

  const imageUrl = `${origin}/media/${mediaId}`;
  return { mediaId, imageUrl };
}

async function serveMedia(mediaId, env) {
  const result = await env.STEEL_BOT_KV.getWithMetadata(`media:${mediaId}`, "arrayBuffer");
  if (!result.value) return new Response("not found", { status: 404 });
  return new Response(result.value, {
    headers: {
      "content-type": result.metadata?.contentType || "image/jpeg",
      "cache-control": "public, max-age=604800"
    }
  });
}

function lineAccessToken(env) {
  return String(env.LINE_CHANNEL_ACCESS_TOKEN || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/\s+/g, "");
}

async function getState(env, uid) {
  const raw = await env.STEEL_BOT_KV.get(`state:${uid}`);
  return raw ? JSON.parse(raw) : {};
}

async function setState(env, uid, state) {
  await env.STEEL_BOT_KV.put(`state:${uid}`, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 30 });
}

async function verifyLineSignature(body, signature, secret) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return timingSafeEqual(base64(digest), signature);
}

function base64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
