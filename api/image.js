/* ORRAX /api/image
 * Server-only image router.
 * - 6 successful image generations per user per UTC day.
 * - Google users use verified Google ID-token `sub` (or the orrax_session cookie).
 * - Anonymous users use browser id + IP hash.
 * - No reference image: xKiro free image model -> xKiro backup key -> Gemini image fallback.
 * - With reference image(s) (edit / "make this realistic"): Gemini multimodal image generation.
 * - Prompts are wrapped in a strong photorealism instruction.
 * - Provider errors/keys/models are never returned to the browser.
 */

import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const DAILY_IMAGE_LIMIT = 6;

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

/* If GEMINI_IMAGE_MODEL is set in Vercel it is always respected. */
const GEMINI_IMAGE_MODEL_ENV =
  process.env.GEMINI_IMAGE_MODEL || "";

const GEMINI_IMAGE_MODEL_DEFAULTS = [
  "gemini-nano-banana-2.1",
  "gemini-3.1-flash-image"
];

const XKIRO_KEYS = [
  process.env.XKIRO_API_KEY,
  process.env.XKIRO_API_KEY_2
].filter(Boolean);

const XKIRO_FREE_IMAGE_MODEL =
  "sensenova/sensenova-u1.5-lite";

/* Reference-image limits */
const MAX_REFERENCES = 3;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 15 * 1024 * 1024;

class AttachmentError extends Error {}


function corsHeaders(origin = "") {

  const allowed = new Set([
    "https://zane-beep.github.io",
    "https://orrax.vercel.app"
  ]);

  return {

    "Access-Control-Allow-Origin":
      allowed.has(origin)
        ? origin
        : "https://zane-beep.github.io",

    "Access-Control-Allow-Methods":
      "POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-ORRAX-CLIENT-ID",

    "Access-Control-Allow-Credentials":
      "true",

    "Vary":
      "Origin",

    "Cache-Control":
      "no-store"
  };
}


function sha256(value) {

  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}


/* =========================================================
   PHOTOREALISTIC PROMPT BUILDER
========================================================= */

/* If the user explicitly names an art style, respect it. */
const EXPLICIT_STYLE_RE =
  /\b(cartoon|anime|manga|comic|sketch|watercolou?r|oil painting|pixel art|vector|logo|icon|illustration|3d render|clay|low[- ]poly)\b|কার্টুন|অ্যানিমে|স্কেচ|ইলাস্ট্রেশন/i;

function cleanUserPrompt(value) {

  return String(value || "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/"/g, "'")
    .trim()
    .slice(0, 1500);
}

function buildRealisticPrompt(
  userPrompt,
  hasReference
) {

  const request =
    cleanUserPrompt(userPrompt);

  if (EXPLICIT_STYLE_RE.test(request)) {

    return `${request}\n\nHigh quality, accurate anatomy, clean details, no distorted hands or faces.`;
  }

  const lines = [];

  if (hasReference) {

    lines.push(
      "Use the attached reference image(s) as the source. Keep the subject's identity, pose and composition unless the request asks to change them. Apply the request below and make the final result fully photorealistic."
    );
  }

  lines.push(
    "Create a FULLY PHOTOREALISTIC, lifelike photograph. The result must look like a real photo taken with a professional camera, not an artwork or a render."
  );

  lines.push(
    `User request (it may be written in any language): "${request}"`
  );

  lines.push(
    "Photographic requirements: natural lighting; realistic shadows; realistic reflections; realistic depth of field and perspective; realistic skin with natural pores and texture; realistic hair; realistic eyes; realistic hands with correct fingers; realistic clothing fabric and folds; accurate anatomy and proportions; realistic materials and textures; natural photographic colors; realistic exposure and contrast; believable environmental details; subtle natural imperfections; professional camera appearance; real-world photographic quality."
  );

  lines.push(
    "Do NOT produce: cartoon, anime, manga, illustration, painting, sketch, comic, vector art, clay, toy-like or plastic-looking surfaces, low-poly, artificial CGI look, or a 3D-rendered look."
  );

  return lines.join("\n\n");
}


/* =========================================================
   REFERENCE IMAGES (uploaded by the user)
========================================================= */

const EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif"
};

