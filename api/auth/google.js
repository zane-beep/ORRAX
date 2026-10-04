import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID || "";

const client = new OAuth2Client();

function setCors(res, origin) {
  const allowedOrigins = new Set([
    "https://orrax.vercel.app",
    "https://zane-beep.github.io"
  ]);

  const allowOrigin = allowedOrigins.has(origin)
    ? origin
    : "https://orrax.vercel.app";

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowOrigin
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );

  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin || "");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({
      error: "Google sign-in is temporarily unavailable."
    });
  }

  try {
    const credential = req.body?.credential;

    if (
      typeof credential !== "string" ||
      credential.trim().length < 20
    ) {
      return res.status(400).json({
        error: "Invalid Google sign-in credential."
      });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload?.sub) {
      return res.status(401).json({
        error: "Google identity could not be verified."
      });
    }

    return res.status(200).json({
      user: {
        sub: payload.sub,
        name: payload.name || "",
        email: payload.email || "",
        picture: payload.picture || ""
      }
    });

  } catch (error) {
    console.error(
      "ORRAX Google auth error:",
      error
    );

    return res.status(401).json({
      error: "Google sign-in could not be verified."
    });
  }
}
