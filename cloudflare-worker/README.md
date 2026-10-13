# steel_bot Cloudflare Worker

這是百工宅修 LINE 報價 bot 的 Cloudflare Workers 版本。

原本 Render/Flask 版已備份：

1. Git branch：`backup-render-flask-20260614`
2. Git tag：`backup-render-flask-20260614`
3. Zip：`C:\Users\user\Documents\Codex\steel_bot_render_flask_backup_20260614.zip`

## 部署步驟

1. 建立 Cloudflare Workers KV namespace：

```bash
npx wrangler kv namespace create STEEL_BOT_KV
```

2. 把輸出的 `id` 填到 `wrangler.toml` 的 `id`。

3. 設定 secrets：

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put OWNER_LINE_ID
npx wrangler secret put GROQ_API_KEY
```

4. 部署：

```bash
npx wrangler deploy
```

5. 到 LINE Developers，把 Webhook URL 改成：

```text
https://steel-bot-worker.<你的 workers.dev 子網域>.workers.dev/callback
```

## 2026/10/13 通知修正

- `BOT_COORDINATOR` 使用 SQLite Durable Object 保存對話、詢問單、待送工作和事件去重；照片仍保留在原有 KV。
- 舊 KV 資料會在第一次讀取時遷入，不會刪除原資料。未知通知狀態的歷史單不會自動補送。
- 文字、每張照片、客人完成確認分開記錄；暫時錯誤最多重試 8 次，間隔逐步延長。永久失敗保留於 `failed:` 工作清單。
- LINE 推播使用固定 retry key；超過安全重試期限的工作留給管理者確認，避免重複送出。
- 客人先收到「正在轉交」，老闆通知 API 接受後才收到「已轉告老闆」。API 接受不代表手機已讀。
- Webhook 必須設定正確 `LINE_CHANNEL_SECRET`，未通過簽章驗證會拒絕。
- 後台需要獨立 `ADMIN_TOKEN`，放在 `Authorization: Bearer ...` 標頭。舊電話驗證碼 URL 已停用；變更、補送和測試入口只接受 POST。
- 不要將 secret 放進 Git、URL 或公開文件。`OWNER_BIND_CODE` 不是必須；未設定時 LINE 聊天綁定功能關閉，現有老闆仍可接收通知。

```powershell
node --test test/*.test.js
wrangler deploy --dry-run --outdir .wrangler/verified-build
node test/runtime-check.mjs
```

`runtime-check.mjs` 使用 Wrangler 的 Miniflare，禁用外部網路，只模擬 LINE API。

## 回復原本 Render 版

如果 Worker 部署失敗，不要改 LINE webhook，原本 Render 版仍會繼續跑。

如果已經改了 LINE webhook，只要到 LINE Developers 改回：

```text
https://steel-bot.onrender.com/callback
```
