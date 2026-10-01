const MODEL =
  process.env.GEMINI_IMAGE_MODEL ||
  "gemini-2.5-flash-image";

const API_KEY = process.env.GEMINI_API_KEY;

function corsHeaders(origin = "") {
  const allowed = new Set([
    "https://zane-beep.github.io",
    "https://orrax.vercel.app"
  ]);

  const allowOrigin = allowed.has(origin)
    ? origin
    : "https://zane-beep.github.io";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "*";

  Object.entries(corsHeaders(origin)).forEach(
    ([key, value]) => {
      res.setHeader(key, value);
    }
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  if (!API_KEY) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured on the server."
    });
  }

  try {
    const { prompt } = req.body || {};

    if (
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {
      return res.status(400).json({
        error: "A valid image prompt is required."
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt.trim()
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const message =
        data?.error?.message ||
        `Gemini returned HTTP ${response.status}`;

      return res.status(response.status).json({
        error: message
      });
    }

    const parts =
      data?.candidates?.[0]?.content?.parts || [];

    const text = parts
      .filter(
        part => typeof part?.text === "string"
      )
      .map(part => part.text)
      .join("");

    const imagePart = parts.find(
      part =>
        part?.inlineData?.data &&
        part?.inlineData?.mimeType
    );

    if (!imagePart) {
      return res.status(502).json({
        error:
          text ||
          "Gemini did not return an image."
      });
    }

    return res.status(200).json({
      text,
      image: {
        mimeType:
          imagePart.inlineData.mimeType,
        data:
          imagePart.inlineData.data
      }
    });

  } catch (error) {
    console.error(
      "ORRAX image error:",
      error
    );

    return res.status(500).json({
      error:
        "The ORRAX image neural link could not complete the request."
    });
  }
}
