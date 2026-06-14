// api/webhook.js
// Node.js + Vercel Serverless Functions + Supabase + Meta Instagram Graph API
// CommonJS compatible

const { createClient } = require("@supabase/supabase-js");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

// Facebook Page ID.
// page payload에서는 recipient.id가 보통 Page ID로 들어오지만,
// 운영 안정성을 위해 환경변수 META_PAGE_ID가 있으면 우선 사용합니다.
const META_PAGE_ID = process.env.META_PAGE_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_REPLY_TABLE =
  process.env.SUPABASE_REPLY_TABLE || "auto_reply_rules";

const DEFAULT_REPLY =
  process.env.DEFAULT_REPLY ||
  "문의 감사합니다. 확인 후 빠르게 답변드리겠습니다.";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return handleWebhookVerification(req, res);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = getRequestBody(req);

    console.log("[WEBHOOK] Incoming body.object:", body.object);
    console.log("[WEBHOOK] Incoming raw body:", JSON.stringify(body));

    const events = normalizeWebhookEvents(body);

    if (events.length === 0) {
      console.log("[WEBHOOK] No processable DM event.");
      return res.status(200).send("EVENT_RECEIVED");
    }

    for (const event of events) {
      try {
        await processDmEvent(event, body);
      } catch (eventError) {
        console.error("[WEBHOOK] Event processing failed:", {
          message: eventError.message,
          stack: eventError.stack,
          event,
        });

        await saveWebhookEventLog({
          objectType: body.object,
          eventType: "processing_error",
          rawPayload: body,
          processed: false,
          errorMessage: eventError.message,
        });
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("[WEBHOOK] Fatal error:", {
      message: error.message,
      stack: error.stack,
    });

    // Meta Webhook은 5xx가 반복되면 재시도/차단 이슈가 생길 수 있으므로
    // 서버 자체가 살아있다면 200으로 수신 성공을 반환합니다.
    return res.status(200).send("EVENT_RECEIVED_WITH_ERROR");
  }
};

function handleWebhookVerification(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("[WEBHOOK] Verification request:", {
    mode,
    hasToken: Boolean(token),
    hasChallenge: Boolean(challenge),
  });

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verification success.");
    return res.status(200).send(challenge);
  }

  console.error("[WEBHOOK] Verification failed.");
  return res.status(403).send("Forbidden");
}

function getRequestBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  if (Buffer.isBuffer(req.body)) {
    return JSON.parse(req.body.toString("utf8"));
  }

  return req.body;
}

function normalizeWebhookEvents(body) {
  const events = [];

  if (!body || !Array.isArray(body.entry)) {
    console.warn("[WEBHOOK] Invalid payload: missing entry array.");
    return events;
  }

  // 핵심 수정:
  // Instagram DM이 Facebook Page 껍데기로 들어오는 경우 body.object === "page"
  // 일부 구성에서는 body.object === "instagram" 가능
  const allowedObjects = new Set(["page", "instagram"]);

  if (!allowedObjects.has(body.object)) {
    console.warn("[WEBHOOK] Unsupported body.object:", body.object);
    return events;
  }

  for (const entry of body.entry) {
    // Instagram Messaging / Messenger style payload
    if (Array.isArray(entry.messaging)) {
      for (const messagingEvent of entry.messaging) {
        const parsed = parseMessagingEvent({
          objectType: body.object,
          entry,
          messagingEvent,
        });

        if (parsed) {
          events.push(parsed);
        }
      }
    }

    // 방어 코드:
    // 일부 Instagram Platform Webhook은 changes 형태로 들어올 수 있습니다.
    // 현재 필수 요구사항은 entry[].messaging[]지만,
    // 향후 payload 변형에 대비해 최소한으로 대응합니다.
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const value = change.value || {};

        if (Array.isArray(value.messaging)) {
          for (const messagingEvent of value.messaging) {
            const parsed = parseMessagingEvent({
              objectType: body.object,
              entry,
              messagingEvent,
            });

            if (parsed) {
              events.push(parsed);
            }
          }
        }
      }
    }
  }

  return events;
}

