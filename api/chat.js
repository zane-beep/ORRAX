/* ORRAX /api/chat
 * Server-only AI router.
 * - 26 successful text replies per user per UTC day.
 * - Google users are identified by verified Google ID-token `sub`.
 * - Google redirect sessions are identified by secure Redis-backed cookie.
 * - Anonymous users use a server-scoped browser id + IP hash.
 * - Gemini -> xKiro key 1 -> xKiro key 2 -> Dahl -> OpenRouter free -> optional paid fallbacks.
 * - Technical provider errors are never returned to the browser.
 */

import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const DAILY_LIMIT = 26;

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "";

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
  process.env.GEMINI_TEXT_MODEL ||
  "gemini-3.8-flash";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || "";

const GROQ_API_KEY =
  process.env.GROQ_API_KEY || "";

const DAHL_API_KEY =
  process.env.DAHL_API_KEY || "";

const XKIRO_KEYS = [
  process.env.XKIRO_API_KEY,
  process.env.XKIRO_API_KEY_2
].filter(Boolean);

const ENABLE_PAID_FALLBACKS =
  process.env.ENABLE_PAID_FALLBACKS === "true";


const SYSTEM_INSTRUCTION = `
You are ORRAX, created by KHAN SAHEB.

LANGUAGE RULE — STRICT:
1. Reply entirely in the language used by the user.
2. Bengali input -> Bengali response.
3. English input -> English response.
4. Do not mix Bengali and English unless the user explicitly mixes languages.
5. For mixed-language input, use the clearly dominant language.
6. Never switch language because a technical term has an English equivalent.

STYLE:
- Be accurate, helpful and concise.
- Prefer short, useful answers unless the user asks for depth.
- Do not pad answers with repeated explanations.
- For code, provide complete working code when requested.
- Never reveal server keys, internal routing, quota implementation, or provider errors.
- Never claim to have used a tool or capability you did not actually use.
`;


/* =========================================================
   CORS
========================================================= */

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


/* =========================================================
   HASH
========================================================= */

function sha256(value) {

  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
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

    url:
      url.replace(/\/+$/, ""),

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
  } =
    getRedisConfig();

  if (!url || !token) {

    throw new Error(
      "REDIS_NOT_CONFIGURED"
    );
  }

  const path = [
    command,
    ...args
  ]
    .map(v =>
      encodeURIComponent(
        String(v)
      )
    )
    .join("/");

  const response =
    await fetch(
      `${url}/${path}`,
      {
        method:
          "POST",

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


async function reserveDailyReply(
  userKey
) {

  const key =
    `orrax:daily:${utcDayKey()}:${userKey}`;

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
          tomorrow.getTime() /
          1000
        )
      ]
    );
  }

  if (count > DAILY_LIMIT) {

    await redisCommand(
      "decr",
      [key]
    ).catch(() => {});

    return {

      allowed:
        false,

      key,

      count:
        DAILY_LIMIT
    };
  }

  return {

    allowed:
      true,

    key,

    count
  };
}


async function releaseDailyReply(
  key
) {

  await redisCommand(
    "decr",
    [key]
  ).catch(() => {});
}


/* =========================================================
   USER IDENTITY
========================================================= */

async function identifyUser(req) {

  /* =====================================================
     GOOGLE REDIRECT SESSION COOKIE
  ===================================================== */

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


  /* =====================================================
     EXISTING GOOGLE BEARER TOKEN
  ===================================================== */

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

          idToken:
            bearer,

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


  /* =====================================================
     ANONYMOUS USER
  ===================================================== */

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

  const stablePart =
    browserId ||
    "no-browser-id";

  return `anon:${sha256(
    `${stablePart}|${ip}`
  )}`;
}


/* =========================================================
   MESSAGE BUILDERS
========================================================= */

