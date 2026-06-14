/**
 * api/webhook.js
 *
 * 완벽 보정 버전 — Meta / Instagram Webhook Handler
 * * 수정 내역: Meta 테스트 데이터와 실전 DM 데이터 구조 차이로 인한 'Cannot read properties of undefined' 결함 전면 차단
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

// Supabase REST 헬퍼
async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} @ ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

// DB 조회 / 기록 함수
async function getSettings() {
  try {
    const rows = await supabaseFetch('/integration_settings?select=*&limit=1');
    return rows[0] ?? { fallback_reply: null, dedupe_window: 60, test_mode: false };
  } catch (e) {
    console.error('[webhook] getSettings error:', e.message);
    return { fallback_reply: null, dedupe_window: 60, test_mode: false };
  }
}

async function getActiveRules() {
  try {
    return await supabaseFetch('/rules?select=*&is_active=eq.true&order=priority.desc');
  } catch (e) {
    console.error('[webhook] getActiveRules error:', e.message);
    return [];
  }
}

async function isDuplicate(platformMessageId) {
  try {
    const rows = await supabaseFetch(
      `/incoming_messages?platform_message_id=eq.${encodeURIComponent(platformMessageId)}&select=id&limit=1`,
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

async function logIncomingMessage({ senderId, messageText, platformMessageId, matchedRuleId, matchStatus, rawPayload }) {
  try {
    const rows = await supabaseFetch('/incoming_messages', {
      method: 'POST',
      body: JSON.stringify({
        sender_id: senderId,
        message_text: messageText,
        platform_message_id: platformMessageId ?? null,
        matched_rule_id: matchedRuleId ?? null,
        match_status: matchStatus,
        raw_payload: rawPayload ?? null,
      }),
    });
    return rows[0];
  } catch (e) {
    console.error('[webhook] logIncomingMessage error:', e.message);
    return null;
  }
}

async function logOutgoingMessage({ incomingLogId, recipientId, matchedRuleId, sentText, sentLink, sendStatus, errorMessage, metaResponsePayload }) {
  try {
    await supabaseFetch('/outgoing_messages', {
      method: 'POST',
      body: JSON.stringify({
        incoming_log_id: incomingLogId ?? null,
        recipient_id: recipientId,
        matched_rule_id: matchedRuleId ?? null,
        sent_text: sentText,
        sent_link: sentLink ?? null,
        send_status: sendStatus,
        error_message: errorMessage ?? null,
        meta_response_payload: metaResponsePayload ?? null,
      }),
    });
  } catch (e) {
    console.error('[webhook] logOutgoingMessage error:', e.message);
  }
}

// 규칙 매칭
function matchRules(messageText, rules) {
  if (!messageText) return null;
  const lower = messageText.toLowerCase().trim();
  for (const rule of rules) {
    const keywords = Array.isArray(rule.trigger_keywords) ? rule.trigger_keywords : [];
    const hit = keywords.some((kw) => {
      const kwLower = kw.toLowerCase().trim();
      return rule.match_type === 'exact' ? lower === kwLower : lower.includes(kwLower);
    });
    if (hit) return rule;
  }
  return null;
}

// Instagram DM 발송 (Meta Graph API)
async function sendInstagramDM(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/${IG_USER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      access_token: META_ACCESS_TOKEN,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Meta API ${res.status}`);
  }
  return data;
}

// 단일 DM 이벤트 처리 (완벽 방어막 강화)
async function processMessage(event) {
  // 어떤 데이터 파편이 들어오든 물음표(?.) 안전장치로 튕겨나가지 않게 완벽 보호
  if (!event?.message?.text || event?.message?.is_echo) return;

  const senderId = event?.sender?.id ?? null;
  const messageText = event?.message?.text ?? '';
  const platformMessageId = event?.message?.mid ?? null;

  // 비정상적이거나 유실된 메인 식별자가 들어오면 즉시 안전하게 스킵
  if (!senderId) {
    console.log('[webhook] Skipped due to missing sender.id (Normal behavior in some Meta mock tests)');
    return;
  }

  const [settings, rules] = await Promise.all([getSettings(), getActiveRules()]);

  // 중복 메시지 차단
  if (platformMessageId && (await isDuplicate(platformMessageId))) {
    console.log(`[webhook] duplicate skipped: ${platformMessageId}`);
    return;
  }

  // 규칙 매칭
  const matchedRule = matchRules(messageText, rules);

  // 수신 로그 기록
  const incomingLog = await logIncomingMessage({
    senderId,
    messageText,
    platformMessageId,
    matchedRuleId: matchedRule?.id ?? null,
    matchStatus: matchedRule ? 'matched' : 'unmatched',
    rawPayload: event,
  });

  // 발송할 텍스트 결정
  const replyText = matchedRule?.reply_text ?? settings.fallback_reply ?? null;
  const replyLink = matchedRule?.reply_link ?? null;

  if (!replyText) return;

  // 테스트 모드 → 실제 발송 없이 종료
  if (settings.test_mode) {
    console.log(`[webhook][TEST MODE] to=${senderId} text=${replyText}`);
    return;
  }

  // DM 발송
  const fullText = replyLink ? `${replyText}\n${replyLink}` : replyText;
  let sendStatus = 'success';
  let errorMessage = null;
  let metaResponse = null;

  try {
    metaResponse = await sendInstagramDM(senderId, fullText);
  } catch (err) {
    sendStatus = 'failed';
    errorMessage = err.message;
    console.error(`[webhook] send failed to ${senderId}:`, err.message);
  }

  // 발송 로그 기록
  await logOutgoingMessage({
    incomingLogId: incomingLog?.id ?? null,
    recipientId: senderId,
    matchedRuleId: matchedRule?.id ?? null,
    sentText: replyText,
    sentLink: replyLink,
    sendStatus,
    errorMessage,
    metaResponsePayload: metaResponse,
  });
}

// Vercel 핸들러 진입점
export default async function handler(req, res) {
  // ── GET: Meta 웹훅 URL 검증 ──
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('[webhook] verification success');
      return res.status(200).send(challenge);
    }
    console.warn('[webhook] verification failed');
    return res.status(403).json({ error: 'Verification failed' });
  }

  // ── POST: DM 이벤트 수신 ──
  if (req.method === 'POST') {
    const body = req.body;

    if (body?.object !== 'instagram') {
      return res.status(200).json({ status: 'ignored' });
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];

    await Promise.allSettled(
      entries.flatMap((entry) =>
        (entry?.messaging ?? []).map((event) =>
          processMessage(event).catch((err) =>
            console.error('[webhook] processMessage error:', err.message),
          ),
        ),
      ),
    );

    return res.status(200).json({ status: 'ok' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