function parseMessagingEvent({ objectType, entry, messagingEvent }) {
  if (!messagingEvent || typeof messagingEvent !== "object") {
    return null;
  }

  // delivery/read 이벤트는 답장 대상이 아닙니다.
  if (messagingEvent.delivery) {
    console.log("[WEBHOOK] Skip delivery event.");
    return null;
  }

  if (messagingEvent.read) {
    console.log("[WEBHOOK] Skip read event.");
    return null;
  }

  const message = messagingEvent.message || {};

  // 봇이 보낸 메시지가 다시 웹훅으로 들어오는 echo 이벤트는
  // 무한 자동응답 루프를 만들 수 있으므로 반드시 무시합니다.
  if (message.is_echo) {
    console.log("[WEBHOOK] Skip echo message.");
    return null;
  }

  const senderId = messagingEvent.sender && messagingEvent.sender.id;
  const recipientId =
    messagingEvent.recipient && messagingEvent.recipient.id;

  const messageText = message.text || "";
  const messageId = message.mid || null;
  const timestamp = messagingEvent.timestamp || entry.time || Date.now();

  if (!senderId) {
    console.warn("[WEBHOOK] Missing sender.id:", JSON.stringify(messagingEvent));
    return null;
  }

  if (!recipientId) {
    console.warn(
      "[WEBHOOK] Missing recipient.id:",
      JSON.stringify(messagingEvent)
    );
    return null;
  }

  if (!messageText) {
    console.log("[WEBHOOK] Message has no text. Skip auto reply.", {
      senderId: maskId(senderId),
      recipientId: maskId(recipientId),
      messageId,
    });
    return null;
  }

  return {
    objectType,
    entryId: entry.id || null,
    senderId,
    recipientId,
    messageText: String(messageText).trim(),
    messageId,
    timestamp,
    rawEvent: messagingEvent,
  };
}

async function processDmEvent(event, fullPayload) {
  console.log("[DM] Processing message:", {
    objectType: event.objectType,
    entryId: event.entryId,
    senderId: maskId(event.senderId),
    recipientId: maskId(event.recipientId),
    messageId: event.messageId,
    messageText: event.messageText,
  });

  await saveWebhookEventLog({
    objectType: event.objectType,
    eventType: "message_received",
    rawPayload: fullPayload,
    processed: false,
    errorMessage: null,
  });

  const replyText = await resolveReplyText(event.messageText);

  await saveDmMessageLog({
    event,
    direction: "incoming",
    messageText: event.messageText,
    rawPayload: event.rawEvent,
  });

  const sendResult = await sendInstagramMessage({
    senderId: event.senderId,
    recipientId: event.recipientId,
    replyText,
  });

  await saveDmMessageLog({
    event,
    direction: "outgoing",
    messageText: replyText,
    rawPayload: sendResult,
  });

  await saveWebhookEventLog({
    objectType: event.objectType,
    eventType: "message_replied",
    rawPayload: {
      event,
      sendResult,
    },
    processed: true,
    errorMessage: null,
  });

  console.log("[DM] Reply success:", {
    senderId: maskId(event.senderId),
    replyText,
    sendResult,
  });
}