function buildMessages(
  prompt,
  history
) {

  const safeHistory =
    Array.isArray(history)
      ? history
          .filter(item =>
            item &&
            (
              item.role === "user" ||
              item.role === "model"
            ) &&
            Array.isArray(
              item.parts
            ) &&
            item.parts.some(
              part =>
                typeof part?.text ===
                "string"
            )
          )
          .slice(-12)
      : [];

  const messages =
    safeHistory
      .map(item => ({

        role:
          item.role === "model"
            ? "assistant"
            : "user",

        content:
          item.parts
            .filter(
              part =>
                typeof part?.text ===
                "string"
            )
            .map(
              part =>
                part.text
            )
            .join("\n")
            .trim()

      }))
      .filter(
        item =>
          item.content
      );

  messages.push({

    role:
      "user",

    content:
      prompt.trim()

  });

  return messages;
}


function buildTranscript(
  prompt,
  history
) {

  return buildMessages(
    prompt,
    history
  )
    .map(item =>
      `${
        item.role === "assistant"
          ? "ORRAX"
          : "USER"
      }: ${item.content}`
    )
    .join("\n\n");
}


function extractOpenAIText(
  data
) {

  return (
    data
      ?.choices?.[0]
      ?.message?.content
      ?.trim() ||
    ""
  );
}


function extractGeminiText(
  data
) {

  if (
    typeof data?.output_text ===
      "string" &&
    data.output_text.trim()
  ) {

    return data
      .output_text
      .trim();
  }

  const steps =
    Array.isArray(data?.steps)
      ? data.steps
      : [];

  return steps
    .filter(
      step =>
        step?.type ===
          "model_output" &&
        Array.isArray(
          step?.content
        )
    )
    .flatMap(
      step =>
        step.content
    )
    .filter(
      part =>
        typeof part?.text ===
        "string"
    )
    .map(
      part =>
        part.text
    )
    .join("")
    .trim();
}


/* =========================================================
   FETCH / RETRY
========================================================= */

function retryable(status) {

  return [

    408,
    409,
    425,
    429,
    500,
    502,
    503,
    504

  ].includes(
    Number(status)
  );
}


async function fetchJson(
  url,
  options,
  attempts = 2
) {

  let lastError =
    null;

  for (
    let attempt = 0;
    attempt < attempts;
    attempt++
  ) {

    try {

      const response =
        await fetch(
          url,
          options
        );

      const data =
        await response
          .json()
          .catch(
            () => ({})
          );

      if (response.ok) {

        return {

          response,

          data

        };
      }

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

      if (
        !retryable(
          response.status
        ) ||
        attempt ===
          attempts - 1
      ) {

        throw error;
      }

      const retryAfter =
        Number(
          response.headers.get(
            "retry-after"
          )
        );

      const waitMs =
        Number.isFinite(
          retryAfter
        ) &&
        retryAfter > 0

          ? Math.min(
              retryAfter * 1000,
              5000
            )

          : 500 *
            2 ** attempt;

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );

      lastError =
        error;

    } catch (error) {

      lastError =
        error;

      if (
        attempt ===
          attempts - 1 ||
        !retryable(
          error?.status
        )
      ) {

        throw error;
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500 *
            2 ** attempt
          )
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Provider failed"
    )
  );
}


/* =========================================================
   GEMINI
========================================================= */

async function callGemini(
  prompt,
  history
) {

  if (!GEMINI_API_KEY) {

    throw new Error(
      "NO_GEMINI_KEY"
    );
  }

  const { data } =
    await fetchJson(

      "https://generativelanguage.googleapis.com/v1beta/interactions",

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          "x-goog-api-key":
            GEMINI_API_KEY

        },

        body:
          JSON.stringify({

            model:
              GEMINI_MODEL,

            input:
              buildTranscript(
                prompt,
                history
              ),

            system_instruction:
              SYSTEM_INSTRUCTION,

            generation_config: {

              thinking_level:
                "low"

            },

            store:
              false

          })

      },

      2
    );

  const text =
    extractGeminiText(
      data
    );

  if (!text) {

    throw new Error(
      "EMPTY_GEMINI_RESPONSE"
    );
  }

  return text;
}


/* =========================================================
   XKIRO
========================================================= */

