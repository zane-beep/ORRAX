/* ORRAX /api/chat
 * Server-only AI router.
 * - 26 successful text replies per user per UTC day.
 * - Google users are identified by verified Google ID-token `sub` (or the orrax_session cookie).
 * - Anonymous users use a server-scoped browser id + IP hash.
 * - Gemini -> xKiro key 1 -> xKiro key 2 -> Dahl -> OpenRouter free -> optional paid fallbacks.
 * - Attachments (image / pdf / audio / video via Gemini; text + docx/xlsx/pptx read as text for every provider).
 * - Technical provider errors are never returned to the browser.
 */

import crypto from "node:crypto";
import zlib from "node:zlib";
import { OAuth2Client } from "google-auth-library";

const DAILY_LIMIT = 26;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const DAHL_API_KEY = process.env.DAHL_API_KEY || "";
const XKIRO_KEYS = [
  process.env.XKIRO_API_KEY,
  process.env.XKIRO_API_KEY_2
].filter(Boolean);

const ENABLE_PAID_FALLBACKS =
  process.env.ENABLE_PAID_FALLBACKS === "true";

/* Attachment limits */
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_FILE = 30000;
const MAX_TEXT_CHARS_TOTAL = 60000;

const SYSTEM_INSTRUCTION = `
You are ORRAX, created by KHAN SAHEB.

LANGUAGE RULE - STRICT:
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
- Do not repeat the same point twice.
- Write normal replies as clean, natural plain prose.
- Do not use Markdown decoration in normal prose: no asterisks for bold or italics, no # headings, no underscores or ~~ for emphasis, no decorative bullet symbols.
- When the user asks for code, give proper complete working code inside a fenced code block.
- Never reveal server keys, internal routing, quota implementation, provider names or provider errors.
- Never claim to have used a tool or capability you did not actually use.
- If the user attached a file you cannot see, say so briefly instead of guessing its content.
`;

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
    .map(v =>
      encodeURIComponent(String(v))
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


function utcDayKey() {

  return new Date()
    .toISOString()
    .slice(0, 10);
}


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


async function releaseDailyReply(key) {

  await redisCommand(
    "decr",
    [key]
  ).catch(() => {});
}


/* =========================================================
   USER IDENTITY
========================================================= */

async function identifyUser(req) {

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
          audience: GOOGLE_CLIENT_ID
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
   CLEAN RESPONSE (prose only, code is preserved)
========================================================= */

function cleanProse(text) {

  return String(text)
    .replace(/(\d)\s\*\s(?=\d)/g, "$1 \u00d7 ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*\u2022]\s+/gm, "$1\u2022 ")
    .replace(/\*{1,3}/g, "")
    .replace(/__+/g, "")
    .replace(/~~/g, "")
    .replace(
      /(^|[\s(])_([^_\n]+)_(?=[\s.,!?;:)]|$)/g,
      "$1$2"
    )
    .replace(/\n{3,}/g, "\n\n");
}


function cleanAiText(text) {

  const original = String(text || "");

  const cleaned =
    original
      .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g)
      .map(part => {

        if (
          part.startsWith("```") ||
          (
            part.length > 1 &&
            part.startsWith("`") &&
            part.endsWith("`")
          )
        ) {
          return part;
        }

        return cleanProse(part);
      })
      .join("")
      .trim();

  return cleaned || original.trim();
}


/* =========================================================
   ATTACHMENTS
========================================================= */

const EXT_MIME = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mpeg: "video/mpeg",
  avi: "video/x-msvideo"
};

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function safeName(value) {

  return String(value || "file")
    .replace(/[\u0000-\u001f<>"`]/g, "")
    .slice(0, 120) || "file";
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


/* Minimal ZIP reader (central directory + inflate) for docx/xlsx/pptx. */
function readZipEntries(buffer, wanted) {

  const MAX_ENTRY = 25 * 1024 * 1024;
  const out = {};

  let eocd = -1;
  const stop = Math.max(0, buffer.length - 65557);

  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) return out;

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {

    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    ) {
      break;
    }

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name =
      buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;

    if (
      localOffset + 30 > buffer.length ||
      buffer.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      continue;
    }

    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressedSize);

    try {
      if (method === 0) {
        if (raw.length <= MAX_ENTRY) out[name] = raw;
      } else if (method === 8) {
        out[name] = zlib.inflateRawSync(raw, {
          maxOutputLength: MAX_ENTRY
        });
      }
    } catch (error) {
      /* skip unreadable entry */
    }
  }

  return out;
}

function xmlText(value) {

  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractDocx(buffer) {

  const files = readZipEntries(
    buffer,
    name => name === "word/document.xml"
  );

  const xml = files["word/document.xml"];
  if (!xml) return "";

  return xmlText(
    xml
      .toString("utf8")
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

function extractXlsx(buffer) {

  const files = readZipEntries(
    buffer,
    name =>
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );

  const shared = [];
  const sharedXml = files["xl/sharedStrings.xml"];

  if (sharedXml) {
    const items =
      sharedXml.toString("utf8").match(/<si>[\s\S]*?<\/si>/g) || [];

    for (const item of items) {
      shared.push(
        xmlText(
          (item.match(/<t[^>]*>[\s\S]*?<\/t>/g) || [])
            .map(t => t.replace(/<[^>]+>/g, ""))
            .join("")
        )
      );
    }
  }

  const sheetNames =
    Object.keys(files)
      .filter(name => name.startsWith("xl/worksheets/"))
      .sort();

  const lines = [];

  sheetNames.forEach((name, index) => {

    lines.push(`# Sheet ${index + 1}`);

    const rows =
      files[name].toString("utf8").match(/<row[\s\S]*?<\/row>/g) || [];

    for (const row of rows.slice(0, 500)) {

      const cells = [];
      const cellMatches =
        row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];

      for (const cell of cellMatches) {

        const type = (cell.match(/\bt="([^"]*)"/) || [])[1];
        const value = (cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const inline = (cell.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];

        if (type === "s" && value !== undefined) {
          cells.push(shared[Number(value)] || "");
        } else if (type === "inlineStr" && inline !== undefined) {
          cells.push(xmlText(inline));
        } else if (value !== undefined) {
          cells.push(xmlText(value));
        } else {
          cells.push("");
        }
      }

      lines.push(cells.join("\t"));
    }
  });

  return lines.join("\n").trim();
}

function extractPptx(buffer) {

  const files = readZipEntries(
    buffer,
    name => /^ppt\/slides\/slide\d+\.xml$/.test(name)
  );

  const names =
    Object.keys(files).sort(
      (a, b) =>
        Number(a.match(/(\d+)\.xml$/)[1]) -
        Number(b.match(/(\d+)\.xml$/)[1])
    );

  return names
    .map((name, index) => {

      const texts =
        (files[name].toString("utf8").match(/<a:t>[\s\S]*?<\/a:t>/g) || [])
          .map(t => xmlText(t.replace(/<[^>]+>/g, "")));

      return `# Slide ${index + 1}\n${texts.join("\n")}`;
    })
    .join("\n\n")
    .trim();
}

function parseAttachments(rawList) {

  const result = {
    mediaParts: [],
    textBlocks: [],
    mediaNames: []
  };

  if (rawList === undefined || rawList === null) {
    return result;
  }

  if (!Array.isArray(rawList)) {
    throw new AttachmentError("Attachments are not valid.");
  }

  if (rawList.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(
      `You can attach up to ${MAX_ATTACHMENTS} files per message.`
    );
  }

  let totalBytes = 0;
  let totalChars = 0;

  for (const raw of rawList) {

    if (!raw || typeof raw !== "object") {
      throw new AttachmentError("Attachments are not valid.");
    }

    const name = safeName(raw.name);
    const mime = resolveMime(name, raw.mimeType || raw.type);
    const { base64, bytes } = decodeBase64Payload(raw.data);

    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `"${name}" is larger than 12 MB.`
      );
    }

    totalBytes += bytes;

    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        "The attachments are too large in total."
      );
    }

    if (/^image\/(png|jpeg|webp|heic|heif)$/.test(mime)) {

      result.mediaParts.push({
        type: "image",
        data: base64,
        mime_type: mime
      });
      result.mediaNames.push(name);

    } else if (mime.startsWith("audio/")) {

      result.mediaParts.push({
        type: "audio",
        data: base64,
        mime_type: mime
      });
      result.mediaNames.push(name);

    } else if (mime.startsWith("video/")) {

      result.mediaParts.push({
        type: "video",
        data: base64,
        mime_type: mime
      });
      result.mediaNames.push(name);

    } else if (mime === "application/pdf") {

      result.mediaParts.push({
        type: "document",
        data: base64,
        mime_type: mime
      });
      result.mediaNames.push(name);

    } else if (
      mime === "text/plain" ||
      mime === "text/markdown" ||
      mime === "text/csv" ||
      mime === "application/json"
    ) {

      const content =
        Buffer.from(base64, "base64").toString("utf8");

      result.textBlocks.push({ name, content });

    } else if (
      mime === DOCX_MIME ||
      mime === XLSX_MIME ||
      mime === PPTX_MIME
    ) {

      const buffer = Buffer.from(base64, "base64");
      let content = "";

      try {
        content =
          mime === DOCX_MIME ? extractDocx(buffer)
          : mime === XLSX_MIME ? extractXlsx(buffer)
          : extractPptx(buffer);
      } catch (error) {
        content = "";
      }

      if (!content) {
        throw new AttachmentError(
          `Could not read text from "${name}". Try saving it as a PDF.`
        );
      }

      result.textBlocks.push({ name, content });

    } else if (
      mime === "application/msword" ||
      mime === "application/vnd.ms-excel" ||
      mime === "application/vnd.ms-powerpoint"
    ) {

      throw new AttachmentError(
        "Old .doc / .xls / .ppt files are not supported. Please save the file as DOCX, XLSX, PPTX or PDF."
      );

    } else {

      throw new AttachmentError(
        `"${name}": this file type is not supported.`
      );
    }
  }

  /* Turn text files into bounded prompt text. */
  result.textBlocks =
    result.textBlocks.map(item => {

      const room = Math.max(
        0,
        Math.min(
          MAX_TEXT_CHARS_PER_FILE,
          MAX_TEXT_CHARS_TOTAL - totalChars
        )
      );

      const clipped = item.content.slice(0, room);
      totalChars += clipped.length;

      const note =
        clipped.length < item.content.length
          ? "\n[...file truncated...]"
          : "";

      return `[Attached file: ${item.name}]\n${clipped}${note}\n[End of file]`;
    });

  return result;
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
    role: "user",
    content: prompt.trim()
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


function extractOpenAIText(data) {

  return (
    data
      ?.choices?.[0]
      ?.message?.content
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
          .catch(() => ({}));

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
   GEMINI (Interactions API)
   input: string, or [{type:"text"}, {type:"image|audio|video|document", data, mime_type}]
========================================================= */

async function callGemini(
  prompt,
  history,
  mediaParts = []
) {

  if (!GEMINI_API_KEY) {
    throw new Error(
      "NO_GEMINI_KEY"
    );
  }

  const transcript =
    buildTranscript(
      prompt,
      history
    );

  const input =
    mediaParts.length
      ? [
          {
            type: "text",
            text: transcript
          },
          ...mediaParts
        ]
      : transcript;

  const { data } =
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

        body: JSON.stringify({
          model:
            GEMINI_MODEL,

          input,

          system_instruction:
            SYSTEM_INSTRUCTION,

          generation_config: {
            thinking_level:
              "low"
          },

          store: false
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
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${key}`
        },

        body: JSON.stringify({
          model,

          messages: [
            {
              role: "system",
              content:
                SYSTEM_INSTRUCTION
            },
            ...buildMessages(
              prompt,
              history
            )
          ],

          max_tokens: 900,
          temperature: 0.6
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
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${DAHL_API_KEY}`
        },

        body: JSON.stringify({
          model,

          messages: [
            {
              role: "system",
              content:
                SYSTEM_INSTRUCTION
            },

            ...buildMessages(
              prompt,
              history
            )
          ],

          max_tokens: 900,
          temperature: 0.6
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

        body: JSON.stringify({
          model:
            "openrouter/free",

          messages: [
            {
              role: "system",
              content:
                SYSTEM_INSTRUCTION
            },

            ...buildMessages(
              prompt,
              history
            )
          ],

          max_tokens: 900,
          temperature: 0.6
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
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${GROQ_API_KEY}`
        },

        body: JSON.stringify({
          model,

          messages: [
            {
              role: "system",
              content:
                SYSTEM_INSTRUCTION
            },

            ...buildMessages(
              prompt,
              history
            )
          ],

          max_tokens: 900,
          temperature: 0.6
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
    const [key, value] of Object.entries(
      corsHeaders(origin)
    )
  ) {

    res.setHeader(
      key,
      value
    );
  }


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


  const {
    prompt,
    history,
    attachments
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


  /* Validate attachments BEFORE any quota is used. */

  let files;

  try {

    files =
      parseAttachments(
        attachments
      );

  } catch (error) {

    if (error instanceof AttachmentError) {

      return res
        .status(400)
        .json({
          code:
            "INVALID_ATTACHMENT",

          error:
            error.message
        });
    }

    console.warn(
      "ORRAX attachment parsing failed"
    );

    return res
      .status(400)
      .json({
        code:
          "INVALID_ATTACHMENT",

        error:
          "The attachment could not be processed."
      });
  }


  const fileText =
    files.textBlocks.length
      ? `\n\n${files.textBlocks.join("\n\n")}`
      : "";

  /* Prompt used by Gemini (it also receives the media itself). */
  const geminiPrompt =
    `${prompt.trim()}${fileText}`;

  /* Prompt used by the other providers (they cannot view media). */
  const fallbackPrompt =
    files.mediaParts.length
      ? `${geminiPrompt}\n\n[Note: the user also attached ${files.mediaNames.join(", ")}, which you cannot view. If it is needed to answer, say briefly that you could not open it.]`
      : geminiPrompt;


  let reservation =
    null;


  try {

    const userKey =
      await identifyUser(
        req
      );


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


    const providers = [

      [
        "gemini",
        () =>
          callGemini(
            geminiPrompt,
            history,
            files.mediaParts
          )
      ],

      [
        "xkiro-1",
        () =>
          callXKiro(
            XKIRO_KEYS[0],
            fallbackPrompt,
            history
          )
      ],

      [
        "xkiro-2",
        () =>
          callXKiro(
            XKIRO_KEYS[1],
            fallbackPrompt,
            history
          )
      ],

      [
        "dahl",
        () =>
          callDahl(
            fallbackPrompt,
            history
          )
      ],

      [
        "openrouter",
        () =>
          callOpenRouter(
            fallbackPrompt,
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
            fallbackPrompt,
            history
          )
      ]);
    }


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
            text:
              cleanAiText(
                text
              )
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


    /* No provider replied.
       Do not consume the user's daily slot. */

    await releaseDailyReply(
      reservation.key
    );

    reservation =
      null;


    return res
      .status(503)
      .json({
        code:
          "AI_TEMPORARILY_UNAVAILABLE",

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
          "AI_TEMPORARILY_UNAVAILABLE",

        error:
          "AI_TEMPORARILY_UNAVAILABLE"
      });
  }
}