async function resolveReplyText(incomingText) {
  if (!supabase) {
    console.warn("[SUPABASE] Missing Supabase config. Use DEFAULT_REPLY.");
    return DEFAULT_REPLY;
  }

  const normalizedIncomingText = normalizeText(incomingText);

  try {
    const { data, error } = await supabase
      .from(SUPABASE_REPLY_TABLE)
      .select("*")
      .eq("is_active", true)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[SUPABASE] Reply rule query failed:", error);
      return DEFAULT_REPLY;
    }

    if (!Array.isArray(data) || data.length === 0) {
      console.log("[SUPABASE] No active reply rules. Use DEFAULT_REPLY.");
      return DEFAULT_REPLY;
    }

    const matchedRule = data.find((rule) => {
      const keyword = normalizeText(rule.keyword);

      if (!keyword) {
        return false;
      }

      return normalizedIncomingText.includes(keyword);
    });

    if (!matchedRule) {
      console.log("[SUPABASE] No keyword matched. Use DEFAULT_REPLY.");
      return DEFAULT_REPLY;
    }

    const replyText = matchedRule.reply_text || DEFAULT_REPLY;

    console.log("[SUPABASE] Matched reply rule:", {
      ruleId: matchedRule.id,
      keyword: matchedRule.keyword,
      replyText,
    });

    return replyText;
  } catch (error) {
    console.error("[SUPABASE] Reply resolve exception:", {
      message: error.message,
      stack: error.stack,
    });

    return DEFAULT_REPLY;
  }
}

async function sendInstagramMessage({ senderId, recipientId, replyText }) {
  if (!META_ACCESS_TOKEN) {
    throw new Error("Missing META_ACCESS_TOKEN");
  }

  // 우선순위:
  // 1. Vercel 환경변수 META_PAGE_ID
  // 2. Webhook payload의 recipient.id
  //
  // object: "page"로 들어온 경우 recipient.id가 Facebook Page ID일 가능성이 높습니다.
  const pageId = META_PAGE_ID || recipientId;

  if (!pageId) {
    throw new Error("Missing pageId. Set META_PAGE_ID or check recipient.id.");
  }

  const endpoint = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pageId}/messages`;

  const payload = {
    recipient: {
      id: senderId,
    },
    messaging_type: "RESPONSE",
    message: {
      text: replyText,
    },
  };

  console.log("[META] Sending reply:", {
    endpoint,
    recipientId: maskId(senderId),
    replyText,
  });

  const response = await fetch(
    `${endpoint}?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const responseText = await response.text();

  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = {
      raw: responseText,
    };
  }

  if (!response.ok) {
    console.error("[META] Reply failed:", {
      status: response.status,
      responseBody,
    });

    throw new Error(
      `Meta reply failed. Status: ${response.status}. Body: ${JSON.stringify(
        responseBody
      )}`
    );
  }

  return {
    status: response.status,
    body: responseBody,
  };
}

async function saveWebhookEventLog({
  objectType,
  eventType,
  rawPayload,
  processed,
  errorMessage,
}) {
  if (!supabase) {
    return;
  }

  try {
    const { error } = await supabase.from("webhook_events").insert({
      object_type: objectType,
      event_type: eventType,
      raw_payload: rawPayload,
      processed,
      error_message: errorMessage,
    });

    if (error) {
      // 테이블이 아직 없어도 본 기능은 계속 돌아가야 하므로 경고만 출력합니다.
      console.warn("[SUPABASE] webhook_events insert skipped:", error.message);
    }
  } catch (error) {
    console.warn("[SUPABASE] webhook_events insert exception:", error.message);
  }
}

async function saveDmMessageLog({ event, direction, messageText, rawPayload }) {
  if (!supabase) {
    return;
  }

  try {
    const { error } = await supabase.from("dm_messages").insert({
      sender_id: event.senderId,
      recipient_id: event.recipientId,
      message_id: event.messageId,
      direction,
      message_text: messageText,
      raw_payload: rawPayload,
    });

    if (error) {
      // 테이블이 아직 없어도 본 기능은 계속 돌아가야 하므로 경고만 출력합니다.
      console.warn("[SUPABASE] dm_messages insert skipped:", error.message);
    }
  } catch (error) {
    console.warn("[SUPABASE] dm_messages insert exception:", error.message);
  }
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function maskId(value) {
  const id = String(value || "");

  if (id.length <= 8) {
    return "***";
  }

  return `${id.slice(0, 4)}***${id.slice(-4)}`;
}