async function callXKiro(
  key,
  prompt,
  history
) {

  if (!key) {

    throw new Error(
      "NO_XKIRO_KEY"
    );
  }

  let model =
    process.env.XKIRO_MODEL ||
    "";

  if (!model) {

    const modelsResponse =
      await fetch(
        "https://api.xkiro.com/v1/models",
        {

          headers: {

            Authorization:
              `Bearer ${key}`

          }

        }
      );

    if (!modelsResponse.ok) {

      throw new Error(
        `XKIRO_MODELS_${modelsResponse.status}`
      );
    }

    const catalog =
      await modelsResponse.json();

    const models =
      Array.isArray(
        catalog?.data
      )
        ? catalog.data
        : [];

    const free =
      models.find(
        item =>
          item?.access_tier ===
          "free"
      ) ||
      models.find(
        item =>
          item?.id
      );

    if (!free?.id) {

      throw new Error(
        "NO_XKIRO_MODEL"
      );
    }

    model =
      free.id;
  }


  const { data } =
    await fetchJson(

      "https://api.xkiro.com/v1/chat/completions",

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${key}`

        },

        body:
          JSON.stringify({

            model,

            messages: [

              {

                role:
                  "system",

                content:
                  SYSTEM_INSTRUCTION

              },

              ...buildMessages(
                prompt,
                history
              )

            ],

            max_tokens:
              900,

            temperature:
              0.6

          })

      },

      2
    );

  const text =
    extractOpenAIText(
      data
    );

  if (!text) {

    throw new Error(
      "EMPTY_XKIRO_RESPONSE"
    );
  }

  return text;
}


/* =========================================================
   DAHL
========================================================= */

async function callDahl(
  prompt,
  history
) {

  if (!DAHL_API_KEY) {

    throw new Error(
      "NO_DAHL_KEY"
    );
  }

  const model =
    process.env.DAHL_MODEL ||
    "MiniMaxAI/MiniMax-M2.7";

  const { data } =
    await fetchJson(

      "https://inference.dahl.global/v1/chat/completions",

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${DAHL_API_KEY}`

        },

        body:
          JSON.stringify({

            model,

            messages: [

              {

                role:
                  "system",

                content:
                  SYSTEM_INSTRUCTION

              },

              ...buildMessages(
                prompt,
                history
              )

            ],

            max_tokens:
              900,

            temperature:
              0.6

          })

      },

      2
    );

  const text =
    extractOpenAIText(
      data
    );

  if (!text) {

    throw new Error(
      "EMPTY_DAHL_RESPONSE"
    );
  }

  return text;
}


/* =========================================================
   OPENROUTER
========================================================= */

async function callOpenRouter(
  prompt,
  history
) {

  if (!OPENROUTER_API_KEY) {

    throw new Error(
      "NO_OPENROUTER_KEY"
    );
  }

  const { data } =
    await fetchJson(

      "https://openrouter.ai/api/v1/chat/completions",

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${OPENROUTER_API_KEY}`,

          "HTTP-Referer":
            "https://zane-beep.github.io/ORRAX",

          "X-Title":
            "ORRAX"

        },

        body:
          JSON.stringify({

            model:
              "openrouter/free",

            messages: [

              {

                role:
                  "system",

                content:
                  SYSTEM_INSTRUCTION

              },

              ...buildMessages(
                prompt,
                history
              )

            ],

            max_tokens:
              900,

            temperature:
              0.6

          })

      },

      2
    );

  const text =
    extractOpenAIText(
      data
    );

  if (!text) {

    throw new Error(
      "EMPTY_OPENROUTER_RESPONSE"
    );
  }

  return text;
}


/* =========================================================
   GROQ
========================================================= */

async function callGroq(
  prompt,
  history
) {

  if (!GROQ_API_KEY) {

    throw new Error(
      "NO_GROQ_KEY"
    );
  }

  const model =
    process.env.GROQ_MODEL ||
    "openai/gpt-oss-20b";

  const { data } =
    await fetchJson(

      "https://api.groq.com/openai/v1/chat/completions",

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${GROQ_API_KEY}`

        },

        body:
          JSON.stringify({

            model,

            messages: [

              {

                role:
                  "system",

                content:
                  SYSTEM_INSTRUCTION

              },

              ...buildMessages(
                prompt,
                history
              )

            ],

            max_tokens:
              900,

            temperature:
              0.6

          })

      },

      2
    );

  const text =
    extractOpenAIText(
      data
    );

  if (!text) {

    throw new Error(
      "EMPTY_GROQ_RESPONSE"
    );
  }

  return text;
}


