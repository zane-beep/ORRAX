import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const SESSION_TTL = 60 * 60 * 24 * 7;
const SESSION_COOKIE = "orrax_session";
const client = new OAuth2Client();

function getRedisConfig(){
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

  return { url:url.replace(/\/+$/, ""), token };
}

async function redisCommand(command, args = []){
  const {url, token} = getRedisConfig();

  if(!url || !token){
    throw new Error("REDIS_NOT_CONFIGURED");
  }

  const path = [command, ...args]
    .map(v => encodeURIComponent(String(v)))
    .join("/");

  const response = await fetch(`${url}/${path}`, {
    method:"POST",
    headers:{Authorization:`Bearer ${token}`}
  });

  if(!response.ok){
    throw new Error(`REDIS_HTTP_${response.status}`);
  }

  const data = await response.json();
  return data?.result;
}

function frontendUrl(){
  const configured = process.env.ORRAX_FRONTEND_URL || "";
  const allowed = new Set([
    "https://zane-beep.github.io/ORRAX/",
    "https://orrax.vercel.app/"
  ]);

  return allowed.has(configured)
    ? configured
    : "https://zane-beep.github.io/ORRAX/";
}

function redirect(res, status){
  const url = new URL(frontendUrl());
  url.searchParams.set("google", status);
  res.setHeader("Location", url.toString());
  return res.status(303).end();
}

export default async function handler(req, res){
  if(req.method !== "POST"){
    return res.status(405).send("Method not allowed.");
  }

  if(!GOOGLE_CLIENT_ID){
    return redirect(res, "unavailable");
  }

  try{
    const credential =
      typeof req.body?.credential === "string"
        ? req.body.credential.trim()
        : "";

    if(credential.length < 20){
      return redirect(res, "failed");
    }

    const ticket = await client.verifyIdToken({
      idToken:credential,
      audience:GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if(!payload?.sub){
      return redirect(res, "failed");
    }

    const sessionToken =
      crypto.randomBytes(32).toString("base64url");

    const sessionKey =
      `orrax:session:${sessionToken}`;

    const session = JSON.stringify({
      sub:payload.sub,
      name:payload.name || "",
      email:payload.email || "",
      picture:payload.picture || ""
    });

    await redisCommand("set", [sessionKey, session]);
    await redisCommand("expire", [sessionKey, SESSION_TTL]);

    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionToken}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=None`
    );

    return redirect(res, "connected");

  }catch(error){
    console.error("ORRAX Google redirect auth error:", error?.message || error);
    return redirect(res, "failed");
  }
}
