// api/webhook.js
// Vercel Serverless Function + Meta Instagram Messaging Webhook + Supabase
// CommonJS 기준 코드입니다.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

// page payload일 때는 recipient.id가 보통 PAGE_ID입니다.
// 그래도 안정성을 위해 환경변수 META_PAGE_ID가 있으면 우선 사용합니다.
const META_PAGE_ID = process.env.META_PAGE_ID || "";

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

// 자동응답 테이블 기본값
// 실제 테이블명이 다르면 Vercel 환경변수 SUPABASE_REPLY_TABLE로 바꾸세요.
const SUPABASE_REPLY_TABLE =
  process.env.SUPABASE_REPLY_TABLE || "instagram_auto_replies";

const DEFAULT_REPLY =
  process.env.DEFAULT_REPLY ||
  "문의 감사합니다. 확인 후 빠르게 답변드리겠습니다.";

const supabase =
  SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return handleVerification(req, res);
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).send("Method Not Allowed");
    }

    const { rawBody, body } = await readMetaBody(req);

    // 선택 보안: META_APP_SECRET이 있으면 X-Hub-Signature-256 검증
    // raw body를 안정적으로 확보하지 못하는 환경에서는 실패할 수 있으므로,
    // 현재 운영 안정성을 위해 app secret이 있을 때만 수행합니다.
    if (META_APP_SECRET) {
      const valid = verifyMetaSignature(req, rawBody, META_APP_SECRET);
      if (!valid) {
        console.error("[META_WEBHOOK] Invalid X-Hub-Signature-256");
        return res.status(403).send("Invalid signature");
      }
    }

    console.log(
      "[META_WEBHOOK] Incoming object:",
      body && body.object ? body.object : "unknown"
    );

    const events = normalizeMetaEvents(body);

    if (events.length === 0) {
      console.log("[META_WEBHOOK] No processable messaging events.");
      return res.status(200).send("EVENT_RECEIVED");
    }

    for (const event of events) {
      await processMessagingEvent(event);
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("[META_WEBHOOK] Fatal error:", safeError(error));

    // Meta 웹훅은 5xx가 반복되면 재시도/차단 이슈가 생길 수 있습니다.
    // 디버깅 중에는 500을 유지하고, 운영 안정화 후에는 200 처리도 검토 가능합니다.
    return res.status(500).send("Webhook processing failed");
  }
};

function handleVerification(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[META_WEBHOOK] Verification success");
    return res.status(200).send(challenge);
  }

  console.error("[META_WEBHOOK] Verification failed");
  return res.status(403).send("Forbidden");
}

async function readMetaBody(req) {
  // Vercel/Node 환경에 따라 req.body가 object, string, Buffer 중 하나일 수 있습니다.
  if (Buffer.isBuffer(req.body)) {
    return {
      rawBody: req.body,
      body: JSON.parse(req.body.toString("utf8")),
    };
  }

  if (typeof req.body === "string") {
    return {
      rawBody: Buffer.from(req.body, "utf8"),
      body: JSON.parse(req.body),
    };
  }

  if (req.body && typeof req.body === "object") {
    const raw = Buffer.from(JSON.stringify(req.body), "utf8");
    return {
      rawBody: raw,
      body: req.body,
    };
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks);
  const text = rawBody.toString("utf8");

  return {
    rawBody,
    body: text ? JSON.parse(text) : {},
  };
}

function verifyMetaSignature(req, rawBody, appSecret) {
  const signature =
    req.headers["x-hub-signature-256"] ||
    req.headers["X-Hub-Signature-256"];

  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function normalizeMetaEvents(body) {
  const events = [];

  if (!body || !Array.isArray(body.entry)) {
    return events;
  }

  // 핵심 수정점:
  // 기존 instagram만 통과시키던 조건을 page + instagram 모두 허용합니다.
  const allowedObjects = new Set(["page", "instagram"]);

  if (!allowedObjects.has(body.object)) {
    console.warn("[META_WEBHOOK] Unsupported object:", body.object);
    return events;
  }

  for (const entry of body.entry) {
    // 가장 일반적인 Instagram Messaging / Messenger-style payload
    // body.object === "page"인 경우 보통 이 구조로 들어옵니다.
    if (Array.isArray(entry.messaging)) {
      for (const rawEvent of entry.messaging) {
        const parsed = parseMessagingEvent(rawEvent, entry, body.object);
        if (parsed) events.push(parsed);
      }
    }

    // 일부 Instagram Platform 계열 이벤트는 changes 구조로 들어올 수 있어 방어 처리합니다.
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const value = change.value || {};

        if (Array.isArray(value.messaging)) {
          for (const rawEvent of value.messaging) {
            const parsed = parseMessagingEvent(rawEvent, entry, body.object);
            if (parsed) events.push(parsed);
          }
        }

        if (Array.isArray(value.messages)) {
          for (const message of value.messages) {
            const rawEvent = convertChangeMessageToMessagingEvent(
              message,
              value,
              entry
            );
            const parsed = parseMessagingEvent(rawEvent, entry, body.object);
            if (parsed) events.push(parsed);
          }
        }

        if (value.message) {
          const rawEvent = convertChangeMessageToMessagingEvent(
            value.message,
            value,
            entry
          );
          const parsed = parseMessagingEvent(rawEvent, entry, body.object);
          if (parsed) events.push(parsed);
        }
      }
    }
  }

  return events;
}