function safeName(value) {

  return String(value || "image")
    .replace(/[\u0000-\u001f<>"`]/g, "")
    .slice(0, 120) || "image";
}

function resolveMime(name, given) {

  const mime =
    String(given || "").toLowerCase().split(";")[0].trim();

  if (mime && mime !== "application/octet-stream") {
    return mime;
  }

  const ext =
    (String(name).split(".").pop() || "").toLowerCase();

  return EXT_MIME[ext] || "";
}

function decodeBase64Payload(raw) {

  let data = String(raw || "");

  const prefix = data.match(/^data:[^;,]*;base64,/i);
  if (prefix) {
    data = data.slice(prefix[0].length);
  }

  data = data.replace(/\s+/g, "");

  if (
    !data ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  ) {
    throw new AttachmentError(
      "An attachment is damaged and could not be read."
    );
  }

  const padding =
    data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return {
    base64: data,
    bytes: Math.floor((data.length * 3) / 4) - padding
  };
}

function parseReferenceImages(rawList) {

  if (rawList === undefined || rawList === null) {
    return [];
  }

  if (!Array.isArray(rawList)) {
    throw new AttachmentError("Attachments are not valid.");
  }

  if (rawList.length > MAX_REFERENCES) {
    throw new AttachmentError(
      `You can use up to ${MAX_REFERENCES} reference images.`
    );
  }

  const parts = [];
  let total = 0;

  for (const raw of rawList) {

    if (!raw || typeof raw !== "object") {
      throw new AttachmentError("Attachments are not valid.");
    }

    const name = safeName(raw.name);
    const mime = resolveMime(name, raw.mimeType || raw.type);

    if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(mime)) {
      throw new AttachmentError(
        `"${name}": only PNG, JPEG, WEBP, HEIC or HEIF images can be used for image generation.`
      );
    }

    const { base64, bytes } =
      decodeBase64Payload(raw.data);

    if (bytes > MAX_REFERENCE_BYTES) {
      throw new AttachmentError(
        `"${name}" is larger than 12 MB.`
      );
    }

    total += bytes;

    if (total > MAX_TOTAL_REFERENCE_BYTES) {
      throw new AttachmentError(
        "The reference images are too large in total."
      );
    }

    parts.push({
      type: "image",
      data: base64,
      mime_type: mime
    });
  }

  return parts;
}


/* =========================================================
   REDIS
========================================================= */

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


async function redisCommand(
  command,
  args = []
) {

  const {
    url,
    token
  } = getRedisConfig();

  if (!url || !token) {
    throw new Error(
      "REDIS_NOT_CONFIGURED"
    );
  }

  const path =
    [command, ...args]
      .map(value =>
        encodeURIComponent(
          String(value)
        )
      )
      .join("/");

  const response =
    await fetch(
      `${url}/${path}`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `REDIS_HTTP_${response.status}`
    );
  }

  const data =
    await response.json();

  return data?.result;
}


function utcDayKey() {

  return new Date()
    .toISOString()
    .slice(0, 10);
}


async function reserveImage(
  userKey
) {

  const key =
    `orrax:image:${utcDayKey()}:${userKey}`;

  const count =
    Number(
      await redisCommand(
        "incr",
        [key]
      )
    );

  if (count === 1) {

    const tomorrow =
      new Date();

    tomorrow.setUTCHours(
      24,
      0,
      0,
      0
    );

    await redisCommand(
      "expireat",
      [
        key,
        Math.floor(
          tomorrow.getTime() / 1000
        )
      ]
    );
  }

  if (
    count >
    DAILY_IMAGE_LIMIT
  ) {

    await redisCommand(
      "decr",
      [key]
    ).catch(() => {});

    return {
      allowed: false,
      key
    };
  }

  return {
    allowed: true,
    key
  };
}


async function releaseImage(
  key
) {

  if (!key) return;

  await redisCommand(
    "decr",
    [key]
  ).catch(() => {});
}


async function identifyUser(
  req
) {

  /*
   * First try the ORRAX Google session cookie.
   */

  const cookieHeader =
    String(
      req.headers.cookie || ""
    );

  const sessionMatch =
    cookieHeader.match(
      /(?:^|;\s*)orrax_session=([^;]+)/
    );

  const sessionToken =
    sessionMatch
      ? decodeURIComponent(
          sessionMatch[1]
        )
      : "";

  if (sessionToken) {

    try {

      const rawSession =
        await redisCommand(
          "get",
          [
            `orrax:session:${sessionToken}`
          ]
        );

      if (rawSession) {

        const session =
          typeof rawSession === "string"
            ? JSON.parse(rawSession)
            : rawSession;

        if (session?.sub) {

          return `google:${sha256(
            session.sub
          )}`;
        }
      }

    } catch (error) {

      console.warn(
        "ORRAX session verification failed"
      );
    }
  }


  /*
   * Fallback:
   * Google ID token sent by frontend.
   */

  const auth =
    String(
      req.headers.authorization || ""
    );

  const bearer =
    auth.startsWith("Bearer ")
      ? auth.slice(7).trim()
      : "";

  if (
    bearer &&
    GOOGLE_CLIENT_ID
  ) {

    try {

      const client =
        new OAuth2Client(
          GOOGLE_CLIENT_ID
        );

      const ticket =
        await client.verifyIdToken({
          idToken: bearer,
          audience:
            GOOGLE_CLIENT_ID
        });

      const payload =
        ticket.getPayload();

      if (payload?.sub) {

        return `google:${sha256(
          payload.sub
        )}`;
      }

    } catch (error) {

      console.warn(
        "ORRAX Google identity verification failed"
      );
    }
  }


  /*
   * Anonymous user.
   */

  const browserId =
    String(
      req.headers[
        "x-orrax-client-id"
      ] || ""
    ).trim();

  const ip =
    String(
      req.headers[
        "x-forwarded-for"
      ] ||
      req.headers[
        "x-real-ip"
      ] ||
      req.socket?.remoteAddress ||
      "unknown"
    )
      .split(",")[0]
      .trim();

  return `anon:${sha256(
    `${browserId || "no-browser-id"}|${ip}`
  )}`;
}


