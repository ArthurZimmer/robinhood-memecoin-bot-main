import { env } from '../config/env.js'
import { createChildLogger } from './logger.js'

const log = createChildLogger('telegram')

/**
 * Send a Telegram alert message via Bot API.
 * Best-effort only — never throws. If Telegram is unreachable, the alert is
 * silently dropped so it doesn't break the trading path.
 *
 * HTML parse mode lets callers use <b>, <i>, <code>, <a href> tags.
 */
export async function sendTelegramAlert(message: string): Promise<void> {
  // Fail fast if Telegram isn't configured — no point making the request
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    log.warn('Telegram not configured, skipping alert')
    return
  }

  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn({ status: res.status, body: body.slice(0, 200) }, 'Telegram API returned non-OK')
    }
  } catch (err) {
    log.warn({ err }, 'Failed to send Telegram alert — non-fatal')
  }
}