/* =========================================================
   MAIN HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {

  const origin =
    req.headers.origin ||
    "";

  for (
    const [key, value]
    of Object.entries(
      corsHeaders(origin)
    )
  ) {

    res.setHeader(
      key,
      value
    );
  }


  /* =====================================================
     PREFLIGHT
  ===================================================== */

  if (
    req.method ===
    "OPTIONS"
  ) {

    return res
      .status(204)
      .end();
  }


  /* =====================================================
     METHOD
  ===================================================== */

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


  /* =====================================================
     BODY
  ===================================================== */

  const {
    prompt,
    history
  } =
    req.body || {};


  if (
    typeof prompt !==
      "string" ||
    !prompt.trim()
  ) {

    return res
      .status(400)
      .json({

        error:
          "A valid prompt is required."

      });
  }


  let reservation =
    null;


  try {

    /* ===================================================
       IDENTIFY USER
    =================================================== */

    const userKey =
      await identifyUser(
        req
      );


    /* ===================================================
       RESERVE DAILY SLOT
    =================================================== */

    reservation =
      await reserveDailyReply(
        userKey
      );


    if (
      !reservation.allowed
    ) {

      return res
        .status(429)
        .json({

          code:
            "DAILY_LIMIT",

          error:
            "FREE_DAILY_LIMIT"

        });
    }


    /* ===================================================
       PROVIDERS
    =================================================== */

    const providers = [

      [

        "gemini",

        () =>
          callGemini(
            prompt,
            history
          )

      ],

      [

        "xkiro-1",

        () =>
          callXKiro(
            XKIRO_KEYS[0],
            prompt,
            history
          )

      ],

      [

        "xkiro-2",

        () =>
          callXKiro(
            XKIRO_KEYS[1],
            prompt,
            history
          )

      ],

      [

        "dahl",

        () =>
          callDahl(
            prompt,
            history
          )

      ],

      [

        "openrouter",

        () =>
          callOpenRouter(
            prompt,
            history
          )

      ]

    ];


    if (
      ENABLE_PAID_FALLBACKS
    ) {

      providers.push([

        "groq",

        () =>
          callGroq(
            prompt,
            history
          )

      ]);
    }


    /* ===================================================
       PROVIDER LOOP
    =================================================== */

    for (
      const [name, call]
      of providers
    ) {

      try {

        const text =
          await call();

        console.info(
          `ORRAX provider success: ${name}`
        );

        return res
          .status(200)
          .json({

            text

          });

      } catch (error) {

        console.warn(

          `ORRAX provider failed: ${name}`,

          error?.status ||
          error?.message ||
          "unknown"

        );
      }
    }


    /* ===================================================
       NO PROVIDER
       DO NOT CONSUME DAILY SLOT
    =================================================== */

    await releaseDailyReply(
      reservation.key
    );

    reservation =
      null;


    return res
      .status(503)
      .json({

        code:
          "TEMPORARILY_UNAVAILABLE",

        error:
          "AI_TEMPORARILY_UNAVAILABLE"

      });


  } catch (error) {

    console.error(

      "ORRAX chat route error:",

      error?.message ||
      error

    );


    if (
      reservation?.key
    ) {

      await releaseDailyReply(
        reservation.key
      );
    }


    return res
      .status(503)
      .json({

        code:
          "TEMPORARILY_UNAVAILABLE",

        error:
          "AI_TEMPORARILY_UNAVAILABLE"

      });
  }
}
