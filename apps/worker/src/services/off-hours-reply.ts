import { LineClient } from '@line-crm/line-sdk';
import { jstNow } from '@line-crm/db';

/**
 * 時間外自動返信
 *
 * 条件（すべて満たした場合のみ送信）:
 *   1. チャットが未読（unread）のまま = 担当者が未対応
 *   2. 最新の受信メッセージが営業時間外に届いている
 *   3. 受信から OFF_HOURS_REPLY_DELAY_MINUTES（既定60分）以上経過
 *   4. 受信後に手動返信・キーワード自動返信が出ていない
 *   5. 現在も営業時間外（営業開始後は担当者対応に任せる）
 *   6. 同じ友だちへの時間外自動返信から12時間以上空いている（連投防止）
 *
 * 返信トークンは1分で失効するため pushMessage を使う（送信数カウント対象）。
 */

const DEFAULT_MESSAGE =
  'メッセージありがとうございます。\n' +
  'ただいま営業時間外のため、翌営業日に担当者よりご連絡いたします。\n' +
  'お急ぎの場合はお電話にてお問い合わせください。';

const REPLY_COOLDOWN_MS = 12 * 60 * 60_000;

export interface OffHoursConfig {
  enabled: boolean;
  startHour: number; // 営業開始（JST, 含む）
  endHour: number; // 営業終了（JST, 含まない）
  closedDays: number[]; // 定休日 0=日 ... 6=土
  delayMinutes: number;
  message: string;
}

export interface OffHoursEnv {
  OFF_HOURS_REPLY_ENABLED?: string;
  BUSINESS_HOURS?: string; // 例 "9-18"
  BUSINESS_CLOSED_DAYS?: string; // 例 "0" or "0,3"
  OFF_HOURS_REPLY_DELAY_MINUTES?: string;
  OFF_HOURS_REPLY_MESSAGE?: string;
}

export function loadOffHoursConfig(env: OffHoursEnv): OffHoursConfig {
  const [s, e] = (env.BUSINESS_HOURS ?? '9-18').split('-').map((v) => parseInt(v, 10));
  const closedDays = (env.BUSINESS_CLOSED_DAYS ?? '')
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => v >= 0 && v <= 6);
  const delay = parseInt(env.OFF_HOURS_REPLY_DELAY_MINUTES ?? '60', 10);
  return {
    enabled: env.OFF_HOURS_REPLY_ENABLED !== 'false',
    startHour: Number.isFinite(s) ? s : 9,
    endHour: Number.isFinite(e) ? e : 18,
    closedDays,
    delayMinutes: Number.isFinite(delay) && delay > 0 ? delay : 60,
    message: env.OFF_HOURS_REPLY_MESSAGE?.replace(/\\n/g, '\n') || DEFAULT_MESSAGE,
  };
}

/** epoch ms → 営業時間外か（JST基準） */
export function isOffHours(epochMs: number, cfg: OffHoursConfig): boolean {
  const jst = new Date(epochMs + 9 * 60 * 60_000);
  const hour = jst.getUTCHours();
  const day = jst.getUTCDay();
  if (cfg.closedDays.includes(day)) return true;
  return hour < cfg.startHour || hour >= cfg.endHour;
}

export async function processOffHoursReplies(
  db: D1Database,
  defaultAccessToken: string,
  env: OffHoursEnv,
): Promise<void> {
  const cfg = loadOffHoursConfig(env);
  if (!cfg.enabled) return;

  const nowMs = Date.now();
  if (!isOffHours(nowMs, cfg)) return;

  const rows = await db
    .prepare(
      `SELECT c.id AS chat_id, f.id AS friend_id, f.line_user_id, f.metadata,
              la.channel_access_token,
              (SELECT MAX(created_at) FROM messages_log m
                 WHERE m.friend_id = f.id AND m.direction = 'incoming') AS last_in,
              (SELECT MAX(created_at) FROM messages_log m
                 WHERE m.friend_id = f.id AND m.direction = 'outgoing'
                   AND m.broadcast_id IS NULL AND m.scenario_step_id IS NULL) AS last_out
         FROM chats c
         JOIN friends f ON f.id = c.friend_id
         LEFT JOIN line_accounts la ON la.id = f.line_account_id AND la.is_active = 1
        WHERE c.status = 'unread' AND f.is_following = 1`,
    )
    .all<{
      chat_id: string;
      friend_id: string;
      line_user_id: string;
      metadata: string | null;
      channel_access_token: string | null;
      last_in: string | null;
      last_out: string | null;
    }>();

  const clients = new Map<string, LineClient>();

  for (const row of rows.results) {
    try {
      if (!row.last_in) continue;
      const inMs = new Date(row.last_in).getTime();
      if (!Number.isFinite(inMs)) continue;

      // 受信後に返信済みならスキップ
      if (row.last_out && new Date(row.last_out).getTime() >= inMs) continue;
      // 営業時間内に届いたメッセージは担当者対応
      if (!isOffHours(inMs, cfg)) continue;
      // 経過時間チェック
      if (nowMs - inMs < cfg.delayMinutes * 60_000) continue;

      const meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
      const lastAuto = typeof meta.off_hours_replied_at === 'string'
        ? new Date(meta.off_hours_replied_at).getTime()
        : 0;
      if (lastAuto && nowMs - lastAuto < REPLY_COOLDOWN_MS) continue;

      const token = row.channel_access_token || defaultAccessToken;
      let client = clients.get(token);
      if (!client) {
        client = new LineClient(token);
        clients.set(token, client);
      }

      await client.pushTextMessage(row.line_user_id, cfg.message);

      const now = jstNow();
      meta.off_hours_replied_at = now;
      await db.batch([
        db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', ?)`,
          )
          .bind(crypto.randomUUID(), row.friend_id, cfg.message, now),
        db
          .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), now, row.friend_id),
      ]);
      // チャットは unread のまま残す（担当者が翌営業日に確認できるように）
      console.log(`Off-hours auto-reply sent to friend ${row.friend_id}`);
    } catch (err) {
      console.error('Off-hours auto-reply failed for chat', row.chat_id, err);
    }
  }
}
