const SESSION_COOKIE = "orrax_session";

function cors(res, origin){
  const allowed = new Set([
    "https://zane-beep.github.io",
    "https://orrax.vercel.app"
  ]);

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowed.has(origin) ? origin : "https://zane-beep.github.io"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
}

function redisConfig(){
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
  return {url:url.replace(/\/+$/, ""), token};
}

async function redisGet(key){
  const {url, token} = redisConfig();
  if(!url || !token) throw new Error("REDIS_NOT_CONFIGURED");

  const response = await fetch(
    `${url}/get/${encodeURIComponent(key)}`,
    {method:"POST", headers:{Authorization:`Bearer ${token}`}}
  );

  if(!response.ok) throw new Error(`REDIS_HTTP_${response.status}`);
  const data = await response.json();
  return data?.result || null;
}

function getCookie(req, name){
  const raw = String(req.headers.cookie || "");
  const match = raw.match(
    new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&")}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : "";
}

export default async function handler(req, res){
  cors(res, req.headers.origin || "");

  if(req.method === "OPTIONS") return res.status(204).end();
  if(req.method !== "GET") return res.status(405).json({error:"Method not allowed."});

  try{
    const token = getCookie(req, SESSION_COOKIE);
    if(!token) return res.status(401).json({user:null});

    const raw = await redisGet(`orrax:session:${token}`);
    if(!raw) return res.status(401).json({user:null});

    const user = typeof raw === "string" ? JSON.parse(raw) : raw;
    if(!user?.sub) return res.status(401).json({user:null});

    return res.status(200).json({
      user:{
        sub:user.sub,
        name:user.name || "",
        email:user.email || "",
        picture:user.picture || ""
      }
    });
  }catch(error){
    console.error("ORRAX session lookup error:", error?.message || error);
    return res.status(401).json({user:null});
  }
}
