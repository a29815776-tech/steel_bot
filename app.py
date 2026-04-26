from flask import Flask, request, abort, render_template, jsonify, send_file
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (MessageEvent, TextMessage, TextSendMessage,
                             ImageMessage, VideoMessage, ImageSendMessage,
                             QuickReply, QuickReplyButton, MessageAction,
                             FollowEvent)
from groq import Groq
from io import BytesIO
import uuid
import os

import pathlib
BASE_DIR = pathlib.Path(__file__).parent
app = Flask(__name__, template_folder=str(BASE_DIR / "templates"))

LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

line_bot_api = LineBotApi(LINE_CHANNEL_ACCESS_TOKEN)
handler = WebhookHandler(LINE_CHANNEL_SECRET)
groq_client = Groq(api_key=GROQ_API_KEY)

# 對話記憶（生產環境應改用 Redis/DB）
conversations = {}  # {session_id: {"history": [], "state": {...}}}

EXTRACT_PROMPT = """你是一個資料擷取助理。從用戶訊息中擷取以下資訊，用 JSON 格式回覆。

欄位說明：
- service: "天花板" 或 "輕隔間" 或 null（口語對應：隔間/隔牆/隔一間房=輕隔間；天花板/天花/吊頂=天花板）
- material: "石膏板" 或 "矽酸鈣板" 或 null
- ping: 數字（坪數）或 null
- floor: 數字（樓層）或 null

規則：
- 只擷取用戶明確說出的資訊，沒提到的一律填 null
- 不可以推測或假設任何值

只回覆 JSON，不要其他文字。範例：
{"service": "輕隔間", "material": null, "ping": 25, "floor": null}
"""

CHAT_PROMPT = """你是「百工宅修工程行」的親切 AI 報價助理。用自然的繁體中文回覆客人。

目前對話狀態：{state_desc}

請根據狀態，用一句話回覆客人，問缺少的資訊。語氣要自然親切，不要列清單。
如果客人問報價以外的問題，簡短回答後引導回報價。"""

def calculate_price(service, material, ping, floor):
    """計算報價"""
    # 基本單價
    base_prices = {
        ("天花板", "石膏板"): 1350,
        ("天花板", "矽酸鈣板"): 1500,
        ("輕隔間", "石膏板"): 3000,
        ("輕隔間", "矽酸鈣板"): 4000,
    }
    base = base_prices.get((service, material), 0)
    if base == 0:
        return None

    # 樓層加價
    floor_add = 100 if service == "天花板" else 150
    floor_surcharge = floor_add * (floor - 1)
    unit_price = base + floor_surcharge

    # 小坪數加價
    if ping < 10:
        size_rate = 1.20
    elif ping < 20:
        size_rate = 1.15
    elif ping < 30:
        size_rate = 1.10
    else:
        size_rate = 1.00

    total = unit_price * ping * size_rate
    return round(total)


def extract_info(user_message):
    """用 regex 擷取明確提到的資訊，沒提到的回傳 None"""
    import re
    result = {}

    # 服務項目
    if re.search(r'天花板|天花|吊頂', user_message):
        result["service"] = "天花板"
    elif re.search(r'輕隔間|隔間|隔牆|隔一間|隔房', user_message):
        result["service"] = "輕隔間"

    # 材質
    if re.search(r'矽酸鈣|矽酸鈣板', user_message):
        result["material"] = "矽酸鈣板"
    elif re.search(r'石膏板|石膏', user_message):
        result["material"] = "石膏板"

    # 坪數
    m = re.search(r'(\d+(?:\.\d+)?)\s*坪', user_message)
    if m:
        result["ping"] = float(m.group(1))

    # 樓層
    m = re.search(r'(\d+)\s*樓', user_message)
    if m:
        result["floor"] = int(m.group(1))

    return result

def format_quote(service, material, ping, floor):
    price = calculate_price(service, material, ping, floor)
    base_prices = {"天花板": {"石膏板": 1350, "矽酸鈣板": 1500},
                   "輕隔間": {"石膏板": 3000, "矽酸鈣板": 4000}}
    floor_adds = {"天花板": 100, "輕隔間": 150}
    base = base_prices[service][material]
    floor_add = floor_adds[service] * (floor - 1)
    size_pct = 20 if ping < 10 else (15 if ping < 20 else (10 if ping < 30 else 0))

    lines = [
        "📋 報價明細",
        "─────────────",
        f"項目：{service}",
        f"材質：{material}",
        f"坪數：{ping}坪",
        f"樓層：{floor}樓",
        "",
        f"基本單價：{base}元/坪",
    ]
    if floor_add > 0:
        lines.append(f"樓層加價：+{floor_adds[service]}元/坪 × {floor-1} = +{floor_add}元/坪")
    if size_pct > 0:
        lines.append(f"小坪數加價：+{size_pct}%（{ping}坪未滿{'10' if ping<10 else '20' if ping<20 else '30'}坪）")
    lines += [
        "",
        f"💰 預估總價：{price:,} 元",
        "─────────────",
        "以上為預估價，實際費用依現場丈量為準。",
        "如需正式報價，請來電或傳訊息：0973-687-898",
    ]
    return "\n".join(lines)

