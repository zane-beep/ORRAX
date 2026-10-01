/* =========================================================
   ORRAX /api/chat
   SERVER-SIDE AI ROUTER

   Flow:
   Gemini
      ↓
   xKiro Key 1
      ↓
   xKiro Key 2
      ↓
   Dahl
      ↓
   OpenRouter Free
      ↓
   Groq (ONLY if ENABLE_PAID_FALLBACKS=true)

   Fair-use:
   26 successful replies / user / UTC day

   IMPORTANT:
   XKIRO_API_KEY and XKIRO_API_KEY_2 may belong to
   the same xKiro account. They are fallback keys,
   NOT two separate quotas.
========================================================= */

import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";


/* =========================================================
   CONFIG
========================================================= */

const DAILY_LIMIT = 26;

const GOOGLE_CLIENT_ID =
    process.env.GOOGLE_CLIENT_ID || "";

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
    process.env.GEMINI_TEXT_MODEL ||
    "gemini-3.8-flash";

const XKIRO_KEY_1 =
    process.env.XKIRO_API_KEY || "";

const XKIRO_KEY_2 =
    process.env.XKIRO_API_KEY_2 || "";

const DAHL_API_KEY =
    process.env.DAHL_API_KEY || "";

const OPENROUTER_API_KEY =
    process.env.OPENROUTER_API_KEY || "";

const GROQ_API_KEY =
    process.env.GROQ_API_KEY || "";

const XKIRO_MODEL =
    process.env.XKIRO_MODEL || "";

const DAHL_MODEL =
    process.env.DAHL_MODEL ||
    "MiniMaxAI/MiniMax-M2.7";

const GROQ_MODEL =
    process.env.GROQ_MODEL ||
    "openai/gpt-oss-20b";

/*
   Keep false unless you deliberately want a paid
   fallback provider.
*/
const ENABLE_PAID_FALLBACKS =
    process.env.ENABLE_PAID_FALLBACKS === "true";


/* =========================================================
   ORRAX SYSTEM INSTRUCTION
========================================================= */

const SYSTEM_INSTRUCTION = `
You are ORRAX, created by KHAN SAHEB.

LANGUAGE RULE:
- Reply in the same language as the user.
- Bengali input -> Bengali response.
- English input -> English response.
- Do not unnecessarily mix Bengali and English.
- If the user mixes languages, follow the dominant language.

STYLE:
- Be helpful and accurate.
- Keep normal answers reasonably short.
- Do not unnecessarily write very long explanations.
- Give more detail when the user asks for detail.
- For code requests, provide complete working code.
- Do not reveal API keys.
- Do not reveal provider names or internal routing.
- Do not reveal quota implementation.
- Do not reveal internal server errors.
`;


/* =========================================================
   CORS
========================================================= */

