/* ORRAX /api/image
 * Server-only image router.
 * - 6 successful image generations per user per UTC day.
 * - Google users use verified Google ID-token `sub`.
 * - Anonymous users use browser id + IP hash.
 * - xKiro free image model -> xKiro backup key -> Gemini image fallback.
 * - Provider errors/keys/models are never returned to the browser.
 */

import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const DAILY_IMAGE_LIMIT = 6;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
const XKIRO_KEYS = [
  process.env.XKIRO_API_KEY,
  process.env.XKIRO_API_KEY_2
].filter(Boolean);

const XKIRO_FREE_IMAGE_MODEL = "sensenova/sensenova-u1.5-lite";

function corsHeaders(origin = "") {
  const allowed = new Set([
    "https://zane-beep.github.io",
    "https://orrax.vercel.app"
  ]);

  return {
    "Access-Control-Allow-Origin": allowed.has(origin)
      ? origin
      : "https://zane-beep.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ORRAX-CLIENT-ID",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function getRedisConfig() {
  const url =
    process.env.ORRAX_KV_REST_API_URL ||
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    "";

  const token =
    process.env.ORRAX_KV_REST_API_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    "";

  return {
    url: url.replace(/\/+$/, ""),
    token
  };
}

async function redisCommand(command, args = []) {
  const { url, token } = getRedisConfig();

  if (!url || !token) {
    throw new Error("REDIS_NOT_CONFIGURED");
  }

  const path = [command, ...args]
    .map(value => encodeURIComponent(String(value)))
    .join("/");

  const response = await fetch(`${url}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`REDIS_HTTP_${response.status}`);
  }

  const data = await response.json();
  return data?.result;
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function reserveImage(userKey) {
  const key = `orrax:image:${utcDayKey()}:${userKey}`;
  const count = Number(await redisCommand("incr", [key]));

  if (count === 1) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);

    await redisCommand("expireat", [
      key,
      Math.floor(tomorrow.getTime() / 1000)
    ]);
  }

  if (count > DAILY_IMAGE_LIMIT) {
    await redisCommand("decr", [key]).catch(() => {});
    return { allowed: false, key };
  }

  return { allowed: true, key };
}

async function releaseImage(key) {
  if (!key) return;
  await redisCommand("decr", [key]).catch(() => {});
}

async function identifyUser(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : "";

  if (bearer && GOOGLE_CLIENT_ID) {
    try {
      const client = new OAuth2Client(GOOGLE_CLIENT_ID);
      const ticket = await client.verifyIdToken({
        idToken: bearer,
        audience: GOOGLE_CLIENT_ID
      });

      const payload = ticket.getPayload();

      if (payload?.sub) {
        return `google:${sha256(payload.sub)}`;
      }
    } catch (error) {
      console.warn("ORRAX Google identity verification failed");
    }
  }

  const browserId = String(
    req.headers["x-orrax-client-id"] || ""
  ).trim();

  const ip = String(
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  )
    .split(",")[0]
    .trim();

  return `anon:${sha256(`${browserId || "no-browser-id"}|${ip}`)}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      data?.error ||
      `HTTP ${response.status}`
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getXKiroImageModel(key) {
  try {
    const data = await fetchJson(
      "https://api.xkiro.com/v1/models?modality=image",
      {
        headers: {
          Authorization: `Bearer ${key}`
        }
      }
    );

    const models = Array.isArray(data?.data)
      ? data.data
      : [];

    const preferred = models.find(
      model =>
        model?.id === XKIRO_FREE_IMAGE_MODEL &&
        model?.access_tier === "free"
    );

    if (preferred?.id) return preferred.id;

    const free = models.find(
      model => model?.access_tier === "free"
    );

    return free?.id || XKIRO_FREE_IMAGE_MODEL;
  } catch (error) {
    return XKIRO_FREE_IMAGE_MODEL;
  }
}

async function generateWithXKiro(key, prompt) {
  if (!key) throw new Error("NO_XKIRO_KEY");

  const model = await getXKiroImageModel(key);

  const job = await fetchJson(
    "https://api.xkiro.com/v1/images/generations",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: "1024x1024"
      })
    }
  );

  if (!job?.id) {
    throw new Error("XKIRO_NO_JOB_ID");
  }

  const deadline = Date.now() + 240_000;
  let waitMs = 2000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, waitMs));
    waitMs = Math.min(Math.round(waitMs * 1.5), 8000);

    const status = await fetchJson(
      `https://api.xkiro.com/v1/images/generations/${encodeURIComponent(job.id)}`,
      {
        headers: {
          Authorization: `Bearer ${key}`
        }
      }
    );

    if (status?.status === "succeeded") {
      const url = status?.data?.[0]?.url;
      if (!url) throw new Error("XKIRO_EMPTY_IMAGE_URL");
      return url;
    }

    if (status?.status === "failed" || status?.status === "blocked") {
      throw new Error("XKIRO_IMAGE_FAILED");
    }
  }

  throw new Error("XKIRO_IMAGE_TIMEOUT");
}