function parseMessagingEvent(rawEvent, entry, objectType) {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  // delivery/read/typing 등은 자동응답 대상이 아닙니다.
  if (rawEvent.delivery || rawEvent.read || rawEvent.optin) {
    return null;
  }

  const message = rawEvent.message || {};
  const postback = rawEvent.postback || {};

  // 봇이 보낸 echo 메시지에 다시 답장하면 무한 루프가 생길 수 있습니다.
  if (message.is_echo) {
    console.log("[META_WEBHOOK] Skip echo message.");
    return null;
  }

  const senderId =
    rawEvent.sender?.id ||
    rawEvent.from?.id ||
    message.from?.id ||
    null;

  const recipientId =
    rawEvent.recipient?.id ||
    rawEvent.to?.id ||
    message.to?.id ||
    entry.id ||
    null;

  const messageText =
    message.text ||
    message.quick_reply?.payload ||
    postback.payload ||
    postback.title ||
    rawEvent.text ||
    "";

  const attachmentCount = Array.isArray(message.attachments)
    ? message.attachments.length
    : 0;

  const messageId =
    message.mid ||
    message.id ||
    rawEvent.mid ||
    rawEvent.id ||
    `${senderId || "unknown"}:${rawEvent.timestamp || Date.now()}`;

  if (!senderId) {
    console.warn("[META_WEBHOOK] Missing sender.id:", safeJson(rawEvent));
    return null;
  }

  if (!recipientId) {
    console.warn("[META_WEBHOOK] Missing recipient.id:", safeJson(rawEvent));
    return null;
  }

  if (!messageText && attachmentCount === 0) {
    console.log("[META_WEBHOOK] No text/attachment to process.");
    return null;
  }

  return {
    objectType,
    entryId: entry.id || null,
    senderId,
    recipientId,
    messageId,
    text: String(messageText || "").trim(),
    hasAttachments: attachmentCount > 0,
    timestamp: rawEvent.timestamp || entry.time || Date.now(),
    rawEvent,
  };
}

function convertChangeMessageToMessagingEvent(message, value, entry) {
  return {
    sender: {
      id:
        message?.from?.id ||
        value?.sender?.id ||
        value?.from?.id ||
        value?.user?.id,
    },
    recipient: {
      id:
        value?.recipient?.id ||
        value?.to?.id ||
        value?.account_id ||
        entry?.id,
    },
    timestamp: message?.timestamp || value?.time || entry?.time || Date.now(),
    message: {
      mid: message?.mid || message?.id,
      text:
        message?.text ||
        message?.message?.text ||
        value?.text ||
        value?.message?.text,
      attachments: message?.attachments || value?.attachments,
      is_echo: message?.is_echo,
    },
  };
}

async function processMessagingEvent(event) {
  console.log("[META_WEBHOOK] Process event:", {
    objectType: event.objectType,
    senderId: maskId(event.senderId),
    recipientId: maskId(event.recipientId),
    messageId: event.messageId,
    text: event.text,
    hasAttachments: event.hasAttachments,
  });

  const replyText = await getReplyFromSupabase(event);

  if (!replyText) {
    console.log("[META_WEBHOOK] No reply text resolved.");
    return;
  }

  const sendResult = await sendInstagramReply({
    senderId: event.senderId,
    recipientId: event.recipientId,
    entryId: event.entryId,
    text: replyText,
  });

  await saveWebhookLog(event, replyText, sendResult);

  console.log("[META_WEBHOOK] Reply sent:", sendResult);
}