function corsHeaders(origin = "") {

    const allowedOrigins = new Set([
        "https://zane-beep.github.io",
        "https://orrax.vercel.app"
    ]);

    return {
        "Access-Control-Allow-Origin":
            allowedOrigins.has(origin)
                ? origin
                : "https://zane-beep.github.io",

        "Access-Control-Allow-Methods":
            "POST, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-ORRAX-CLIENT-ID",

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
   REDIS / UPSTASH
========================================================= */

function getRedisConfig() {

    const url =
        process.env.KV_REST_API_URL ||
        process.env.UPSTASH_REDIS_REST_URL ||
        "";

    const token =
        process.env.KV_REST_API_TOKEN ||
        process.env.UPSTASH_REDIS_REST_TOKEN ||
        "";

    return {
        url: url.replace(/\/+$/, ""),
        token
    };
}


async function redisCommand(command, args = []) {

    const {
        url,
        token
    } = getRedisConfig();

    if (!url || !token) {
        throw new Error("REDIS_NOT_CONFIGURED");
    }

    const path = [
        command,
        ...args
    ]
        .map(value =>
            encodeURIComponent(String(value))
        )
        .join("/");

    const response = await fetch(
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


/* =========================================================
   DAILY KEY
========================================================= */

function utcDayKey() {

    return new Date()
        .toISOString()
        .slice(0, 10);
}


/* =========================================================
   RESERVE ONE REPLY SLOT
========================================================= */

async function reserveDailyReply(userKey) {

    const key =
        `orrax:daily:${utcDayKey()}:${userKey}`;

    const count =
        Number(
            await redisCommand(
                "incr",
                [key]
            )
        );

    /*
       Set expiry when the key is created.
    */

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

    /*
       User has reached the daily limit.
    */

    if (count > DAILY_LIMIT) {

        await redisCommand(
            "decr",
            [key]
        ).catch(() => {});

        return {
            allowed: false,
            key,
            count: DAILY_LIMIT
        };
    }

    return {
        allowed: true,
        key,
        count
    };
}


/* =========================================================
   RELEASE SLOT
   If every AI provider fails, the user should NOT
   lose one of their 26 replies.
========================================================= */

async function releaseDailyReply(key) {

    await redisCommand(
        "decr",
        [key]
    ).catch(() => {});
}


/* =========================================================
   IDENTIFY USER
========================================================= */

async function identifyUser(req) {

    const authorization =
        String(
            req.headers.authorization || ""
        );

    const bearer =
        authorization.startsWith("Bearer ")
            ? authorization.slice(7).trim()
            : "";


    /*
       GOOGLE USER
    */

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

                return (
                    "google:" +
                    sha256(payload.sub)
                );
            }

        } catch (error) {

            console.warn(
                "ORRAX Google identity verification failed"
            );
        }
    }


    /*
       ANONYMOUS USER
    */

    const browserId =
        String(
            req.headers[
                "x-orrax-client-id"
            ] || ""
        ).trim();


    const forwardedIp =
        String(
            req.headers[
                "x-forwarded-for"
            ] ||
            req.headers[
                "x-real-ip"
            ] ||
            req.socket?.remoteAddress ||
            "unknown"
        );


    const ip =
        forwardedIp
            .split(",")[0]
            .trim();


    const stablePart =
        browserId ||
        "no-browser-id";


    return (
        "anon:" +
        sha256(
            `${stablePart}|${ip}`
        )
    );
}


/* =========================================================
   MESSAGE BUILDER
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
                    Array.isArray(item.parts) &&
                    item.parts.some(
                        part =>
                            typeof part?.text === "string"
                    )
                )
                .slice(-12)
            : [];


    const messages =
        safeHistory
            .map(item => {

                const content =
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
                        .trim();


                return {
                    role:
                        item.role === "model"
                            ? "assistant"
                            : "user",

                    content
                };
            })
            .filter(
                item =>
                    item.content
            );


    messages.push({
        role: "user",
        content: prompt.trim()
    });


    return messages;
}


/* =========================================================
   GEMINI TRANSCRIPT
========================================================= */

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


/* =========================================================
   RESPONSE EXTRACTORS
========================================================= */

function extractOpenAIText(data) {

    return (
        data?.choices?.[0]?.message?.content
            ?.trim() ||
        ""
    );
}


function extractGeminiText(data) {

    if (
        typeof data?.output_text ===
        "string" &&
        data.output_text.trim()
    ) {

        return data.output_text.trim();
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
   RETRYABLE STATUS
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


/* =========================================================
   GENERIC FETCH WITH BACKOFF
========================================================= */

async function fetchJson(
    url,
    options,
    attempts = 2
) {

    let lastError = null;


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


    const {
        data
    } = await fetchJson(
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
   XKIRO MODEL DISCOVERY
========================================================= */

async function getXKiroModel(key) {

    if (XKIRO_MODEL) {

        return XKIRO_MODEL;
    }


    const response =
        await fetch(
            "https://api.xkiro.com/v1/models",
            {
                headers: {
                    Authorization:
                        `Bearer ${key}`
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `XKIRO_MODELS_${response.status}`
        );
    }


    const catalog =
        await response.json();


    const models =
        Array.isArray(
            catalog?.data
        )
            ? catalog.data
            : [];


    /*
       Prefer an actually free model.
    */

    const freeModels =
        models.filter(
            model =>
                model?.access_tier ===
                "free"
        );


    if (freeModels.length) {

        return freeModels[0].id;
    }


    /*
       If catalog does not expose
       access_tier, use first model.
    */

    const fallback =
        models.find(
            model =>
                model?.id
        );


    if (!fallback?.id) {

        throw new Error(
            "NO_XKIRO_MODEL"
        );
    }


    return fallback.id;
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


    const model =
        await getXKiroModel(
            key
        );


    const {
        data
    } = await fetchJson(
        "https://api.xkiro.com/v1/chat/completions",
        {
            method: "POST",

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


    const {
        data
    } = await fetchJson(
        "https://inference.dahl.global/v1/chat/completions",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                Authorization:
                    `Bearer ${DAHL_API_KEY}`
            },

            body:
                JSON.stringify({

                    model:
                        DAHL_MODEL,

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
   OPENROUTER FREE
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


    const {
        data
    } = await fetchJson(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            method: "POST",

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


    const {
        data
    } = await fetchJson(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json",

                Authorization:
                    `Bearer ${GROQ_API_KEY}`
            },

            body:
                JSON.stringify({

                    model:
                        GROQ_MODEL,

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

    /*
       CORS
    */

    const origin =
        req.headers.origin || "";


    for (
        const [
            key,
            value
        ] of Object.entries(
            corsHeaders(origin)
        )
    ) {

        res.setHeader(
            key,
            value
        );
    }


    /*
       OPTIONS
    */

    if (
        req.method ===
        "OPTIONS"
    ) {

        return res
            .status(204)
            .end();
    }


    /*
       POST ONLY
    */

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


    /*
       INPUT
    */

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

        /*
           IDENTIFY USER
        */

        const userKey =
            await identifyUser(
                req
            );


        /*
           RESERVE ONE DAILY SLOT
        */

        reservation =
            await reserveDailyReply(
                userKey
            );


        /*
           USER HAS USED 26 REPLIES
        */

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


        /*
           PROVIDER FALLBACK CHAIN

           xKiro #1 and #2 are NOT
           treated as separate quotas.
        */

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
                        XKIRO_KEY_1,
                        prompt,
                        history
                    )
            ],

            [
                "xkiro-2",

                () =>
                    callXKiro(
                        XKIRO_KEY_2,
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


        /*
           OPTIONAL GROQ

           Only enabled manually.
        */

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


        /*
           TRY PROVIDERS ONE BY ONE
        */

        for (
            const [
                name,
                call
            ] of providers
        ) {

            try {

                const text =
                    await call();


                console.info(
                    `ORRAX provider success: ${name}`
                );


                /*
                   SUCCESS:
                   The reserved slot stays consumed.
                */

                return res
                    .status(200)
                    .json({
                        text
                    });

            } catch (error) {

                /*
                   Never expose provider
                   errors to the user.
                */

                console.warn(
                    `ORRAX provider failed: ${name}`,
                    error?.status ||
                    error?.message ||
                    "unknown"
                );
            }
        }


        /*
           EVERY PROVIDER FAILED.

           Give the daily slot back.
        */

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


        /*
           Do not consume quota when
           no successful reply happened.
        */

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