def ai_reply(session_id, user_message, state_desc):
    """生成自然語言回覆"""
    sess = conversations[session_id]
    sess["history"].append({"role": "user", "content": user_message})
    history = sess["history"][-10:]
    prompt = CHAT_PROMPT.format(state_desc=state_desc)
    resp = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": prompt}] + history,
        temperature=0.6,
        max_tokens=200,
    )
    reply = resp.choices[0].message.content.strip()
    sess["history"].append({"role": "assistant", "content": reply})
    return reply

def chat(session_id, user_message):
    if session_id not in conversations:
        conversations[session_id] = {
            "history": [],
            "state": {"service": None, "material": None, "ping": None, "floor": None}
        }

    state = conversations[session_id]["state"]

    # 擷取本次訊息中的資訊，只更新 null 的欄位
    extracted = extract_info(user_message)
    for key in ["service", "material", "ping", "floor"]:
        if state[key] is None and extracted.get(key) is not None:
            state[key] = extracted[key]

    # 判斷缺少什麼
    missing = [k for k in ["service", "material", "ping", "floor"] if state[key] is None for k in [k]]
    missing = [k for k in ["service", "material", "ping", "floor"] if state[k] is None]

    if not missing:
        # 資訊齊全，直接算價（不經 AI）
        quote = format_quote(state["service"], state["material"], int(state["ping"]), int(state["floor"]))
        conversations[session_id]["history"].append({"role": "user", "content": user_message})
        conversations[session_id]["history"].append({"role": "assistant", "content": quote})
        # 重置 state 讓下次可以問新項目
        conversations[session_id]["state"] = {"service": None, "material": None, "ping": None, "floor": None}
        return quote

    # 還有缺少的資訊，讓 AI 問問題
    labels = {"service": "施工項目（天花板或輕隔間）", "material": "材質（石膏板或矽酸鈣板）",
              "ping": "坪數", "floor": "樓層"}
    known = {k: v for k, v in state.items() if v is not None}
    known_desc = "、".join(f"{labels[k]}={v}" for k, v in known.items()) if known else "尚無"
    missing_desc = "、".join(labels[k] for k in missing)
    state_desc = f"已知：{known_desc}。還需要：{missing_desc}"

    return ai_reply(session_id, user_message, state_desc)


@app.route("/callback", methods=["POST"])
def callback():
    signature = request.headers["X-Line-Signature"]
    body = request.get_data(as_text=True)
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)
    return "OK"


PING_OPTIONS  = ["30坪以上", "30坪內", "20坪內", "10坪內"]
PING_SUB_OPTIONS = {
    "30坪以上": ["30坪","35坪","40坪","45坪","50坪","55坪","60坪","70坪","80坪","90坪"],
    "30坪內":   ["20坪","21坪","22坪","23坪","24坪","25坪","26坪","27坪","28坪","29坪"],
    "20坪內":   ["10坪","11坪","12坪","13坪","14坪","15坪","16坪","17坪","18坪","19坪"],
    "10坪內":   ["1坪", "2坪", "3坪", "4坪", "5坪", "6坪", "7坪", "8坪", "9坪"],
}
FLOOR_OPTIONS = ["一樓施工", "2樓或電梯", "3樓", "4樓", "5樓", "頂加"]
FLOOR_DATA = {"一樓施工":1,"2樓或電梯":2,"3樓":3,"4樓":4,"5樓":5,"頂加":6}
AREA_OPTIONS = ["台北市", "新北市", "基隆", "宜蘭"]

OWNER_LINE_ID = os.environ.get("OWNER_LINE_ID", "")
BASE_URL = os.environ.get("BASE_URL", "https://steel-bot.onrender.com")

image_store = {}  # {img_id: bytes}

line_states = {}    # {user_id: {service, material, ping_range, ping, floor, area}}
customer_contacts = {}  # {user_id: contact_string}

def quick(text, options):
    return TextSendMessage(
        text=text,
        quick_reply=QuickReply(items=[
            QuickReplyButton(action=MessageAction(label=o, text=o)) for o in options
        ])
    )

