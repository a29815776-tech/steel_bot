from flask import Flask, request, abort, render_template, jsonify
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (MessageEvent, TextMessage, TextSendMessage,
                             QuickReply, QuickReplyButton, MessageAction)
from groq import Groq
import os
import json

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
FLOOR_OPTIONS = ["一樓施工", "2樓或電梯", "3樓", "4樓", "5樓", "頂加"]
PING_DATA  = {"30坪以上":(35,1.00),"30坪內":(25,1.10),"20坪內":(15,1.15),"10坪內":(7,1.20)}
FLOOR_DATA = {"一樓施工":1,"2樓或電梯":2,"3樓":3,"4樓":4,"5樓":5,"頂加":6}

line_states = {}  # {user_id: {service, material, ping_label, floor_label}}

def quick(text, options):
    return TextSendMessage(
        text=text,
        quick_reply=QuickReply(items=[
            QuickReplyButton(action=MessageAction(label=o, text=o)) for o in options
        ])
    )

def line_format_quote(service, material, ping_label, floor_label):
    _, rate = PING_DATA[ping_label]
    floor = FLOOR_DATA[floor_label]
    base_prices = {"天花板":{"石膏板":1350,"矽酸鈣板":1500},"輕隔間":{"石膏板":3000,"矽酸鈣板":4000}}
    floor_adds  = {"天花板":100,"輕隔間":150}
    base = base_prices[service][material]
    floor_add = floor_adds[service] * (floor - 1)
    unit = round((base + floor_add) * rate)
    lines = ["📋 報價明細", "─────────────",
             f"項目：{service}", f"材質：{material}",
             f"坪數：{ping_label}", f"位置：{floor_label}", ""]
    lines.append(f"基本單價：{base:,}元/坪")
    if floor_add: lines.append(f"樓層加價：+{floor_add}元/坪")
    if rate > 1:  lines.append(f"小坪數加價：+{round((rate-1)*100)}%")
    lines += ["", f"💰 施工單價：{unit:,} 元/坪",
              f"   （總價 = {unit:,} × 實際坪數）",
              "─────────────",
              "以上為預估價，實際費用依現場丈量為準。",
              "如需正式報價，請來電：0973-687-898"]
    return "\n".join(lines)

@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    uid = event.source.user_id
    msg = event.message.text.strip()

    if msg in ["重新", "重來", "再估一個", "開始", "報價"]:
        line_states[uid] = {}

    if uid not in line_states:
        line_states[uid] = {}

    state = line_states[uid]

    # 依序填入資訊
    if "service" not in state:
        if msg in ["天花板", "輕隔間"]:
            state["service"] = msg
        else:
            line_bot_api.reply_message(event.reply_token,
                quick("您好！請選擇施工項目：", ["天花板", "輕隔間"]))
            return

    if "material" not in state:
        if msg in ["石膏板", "矽酸鈣板"]:
            state["material"] = msg
        else:
            line_bot_api.reply_message(event.reply_token,
                quick("請選擇材質：", ["石膏板", "矽酸鈣板"]))
            return

    if "ping" not in state:
        if msg in PING_OPTIONS:
            state["ping"] = msg
        else:
            line_bot_api.reply_message(event.reply_token,
                quick("請選擇施工坪數：", PING_OPTIONS))
            return

    if "floor" not in state:
        if msg in FLOOR_OPTIONS:
            state["floor"] = msg
        else:
            line_bot_api.reply_message(event.reply_token,
                quick("請選擇施工位置：", FLOOR_OPTIONS))
            return

    # 全部齊了，出報價
    quote = line_format_quote(state["service"], state["material"], state["ping"], state["floor"])
    line_states[uid] = {}
    line_bot_api.reply_message(event.reply_token,
        TextSendMessage(text=quote + "\n\n如需再估一個請輸入「再估一個」"))


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
