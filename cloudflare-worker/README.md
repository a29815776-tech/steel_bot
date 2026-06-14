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

## 回復原本 Render 版

如果 Worker 部署失敗，不要改 LINE webhook，原本 Render 版仍會繼續跑。

如果已經改了 LINE webhook，只要到 LINE Developers 改回：

```text
https://steel-bot.onrender.com/callback
```