def line_format_quote(service, material, ping, floor_label, area):
    floor = FLOOR_DATA[floor_label]
    if ping < 10:   rate = 1.20
    elif ping < 20: rate = 1.15
    elif ping < 30: rate = 1.10
    else:           rate = 1.00
    base_prices = {"天花板":{"石膏板":1350,"矽酸鈣板":1500},"輕隔間":{"石膏板":3000,"矽酸鈣板":4000}}
    floor_adds  = {"天花板":100,"輕隔間":150}
    base = base_prices[service][material]
    floor_add = floor_adds[service] * (floor - 1)
    total = round((base + floor_add) * ping * rate)
    lines = ["📋 報價結果", "─────────────",
             f"項目：{service}", f"材質：{material}",
             f"坪數：{int(ping)}坪", f"位置：{floor_label}",
             f"區域：{area}",
             "─────────────",
             f"💰 預估總價：{total:,} 元",
             "─────────────",
             "以上為預估價，實際費用依現場丈量為準。"]
    return "\n".join(lines)

def smart_reply(user_message, state, next_prompt, options):
    """AI 判斷是否需要顯示選單，回傳 (text, show_menu)"""
    labels = {"service":"施工項目","material":"材質","ping_range":"坪數範圍","ping":"坪數","floor":"樓層","area":"區域"}
    known = "、".join(f"{labels[k]}={v}" for k,v in state.items() if v is not None and k in labels)
    has_state = bool(known)
    context = f"客人正在報價流程中，已知：{known}，下一步選擇：{next_prompt}（選項：{'、'.join(options)}）" if has_state else "客人尚未開始報價流程。"
    system = f"""你是百工宅修工程行的 AI 報價助理，專做天花板和輕隔間工程。
{context}

判斷客人訊息，用以下格式回覆：
CHAT: → 直接回答，不顯示選單（適用：問你是誰、問服務範圍、問價格概念、閒聊等）
MENU: → 回答後顯示選單（適用：問候想開始報價、與目前步驟相關、需要繼續流程）

規則：
- 問「你是誰」→ CHAT:介紹自己是百工宅修報價助理
- 問「還有別的服務嗎」→ CHAT:目前提供天花板和輕隔間工程，如需報價請告知
- 說「你好/哈囉」等問候 → MENU:歡迎來到百工宅修！請選擇您要的裝修需求：
- 想重選 → MENU:沒問題，請重新選擇（或輸入「重新」從頭開始）
- 任何簡短、模糊、測試性的訊息（如「這」「好」「請問」「嗯」「呢」「喔」單字或兩字內）→ MENU:請選擇您要的裝修需求：
- 不確定意圖的訊息 → 優先選 MENU:，不要選 CHAT:

純文字不超過60字，只回覆 CHAT: 或 MENU: 開頭。"""
    resp = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role":"system","content":system},{"role":"user","content":user_message}],
        temperature=0.4, max_tokens=120,
    )
    raw = resp.choices[0].message.content.strip()
    if raw.startswith("CHAT:"):
        return raw[5:].strip(), False
    elif raw.startswith("MENU:"):
        return raw[5:].strip(), True
    return raw, True

def notify_owner(msg):
    if OWNER_LINE_ID:
        try:
            line_bot_api.push_message(OWNER_LINE_ID, TextSendMessage(text=msg))
        except Exception:
            pass