async function fetchJson(
  url,
  options
) {

  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response
      .json()
      .catch(() => ({}));

  if (!response.ok) {

    const error =
      new Error(
        data?.error?.message ||
        data?.error ||
        `HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}


async function getXKiroImageModel(
  key
) {

  try {

    const data =
      await fetchJson(
        "https://api.xkiro.com/v1/models?modality=image",
        {
          headers: {
            Authorization:
              `Bearer ${key}`
          }
        }
      );

    const models =
      Array.isArray(
        data?.data
      )
        ? data.data
        : [];

    const preferred =
      models.find(
        model =>
          model?.id ===
            XKIRO_FREE_IMAGE_MODEL &&
          model?.access_tier ===
            "free"
      );

    if (preferred?.id) {
      return preferred.id;
    }

    const free =
      models.find(
        model =>
          model?.access_tier ===
          "free"
      );

    return (
      free?.id ||
      XKIRO_FREE_IMAGE_MODEL
    );

  } catch (error) {

    return XKIRO_FREE_IMAGE_MODEL;
  }
}


async function generateWithXKiro(
  key,
  prompt
) {

  if (!key) {
    throw new Error(
      "NO_XKIRO_KEY"
    );
  }

  const model =
    await getXKiroImageModel(
      key
    );

  const job =
    await fetchJson(
      "https://api.xkiro.com/v1/images/generations",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${key}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            model,
            prompt,
            n: 1,
            size: "1024x1024"
          })
      }
    );

  if (!job?.id) {

    throw new Error(
      "XKIRO_NO_JOB_ID"
    );
  }

  const deadline =
    Date.now() + 240_000;

  let waitMs = 2000;


  while (
    Date.now() <
    deadline
  ) {

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          waitMs
        )
    );

    waitMs =
      Math.min(
        Math.round(
          waitMs * 1.5
        ),
        8000
      );


    const status =
      await fetchJson(
        `https://api.xkiro.com/v1/images/generations/${encodeURIComponent(
          job.id
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${key}`
          }
        }
      );


    if (
      status?.status ===
      "succeeded"
    ) {

      const url =
        status?.data?.[0]?.url;

      if (!url) {

        throw new Error(
          "XKIRO_EMPTY_IMAGE_URL"
        );
      }

      return url;
    }


    if (
      status?.status ===
        "failed" ||
      status?.status ===
        "blocked"
    ) {

      throw new Error(
        "XKIRO_IMAGE_FAILED"
      );
    }
  }


  throw new Error(
    "XKIRO_IMAGE_TIMEOUT"
  );
}


function extractGeminiImage(
  data
) {

  const direct =
    data?.output_image;

  if (direct?.data) {

    return {

      url:
        `data:${
          direct.mime_type ||
          "image/png"
        };base64,${
          direct.data
        }`,

      mimeType:
        direct.mime_type ||
        "image/png"
    };
  }


  const steps =
    Array.isArray(
      data?.steps
    )
      ? data.steps
      : [];


  for (
    const step of steps
  ) {

    const parts =
      Array.isArray(
        step?.content
      )
        ? step.content
        : [];


    for (
      const part of parts
    ) {

      const image =
        part?.image ||
        part?.inline_data ||
        part?.inlineData ||
        (
          part?.type === "image" &&
          part?.data
            ? part
            : null
        );


      if (image?.data) {

        return {

          url:
            `data:${
              image.mime_type ||
              image.mimeType ||
              "image/png"
            };base64,${
              image.data
            }`,

          mimeType:
            image.mime_type ||
            image.mimeType ||
            "image/png"
        };
      }
    }
  }


  return null;
}


/*
 * Gemini Interactions API.
 * Text-to-image: input is a string.
 * Reference / edit: input is [{type:"text"}, {type:"image", data, mime_type}, ...]
 */

async function generateWithGemini(
  prompt,
  references = []
) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "NO_GEMINI_KEY"
    );
  }

  const models =
    GEMINI_IMAGE_MODEL_ENV
      ? [GEMINI_IMAGE_MODEL_ENV]
      : GEMINI_IMAGE_MODEL_DEFAULTS;

  const input =
    references.length
      ? [
          {
            type: "text",
            text: prompt
          },
          ...references
        ]
      : prompt;

  const responseFormat =
    references.length
      ? {
          type: "image",
          mime_type: "image/png"
        }
      : {
          type: "image",
          mime_type: "image/png",
          aspect_ratio: "1:1",
          image_size: "1K"
        };

  let lastError = null;

  for (const model of models) {

    try {

      const data =
        await fetchJson(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          {
            method: "POST",

            headers: {

              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY
            },

            body:
              JSON.stringify({

                model,

                input,

                response_format:
                  responseFormat,

                store:
                  false
              })
          }
        );

      const image =
        extractGeminiImage(
          data
        );

      if (image?.url) {
        return image.url;
      }

      lastError =
        new Error(
          "GEMINI_EMPTY_IMAGE"
        );

    } catch (error) {

      lastError =
        error;

      console.warn(
        "ORRAX Gemini image model attempt failed",
        error?.status ||
        error?.message ||
        "unknown"
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "GEMINI_EMPTY_IMAGE"
    )
  );
}


export default async function handler(
  req,
  res
) {

  const origin =
    req.headers.origin || "";


  Object.entries(
    corsHeaders(origin)
  ).forEach(
    ([key, value]) => {

      res.setHeader(
        key,
        value
      );
    }
  );


  if (
    req.method ===
    "OPTIONS"
  ) {

    return res
      .status(204)
      .end();
  }


  if (
    req.method !==
    "POST"
  ) {

    return res
      .status(405)
      .json({
        error:
          "Method not allowed."
      });
  }


  try {

    const rawPrompt =
      String(
        req.body?.prompt ||
        ""
      ).trim();


    if (!rawPrompt) {

      return res
        .status(400)
        .json({
          error:
            "A valid image prompt is required."
        });
    }


    /* Validate reference images BEFORE any quota is used. */

    let references = [];

    try {

      references =
        parseReferenceImages(
          req.body?.attachments
        );

    } catch (error) {

      return res
        .status(400)
        .json({

          code:
            "INVALID_ATTACHMENT",

          error:
            error instanceof AttachmentError
              ? error.message
              : "The attachment could not be processed."
        });
    }


    const prompt =
      buildRealisticPrompt(
        rawPrompt,
        references.length > 0
      );


    const userKey =
      await identifyUser(
        req
      );


    const reservation =
      await reserveImage(
        userKey
      );


    if (
      !reservation.allowed
    ) {

      return res
        .status(429)
        .json({

          code:
            "DAILY_IMAGE_LIMIT",

          error:
            "Daily image limit reached."
        });
    }


    let generatedUrl = "";


    try {

      /*
       * xKiro primary image provider.
       * Skipped when the user sent reference images
       * (xKiro image input support is not assumed).
       */

      if (
        references.length === 0
      ) {

        for (
          const key of XKIRO_KEYS
        ) {

          try {

            generatedUrl =
              await generateWithXKiro(
                key,
                prompt
              );

            if (
              generatedUrl
            ) {
              break;
            }

          } catch (error) {

            console.warn(
              "ORRAX xKiro image attempt failed"
            );
          }
        }
      }


      /*
       * Gemini: fallback for plain prompts,
       * primary for reference / edit requests.
       */

      if (
        !generatedUrl
      ) {

        try {

          generatedUrl =
            await generateWithGemini(
              prompt,
              references
            );

        } catch (error) {

          console.warn(
            "ORRAX Gemini image fallback failed"
          );
        }
      }


      /*
       * Nothing worked.
       */

      if (
        !generatedUrl
      ) {

        await releaseImage(
          reservation.key
        );

        return res
          .status(503)
          .json({

            code:
              "IMAGE_UNAVAILABLE",

            error:
              "Image generation is temporarily unavailable."
          });
      }


      /*
       * Success.
       */

      return res
        .status(200)
        .json({

          imageDataUrl:
            generatedUrl
        });


    } catch (error) {

      await releaseImage(
        reservation.key
      );

      return res
        .status(503)
        .json({

          code:
            "IMAGE_UNAVAILABLE",

          error:
            "Image generation is temporarily unavailable."
        });
    }


  } catch (error) {

    console.error(
      "ORRAX image route error:",
      error?.message ||
      error
    );

    return res
      .status(503)
      .json({

        code:
          "IMAGE_UNAVAILABLE",

        error:
          "Image generation is temporarily unavailable."
      });
  }
}
