const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

export default function handler(req, res) {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin || "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept"
    );

    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({
      error: "Google sign-in is temporarily unavailable."
    });
  }

  const allowedOrigins = new Set([
    "https://zane-beep.github.io",
    "https://orrax.vercel.app"
  ]);

  const allowOrigin = allowedOrigins.has(origin)
    ? origin
    : "https://orrax.vercel.app";

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowOrigin
  );

  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    googleClientId: GOOGLE_CLIENT_ID
  });
}