async function getReplyFromSupabase(event) {
  if (!supabase) {
    console.warn("[SUPABASE] Missing Supabase env. Use DEFAULT_REPLY.");
    return event.hasAttachments
      ? "이미지/파일 메시지를 확인했습니다. 담당자가 확인 후 답변드리겠습니다."
      : DEFAULT_REPLY;
  }

  // 첨부 메시지 전용 기본 답장
  if (!event.text && event.hasAttachments) {
    return "이미지/파일 메시지를 확인했습니다. 담당자가 확인 후 답변드리겠습니다.";
  }

  const incomingText = normalizeText(event.text);

  try {
    const { data, error } = await supabase
      .from(SUPABASE_REPLY_TABLE)
      .select("*");

    if (error) {
      console.error("[SUPABASE] Reply table query failed:", error.message);
      return DEFAULT_REPLY;
    }

    if (!Array.isArray(data) || data.length === 0) {
      return DEFAULT_REPLY;
    }

    // 다양한 컬럼명에 대응합니다.
    // 권장 컬럼:
    // keyword, reply_text, is_active
    const activeRows = data.filter((row) => {
      if (typeof row.is_active === "boolean") return row.is_active;
      if (typeof row.active === "boolean") return row.active;
      if (typeof row.enabled === "boolean") return row.enabled;
      return true;
    });

    const exactMatch = activeRows.find((row) => {
      const keyword = extractKeyword(row);
      return keyword && normalizeText(keyword) === incomingText;
    });

    if (exactMatch) {
      return extractReplyText(exactMatch) || DEFAULT_REPLY;
    }

    const containsMatch = activeRows.find((row) => {
      const keyword = extractKeyword(row);
      return keyword && incomingText.includes(normalizeText(keyword));
    });

    if (containsMatch) {
      return extractReplyText(containsMatch) || DEFAULT_REPLY;
    }

    return DEFAULT_REPLY;
  } catch (error) {
    console.error("[SUPABASE] Reply lookup exception:", safeError(error));
    return DEFAULT_REPLY;
  }
}

function extractKeyword(row) {
  return (
    row.keyword ||
    row.trigger ||
    row.trigger_text ||
    row.question ||
    row.input ||
    ""
  );
}

function extractReplyText(row) {
  return (
    row.reply_text ||
    row.reply ||
    row.response ||
    row.answer ||
    row.message ||
    row.content ||
    ""
  );
}

async function sendInstagramReply({ senderId, recipientId, entryId, text }) {
  if (!META_ACCESS_TOKEN) {
    throw new Error("Missing META_ACCESS_TOKEN");
  }

  // 우선순위:
  // 1. 환경변수 META_PAGE_ID
  // 2. payload의 recipient.id
  // 3. entry.id
  // 4. me
  const pageOrAccountId = META_PAGE_ID || recipientId || entryId || "me";

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pageOrAccountId}/messages?access_token=${encodeURIComponent(
    META_ACCESS_TOKEN
  )}`;

  const payload = {
    recipient: {
      id: senderId,
    },
    messaging_type: "RESPONSE",
    message: {
      text,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseJson = null;

  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = { raw: responseText };
  }

  if (!response.ok) {
    console.error("[META_SEND] Failed:", {
      status: response.status,
      body: responseJson,
    });

    throw new Error(
      `Meta send failed: HTTP ${response.status} ${safeJson(responseJson)}`
    );
  }

  return {
    status: response.status,
    body: responseJson,
  };
}

async function saveWebhookLog(event, replyText, sendResult) {
  if (!supabase) return;

  const logTable = process.env.SUPABASE_DM_LOG_TABLE;

  // 로그 테이블을 아직 만들지 않았다면 저장 생략
  if (!logTable) return;

  try {
    const { error } = await supabase.from(logTable).insert({
      object_type: event.objectType,
      entry_id: event.entryId,
      sender_id: event.senderId,
      recipient_id: event.recipientId,
      message_id: event.messageId,
      incoming_text: event.text,
      reply_text: replyText,
      meta_response: sendResult,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.warn("[SUPABASE] Log insert failed:", error.message);
    }
  } catch (error) {
    console.warn("[SUPABASE] Log insert exception:", safeError(error));
  }
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function maskId(id) {
  if (!id) return null;
  const value = String(id);
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack,
  };
}
