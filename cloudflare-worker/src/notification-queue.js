const RETENTION = 180 * 86400;
const MAX_ATTEMPTS = 8;

export function isRetryable(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export async function retryKey(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class NotificationQueue {
  constructor(env, io) {
    this.env = env;
    this.store = env.STEEL_BOT_KV;
    this.io = io;
  }

  async record(lead) {
    const id = this.env.EVENT_ID ? await retryKey(`lead:${this.env.EVENT_ID}`) : crypto.randomUUID();
    const key = `lead:${id}`;
    const previous = await this.store.get(key);
    if (previous) {
      const lead = JSON.parse(previous);
      await this.index(lead);
      if (!["complete", "failed"].includes(lead.queueStatus)) await this.enqueue(lead);
      return lead;
    }
    const item = {
      ...lead, id, key, createdAt: this.io.time(new Date()), createdMillis: Date.now(),
      notified: false, notifyStatus: "queued", queueStatus: "queued", attempts: 0, nextAttemptAt: Date.now(),
      notifyMessage: "等待通知老闆", delivery: {}
    };
    await this.save(item);
    await this.index(item);
    await this.enqueue(item);
    return item;
  }

  async save(lead) {
    await this.store.put(lead.key, JSON.stringify(lead), { expirationTtl: RETENTION });
  }

  async index(lead) {
    const recent = JSON.parse((await this.store.get("lead:recent")) || "[]");
    if (!recent.some(row => row.id === lead.id)) {
      await this.store.put("lead:recent", JSON.stringify([lead, ...recent].slice(0, 20)), { expirationTtl: RETENTION });
    }
  }

  async enqueue(lead) {
    if (!lead?.key) throw new Error("Notification requires a saved lead");
    await this.store.put(`pending:${lead.id}`, lead.key, { expirationTtl: RETENTION });
    await this.store.wake(lead.nextAttemptAt || Date.now() + 1000);
  }

  async deliver(input) {
    const lead = JSON.parse((await this.store.get(input.key)) || JSON.stringify(input));
    if (lead.queueStatus === "complete") {
      await this.store.delete(`pending:${lead.id}`);
      await this.store.delete(`failed:${lead.id}`);
      return { ok: true, status: 200, message: "通知已完成", lead };
    }
    if (lead.nextAttemptAt > Date.now()) return { ok: false, status: lead.notifyStatus, message: "等待重試", lead };
    // LINE retains retry keys for 24 hours; do not resend an ambiguous old request.
    if (lead.firstAttemptAt && Date.now() - lead.firstAttemptAt >= 23 * 3600000) {
      lead.queueStatus = "failed";
      lead.notifyMessage = "重試期限已過，請管理者確認通知狀態";
      await this.save(lead);
      await this.store.put(`failed:${lead.id}`, lead.key, { expirationTtl: RETENTION });
      await this.store.delete(`pending:${lead.id}`);
      return { ok: false, status: 0, message: lead.notifyMessage, lead };
    }
    lead.firstAttemptAt ||= Date.now();
    lead.owners ||= await this.io.owners();
    lead.delivery ||= {};
    lead.attempts = (lead.attempts || 0) + 1;
    lead.queueStatus = "sending";
    await this.save(lead);
    let result = { ok: true, status: 200, message: "老闆通知已接受" };
    try {
      if (!lead.owners.length) result = { ok: false, status: 0, message: "尚未設定老闆通知帳號" };
      for (const owner of lead.owners) {
        const parts = [{ type: "text", text: this.io.message(lead) }, ...(lead.imageUrls || (lead.imageUrl ? [lead.imageUrl] : [])).map(url => ({ type: "image", originalContentUrl: url, previewImageUrl: url }))];
        for (let i = 0; i < parts.length; i++) {
          const partId = `${owner}:${i}`;
          if (lead.delivery[partId]) continue;
          const key = await retryKey(`${lead.id}:${partId}`);
          result = await this.io.send([parts[i]], key, [owner]);
          if (!result.ok) break;
          lead.delivery[partId] = true;
          await this.save(lead);
        }
        if (!result.ok) break;
      }
      if (result.ok) {
        lead.notified = true;
        if (lead.confirmation && !lead.customerConfirmed) {
          result = await this.io.confirm(lead.userId, [{ type: "text", text: lead.confirmation }], await retryKey(`${lead.id}:customer-confirmation`));
          if (result.ok) {
            lead.customerConfirmed = true;
            await this.io.onConfirmed?.(lead);
          }
        }
      }
    } catch (error) {
      result = { ok: false, status: 0, message: `通知連線失敗：${error?.name || "Error"}` };
    }
    lead.notifyStatus = result.status;
    lead.notifyMessage = result.message;
    lead.notifiedAt = this.io.time(new Date());
    if (result.ok) {
      lead.queueStatus = "complete";
      await this.save(lead);
      await this.store.delete(`pending:${lead.id}`);
      await this.store.delete(`failed:${lead.id}`);
    } else if (isRetryable(result.status) && lead.attempts < MAX_ATTEMPTS) {
      lead.queueStatus = "retrying";
      lead.nextAttemptAt = Date.now() + Math.min(1800000, 20000 * 2 ** (lead.attempts - 1));
      await this.save(lead);
      await this.store.wake(lead.nextAttemptAt);
    } else {
      lead.queueStatus = "failed";
      await this.save(lead);
      await this.store.put(`failed:${lead.id}`, lead.key, { expirationTtl: RETENTION });
      await this.store.delete(`pending:${lead.id}`);
    }
    await this.store.put("notify:last", JSON.stringify({ time: lead.notifiedAt, ...result, lead: undefined }), { expirationTtl: 30 * 86400 });
    return { ...result, lead };
  }

  async flush(limit = 5) {
    // Import known pending legacy records once; unknown historic statuses stay untouched.
    if (!(await this.store.get("queue:migrated"))) {
      const recent = JSON.parse((await this.store.get("lead:recent")) || "[]");
      for (const row of recent) {
        const lead = row.key ? JSON.parse((await this.store.get(row.key)) || JSON.stringify(row)) : row;
        if (lead.key && lead.notified === false && (["queued", "sending", "retrying", 0, "0"].includes(lead.notifyStatus) || isRetryable(Number(lead.notifyStatus)))) {
          await this.enqueue(lead);
        }
      }
      await this.store.put("queue:migrated", "true");
    }
    const pending = { keys: [] };
    let cursor;
    do {
      const batch = await this.store.list({ prefix: "pending:", limit: 100, cursor });
      pending.keys.push(...batch.keys);
      cursor = batch.list_complete ? undefined : batch.cursor;
    } while (cursor);
    const results = [];
    let next = null;
    for (const entry of pending.keys) {
      const key = await this.store.get(entry.name);
      const raw = key ? await this.store.get(key) : null;
      if (!raw) { await this.store.delete(entry.name); continue; }
      const lead = JSON.parse(raw);
      if (!lead.nextAttemptAt || lead.nextAttemptAt <= Date.now()) {
        if (results.length < limit) results.push(await this.deliver(lead));
        else next = Math.min(next ?? Infinity, Date.now() + 1000);
      } else next = Math.min(next ?? Infinity, lead.nextAttemptAt);
    }
    if (next !== null) await this.store.wake(next);
    return { ok: true, checked: pending.keys.length, attempted: results.length, results: results.map(({ lead, ...result }) => ({ id: lead.id, ...result })) };
  }
}
