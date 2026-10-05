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
    .map((value) =>
      encodeURIComponent(String(value))
    )
    .join("/");

  const response = await fetch(
    `${url}/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `REDIS_HTTP_${response.status}`
    );
  }

  const data = await response.json();

  return data?.result;
}

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
    "GET, OPTIONS"
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

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  try {
    const cookieHeader =
      String(req.headers.cookie || "");

    const match = cookieHeader.match(
      /(?:^|;\s*)orrax_session=([^;]+)/
    );

    if (!match) {
      return res.status(401).json({
        error: "Not signed in."
      });
    }

    const sessionToken =
      decodeURIComponent(match[1]);

    if (!sessionToken) {
      return res.status(401).json({
        error: "Not signed in."
      });
    }

    const rawSession = await redisCommand(
      "get",
      [`orrax:session:${sessionToken}`]
    );

    if (!rawSession) {
      return res.status(401).json({
        error: "Session expired."
      });
    }

    const session =
      typeof rawSession === "string"
        ? JSON.parse(rawSession)
        : rawSession;

    if (!session?.sub) {
      return res.status(401).json({
        error: "Invalid session."
      });
    }

    return res.status(200).json({
      user: {
        sub: session.sub,
        name: session.name || "",
        email: session.email || "",
        picture: session.picture || ""
      }
    });

  } catch (error) {
    console.error(
      "ORRAX session error:",
      error?.message || error
    );

    return res.status(500).json({
      error: "Could not restore Google session."
    });
  }
}
