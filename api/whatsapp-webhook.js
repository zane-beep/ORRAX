import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

const GRAPH_API_VERSION = "v23.0";

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return false;

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
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

async function claimMessage(messageId) {
  const redisUrl =
    process.env.ORRAX_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const redisToken =
    process.env.ORRAX_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  // Without Redis, duplicate protection cannot be guaranteed.
  if (!redisUrl || !redisToken) return true;

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
    throw new Error("Redis deduplication request failed");
  }

  const result = await response.json();

  return result.result === "OK";
}

async function generateReply(userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text:
                "You are ORRAX AI, an intelligent and helpful assistant. " +
                "Reply naturally in the same language as the user. " +
                "Be accurate, concise, and respectful. " +
                "Never claim to have performed an action you did not perform.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userMessage }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 700,
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini request failed:", response.status);
    throw new Error("AI response generation failed");
  }

  const answer = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    throw new Error("Gemini returned an empty response");
  }

  return answer.slice(0, 4000);
}

async function sendWhatsAppMessage(to, message) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    throw new Error("WhatsApp environment variables are missing");
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

  if (!response.ok) {
    const errorText = await response.text();
    console.error("WhatsApp send failed:", response.status, errorText);
    throw new Error("WhatsApp message delivery failed");
  }
}

export default async function handler(req, res) {
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
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Webhook verification failed");
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Method not allowed");
  }

  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
    console.error("META_APP_SECRET is missing");
    return res.status(500).send("Webhook configuration error");
  }

  let rawBody;

  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).send("Invalid request body");
  }

  const signature = req.headers["x-hub-signature-256"];

  if (!verifySignature(rawBody, signature, appSecret)) {
    return res.status(401).send("Invalid signature");
  }

  let body;

  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  if (body.object !== "whatsapp_business_account") {
    return res.status(404).send("Unsupported webhook object");
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value || {};

        for (const message of value.messages || []) {
          // Ignore unsupported message types.
          if (message.type !== "text" || !message.text?.body) continue;

          // Do not process messages sent by the business itself.
          if (message.from === value.metadata?.display_phone_number) {
            continue;
          }

          const isNew = await claimMessage(message.id);

          if (!isNew) continue;

          const answer = await generateReply(message.text.body);

          await sendWhatsAppMessage(message.from, answer);
        }
      }
    }

    return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("WhatsApp webhook processing failed:", error.message);

    return res.status(500).send("Webhook processing failed");
  }
}