@handler.add(FollowEvent)
def handle_follow(event):
    uid = event.source.user_id
    line_states[uid] = {}
    opts = ["天花板", "輕隔間"]
    welcome = "歡迎來到百工宅修！\n請選擇您要的裝修需求：\n\n（急件請點這裡）\nhttps://line.me/ti/p/~0973687898"
    line_bot_api.reply_message(event.reply_token, quick(welcome, opts))

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    uid = event.source.user_id
    msg = event.message.text.strip()

    if msg == "我的id":
        line_bot_api.reply_message(event.reply_token,
            TextSendMessage(text=f"您的 ID：{uid}"))
        return

    if msg in ["重新", "重來", "再估一個", "開始", "報價"]:
        line_states[uid] = {}
    elif line_states.get(uid, {}).get("waiting_name_phone"):
        import re
        if len(re.findall(r'[一-鿿]', msg)) < 1 or len(re.findall(r'\d', msg)) < 10:
            line_bot_api.reply_message(event.reply_token,
                TextSendMessage(text="請輸入您的稱呼及電話，例如：王先生 / 0912-345-678"))
            return
        customer_contacts[uid] = msg
        state = line_states[uid]
        quote = line_format_quote(state["service"], state["material"], state["ping"], state["floor"], state["area"])
        price_str = quote.split("💰")[1].split("元")[0].strip()
        notify_owner(f"🔔 新報價通知\n客戶：{msg}\n項目：{state['service']}／{state['material']}\n坪數：{int(state['ping'])}坪／{state['floor']}\n區域：{state['area']}\n預估：{price_str} 元")
        line_states[uid] = {}
        line_bot_api.reply_message(event.reply_token,
            TextSendMessage(text=quote + "\n\n也可以上傳現場照片或平面圖，讓師傅更了解施工狀況 📷\n\n如需直接聯繫師傅：https://line.me/ti/p/~0973687898\n如需再估一個請輸入「再估一個」"))
        return

    if uid not in line_states:
        line_states[uid] = {}

    state = line_states[uid]

    # 依序填入資訊
    if "service" not in state:
        if msg in ["天花板", "輕隔間"]:
            state["service"] = msg
        else:
            opts = ["天花板", "輕隔間"]
            text, show_menu = smart_reply(msg, state, "施工項目", opts)
            if show_menu:
                full_text = "請選擇您要的裝修需求：\n\n（急件請點這裡）\nhttps://line.me/ti/p/~0973687898"
                line_bot_api.reply_message(event.reply_token, quick(full_text, opts))
            else:
                line_bot_api.reply_message(event.reply_token, TextSendMessage(text=text))
            return

    if "material" not in state:
        if msg in ["石膏板", "矽酸鈣板"]:
            state["material"] = msg
        else:
            opts = ["石膏板", "矽酸鈣板"]
            text, show_menu = smart_reply(msg, state, "材質", opts)
            line_bot_api.reply_message(event.reply_token,
                quick(text, opts) if show_menu else TextSendMessage(text=text))
            return

    if "ping_range" not in state:
        if msg in PING_OPTIONS:
            state["ping_range"] = msg
        else:
            text, show_menu = smart_reply(msg, state, "坪數範圍", PING_OPTIONS)
            line_bot_api.reply_message(event.reply_token,
                quick(text, PING_OPTIONS) if show_menu else TextSendMessage(text=text))
            return

    if "ping" not in state:
        sub_opts = PING_SUB_OPTIONS[state["ping_range"]]
        if msg in sub_opts:
            state["ping"] = float(msg.replace("坪", ""))
        else:
            text, show_menu = smart_reply(msg, state, "精確坪數", sub_opts)
            line_bot_api.reply_message(event.reply_token,
                quick(text, sub_opts) if show_menu else TextSendMessage(text=text))
            return

    if "floor" not in state:
        if msg in FLOOR_OPTIONS:
            state["floor"] = msg
        else:
            text, show_menu = smart_reply(msg, state, "施工位置", FLOOR_OPTIONS)
            line_bot_api.reply_message(event.reply_token,
                quick(text, FLOOR_OPTIONS) if show_menu else TextSendMessage(text=text))
            return

    if "area" not in state:
        if msg in AREA_OPTIONS:
            state["area"] = msg
        else:
            text, show_menu = smart_reply(msg, state, "施工區域", AREA_OPTIONS)
            line_bot_api.reply_message(event.reply_token,
                quick(text, AREA_OPTIONS) if show_menu else TextSendMessage(text=text))
            return

    # 全部齊了，先問稱呼電話再出報價
    line_states[uid]["waiting_name_phone"] = True
    line_bot_api.reply_message(event.reply_token,
        TextSendMessage(text="最後一步！請留下您的稱呼及電話，馬上為您出報價 😊\n（例如：王先生 / 0912-345-678）"))


@app.route("/img/<img_id>")
def serve_image(img_id):
    if img_id in image_store:
        return send_file(BytesIO(image_store[img_id]), mimetype="image/jpeg")
    return "Not found", 404

@handler.add(MessageEvent, message=(ImageMessage, VideoMessage))
def handle_media(event):
    uid = event.source.user_id
    if isinstance(event.message, ImageMessage):
        content = line_bot_api.get_message_content(event.message.id)
        img_bytes = b"".join(chunk for chunk in content.iter_content())
        img_id = str(uuid.uuid4())
        image_store[img_id] = img_bytes
        img_url = f"{BASE_URL}/img/{img_id}"
        if OWNER_LINE_ID:
            try:
                contact = customer_contacts.get(uid)
                note = f"\n聯絡方式：{contact}" if contact else ""
                line_bot_api.push_message(OWNER_LINE_ID, TextSendMessage(text=f"📷 客戶上傳了照片{note}"))
                line_bot_api.push_message(OWNER_LINE_ID, ImageSendMessage(original_content_url=img_url, preview_image_url=img_url))
            except Exception:
                pass
    else:
        notify_owner("🎥 客戶上傳了影片")
    line_bot_api.reply_message(event.reply_token,
        TextSendMessage(text="感謝您上傳照片！老闆收到後會盡快與您聯絡。\n如需來電詢問：0973-687-898"))


@app.route("/")
def index():
    return render_template("demo.html")

@app.route("/demo_chat", methods=["POST"])
def demo_chat():
    data = request.json
    message = data.get("message", "")
    session_id = data.get("session_id", "demo_user")
    reply = chat(session_id, message)
    return jsonify({"reply": reply})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
