import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const GRAPH_API_VERSION = "v23.0";

const GEMINI_MODEL =
  process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";

// ==========================================
// 1. READ RAW REQUEST BODY
// ==========================================

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

// ==========================================
// 2. VERIFY META SIGNATURE
// ==========================================

function verifySignature(rawBody, signature, appSecret) {
  if (
    !signature ||
    typeof signature !== "string" ||
    !appSecret
  ) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");

  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  );
}

// ==========================================
// 3. REDIS DUPLICATE PROTECTION
// ==========================================

async function claimMessage(messageId) {
  const redisUrl =
    process.env.ORRAX_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const redisToken =
    process.env.ORRAX_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    console.warn(
      "Redis not configured. Duplicate protection unavailable."
    );

    return true;
  }

  const key = `orrax:whatsapp:processed:${messageId}`;

  const response = await fetch(
    `${redisUrl.replace(/\/$/, "")}/set/${encodeURIComponent(
      key
    )}/1/EX/86400/NX`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Redis deduplication failed: HTTP ${response.status}`
    );
  }

  const result = await response.json();

  return result.result === "OK";
}

// ==========================================
// 4. ORRAX AI - GEMINI INTERACTIONS API
// ==========================================

async function generateReply(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured"
    );
  }

  const systemInstruction = [
    "You are ORRAX AI.",
    "You are an intelligent AI assistant created by KHAN SAHEB.",
    "Your purpose is to help users accurately and naturally.",
    "Always respond in the same language as the user.",
    "If the user writes in Bengali, reply in Bengali.",
    "If the user writes in English, reply in English.",
    "Be friendly, professional, intelligent and respectful.",
    "Provide detailed explanations when necessary.",
    "For technical questions, provide practical solutions.",
    "Never claim to have performed an action you did not perform.",
    "Do not reveal API keys, secrets or internal configuration.",
  ].join("\n");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify({
        model: GEMINI_MODEL,

        input: userMessage,

        system_instruction: systemInstruction,

        generation_config: {
          thinking_level: "low",
        },

        store: false,
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(
      "Gemini Interactions API failed:",
      response.status,
      JSON.stringify(data.error || {}).slice(0, 1000)
    );

    throw new Error(
      `Gemini Interactions API failed: HTTP ${response.status}`
    );
  }

  // Direct text output
  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim().slice(0, 4000);
  }

  // Interactions API model output
  const steps = Array.isArray(data.steps)
    ? data.steps
    : [];

  const answer = steps
    .filter(
      (step) =>
        step?.type === "model_output" &&
        Array.isArray(step.content)
    )
    .flatMap((step) => step.content)
    .filter(
      (part) =>
        typeof part?.text === "string"
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (!answer) {
    console.error(
      "Gemini returned no text. Response keys:",
      Object.keys(data)
    );

    throw new Error(
      "Gemini returned an empty response"
    );
  }

  return answer.slice(0, 4000);
}

// ==========================================
// 5. SEND WHATSAPP MESSAGE
// ==========================================

async function sendWhatsAppMessage(to, message) {
  const accessToken =
    process.env.WHATSAPP_ACCESS_TOKEN;

  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    throw new Error(
      "WhatsApp environment variables are missing"
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        messaging_product: "whatsapp",

        recipient_type: "individual",

        to,

        type: "text",

        text: {
          preview_url: false,
          body: message,
        },
      }),
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(
      "WhatsApp send failed:",
      response.status,
      JSON.stringify(data.error || {}).slice(0, 1000)
    );

    throw new Error(
      `WhatsApp message delivery failed: HTTP ${response.status}`
    );
  }

  return data;
}

// ==========================================
// 6. MAIN WEBHOOK HANDLER
// ==========================================

export default async function handler(req, res) {

  // ========================================
  // META WEBHOOK VERIFICATION
  // ========================================

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];

    const token = req.query["hub.verify_token"];

    const challenge = req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token &&
      process.env.WHATSAPP_VERIFY_TOKEN &&
      token === process.env.WHATSAPP_VERIFY_TOKEN
    ) {
      console.log(
        "WhatsApp webhook verified successfully"
      );

      return res.status(200).send(challenge);
    }

    return res
      .status(403)
      .send("Webhook verification failed");
  }

  // ========================================
  // METHOD CHECK
  // ========================================

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");

    return res
      .status(405)
      .send("Method not allowed");
  }

  // ========================================
  // META APP SECRET
  // ========================================

  const appSecret =
    process.env.META_APP_SECRET;

  if (!appSecret) {
    console.error(
      "META_APP_SECRET is missing"
    );

    return res
      .status(500)
      .send("Webhook configuration error");
  }

  // ========================================
  // READ REQUEST BODY
  // ========================================

  let rawBody;

  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    console.error(
      "Raw body reading failed:",
      error.message
    );

    return res
      .status(400)
      .send("Invalid request body");
  }

  // ========================================
  // VERIFY META SIGNATURE
  // ========================================

  const signature =
    req.headers["x-hub-signature-256"];

  if (
    !verifySignature(
      rawBody,
      signature,
      appSecret
    )
  ) {
    console.error(
      "Invalid Meta webhook signature"
    );

    return res
      .status(401)
      .send("Invalid signature");
  }

  // ========================================
  // PARSE JSON
  // ========================================

  let body;

  try {
    body = JSON.parse(
      rawBody.toString("utf8")
    );
  } catch {
    return res
      .status(400)
      .send("Invalid JSON");
  }

  // ========================================
  // CHECK WHATSAPP EVENT
  // ========================================

  if (
    body.object !==
    "whatsapp_business_account"
  ) {
    return res
      .status(404)
      .send("Unsupported webhook object");
  }

  // ========================================
  // PROCESS INCOMING MESSAGES
  // ========================================

  try {
    for (const entry of body.entry || []) {

      for (const change of entry.changes || []) {

        if (change.field !== "messages") {
          continue;
        }

        const value = change.value || {};

        for (const message of value.messages || []) {

          // Only process text messages
          if (
            message.type !== "text" ||
            !message.text?.body
          ) {
            continue;
          }

          // Ignore own messages
          const sender = String(
            message.from || ""
          ).replace(/\D/g, "");

          const businessNumber = String(
            value.metadata?.display_phone_number || ""
          ).replace(/\D/g, "");

          if (
            !sender ||
            (businessNumber &&
              sender === businessNumber)
          ) {
            continue;
          }

          // Avoid duplicate processing
          const isNew = await claimMessage(
            message.id
          );

          if (!isNew) {
            console.log(
              "Duplicate WhatsApp message ignored"
            );

            continue;
          }

          console.log(
            "Processing incoming WhatsApp text message"
          );

          // Generate ORRAX AI response
          const answer = await generateReply(
            message.text.body
          );

          // Send response
          await sendWhatsAppMessage(
            sender,
            answer
          );

          console.log(
            "ORRAX AI WhatsApp reply sent successfully"
          );
        }
      }
    }

    return res
      .status(200)
      .send("EVENT_RECEIVED");

  } catch (error) {

    console.error(
      "WhatsApp webhook processing failed:",
      error.message
    );

    return res
      .status(500)
      .send("Webhook processing failed");
  }
}