function extractGeminiImage(data) {
  const direct = data?.output_image;

  if (direct?.data) {
    return {
      url: `data:${direct.mime_type || "image/png"};base64,${direct.data}`,
      mimeType: direct.mime_type || "image/png"
    };
  }

  const steps = Array.isArray(data?.steps) ? data.steps : [];

  for (const step of steps) {
    const parts = Array.isArray(step?.content)
      ? step.content
      : [];

    for (const part of parts) {
      const image =
        part?.image ||
        part?.inline_data ||
        part?.inlineData;

      if (image?.data) {
        return {
          url: `data:${image.mime_type || image.mimeType || "image/png"};base64,${image.data}`,
          mimeType: image.mime_type || image.mimeType || "image/png"
        };
      }
    }
  }

  return null;
}

async function generateWithGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("NO_GEMINI_KEY");

  const data = await fetchJson(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: GEMINI_IMAGE_MODEL,
        input: prompt,
        response_format: {
          type: "image",
          mime_type: "image/png",
          aspect_ratio: "1:1",
          image_size: "1K"
        },
        store: false
      })
    }
  );

  const image = extractGeminiImage(data);

  if (!image?.url) {
    throw new Error("GEMINI_EMPTY_IMAGE");
  }

  return image.url;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  Object.entries(corsHeaders(origin)).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const prompt = String(req.body?.prompt || "").trim();

    if (!prompt) {
      return res.status(400).json({
        error: "A valid image prompt is required."
      });
    }

    const userKey = await identifyUser(req);
    const reservation = await reserveImage(userKey);

    if (!reservation.allowed) {
      return res.status(429).json({
        code: "DAILY_IMAGE_LIMIT",
        error: "Daily image limit reached."
      });
    }

    let generatedUrl = "";

    try {
      /* xKiro has a documented free image model. */
      for (const key of XKIRO_KEYS) {
        try {
          generatedUrl = await generateWithXKiro(key, prompt);
          if (generatedUrl) break;
        } catch (error) {
          console.warn("ORRAX xKiro image attempt failed");
        }
      }

      /* Google is a fallback. Its current image models are paid-tier. */
      if (!generatedUrl) {
        try {
          generatedUrl = await generateWithGemini(prompt);
        } catch (error) {
          console.warn("ORRAX Gemini image fallback failed");
        }
      }

      if (!generatedUrl) {
        await releaseImage(reservation.key);
        return res.status(503).json({
          code: "IMAGE_UNAVAILABLE",
          error: "Image generation is temporarily unavailable."
        });
      }

      return res.status(200).json({
        imageDataUrl: generatedUrl
      });
    } catch (error) {
      await releaseImage(reservation.key);
      return res.status(503).json({
        code: "IMAGE_UNAVAILABLE",
        error: "Image generation is temporarily unavailable."
      });
    }
  } catch (error) {
    console.error("ORRAX image route error:", error);

    return res.status(503).json({
      code: "IMAGE_UNAVAILABLE",
      error: "Image generation is temporarily unavailable."
    });
  }
}
