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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
      return new Response("ok", { status: 200 });
    }
    if (request.method !== "POST" || url.pathname !== "/callback") {
      return new Response("not found", { status: 404 });
    }

    const body = await request.text();
    const signature = request.headers.get("x-line-signature") || "";
    if (!(await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("bad signature", { status: 400 });
    }

    const payload = JSON.parse(body);
    for (const event of payload.events || []) {
      await handleEvent(event, env);
    }
    return new Response("OK", { status: 200 });
  }
};

async function handleEvent(event, env) {
  if (event.type !== "message" || !event.source?.userId) return;
  const uid = event.source.userId;

  if (event.message?.type === "image" || event.message?.type === "video") {
    await pushOwner(env, `📷 客戶上傳了${event.message.type === "image" ? "照片" : "影片"}\nLINE ID：${uid}`);
    await reply(env, event.replyToken, [
      text("感謝你上傳照片！專人服務會儘快與你聯繫 😊\n更多問題請直接來電：0973-687-898")
    ]);
    return;
  }

  if (event.message?.type !== "text") return;
  const msg = event.message.text.trim();
  let state = await getState(env, uid);

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

  if (["重新", "重來", "再估一個", "繼續估價請按這裡", "開始", "報價", "我要估價"].includes(msg)) {
    state = {};
    await setState(env, uid, state);
    await reply(env, event.replyToken, [quick("請選擇您要的裝修需求：\n\n（急件請點這裡）\nhttps://line.me/ti/p/~0973687898", ["天花板", "輕隔間"])]);
    return;
  }

  if (msg === "預約勘場") {
    state = { waiting_address: true };
    await setState(env, uid, state);
    await reply(env, event.replyToken, [text("請留下詳細地址，我們將安排專人與您聯繫 😊\n（例如：台北市大安區XX路XX號X樓）")]);
    return;
  }

  if (state.waiting_address) {
    await pushOwner(env, `📍 客戶預約勘場\nLINE ID：${uid}\n地址：${msg}`);
    await setState(env, uid, { post_quote: true });
    await reply(env, event.replyToken, [text("收到！我們會儘快安排專人與您聯繫確認勘場時間 😊")]);
    return;
  }

  if (state.post_quote) {
    await reply(env, event.replyToken, [buttons("有其他問題嗎？點下方按鈕由專人為您服務 😊", [
      { type: "uri", label: "專人服務", uri: OWNER_LINE_URL }
    ])]);
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
      await setState(env, uid, { post_quote: true });
      await reply(env, event.replyToken, [
        text(`${quote}\n\n想獲得更準確價格，可上傳現場照片或預約勘場。`),
        buttons("需要後續協助嗎？", [
          { type: "message", label: "預約勘場", text: "預約勘場" },
          { type: "uri", label: "專人服務", uri: OWNER_LINE_URL }
        ], ["繼續估價請按這裡"])
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
  const base = MATERIAL_PRICES[`${service}|${material}`] || 0;
  const rate = ping < 10 ? 1.2 : ping < 20 ? 1.1 : ping < 30 ? 1.05 : 1;
  const total = Math.round(base * ping * rate);
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

async function reply(env, replyToken, messages) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
}

async function pushOwner(env, message) {
  if (!env.OWNER_LINE_ID) return;
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to: env.OWNER_LINE_ID, messages: [text(message)] })
  });
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
