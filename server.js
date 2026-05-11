import http from "node:http";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer, Blob } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

// ---------- Config ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const MAX_BODY_BYTES = 32_000_000;
// Board JSON includes base64 image data — allow a bigger ceiling.
const MAX_BOARD_BYTES = 256_000_000;
const MAX_GEN_COUNT = 4;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

// ---------- Helpers ----------
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes limit.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeSize(aspectRatio) {
  switch (aspectRatio) {
    case "portrait":
      return "1024x1536";
    case "landscape":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

function buildPrompt({ prompt, style, context }) {
  return [
    prompt,
    style ? `Visual direction: ${style}.` : "",
    context ? `Moodboard context: ${context}.` : "",
    "Create a polished visual asset suitable for a design moodboard. Avoid text, watermarks, logos, and UI chrome unless explicitly requested."
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- Cloud sync helpers ----------
function userIdFromKey(rawKey) {
  const key = String(rawKey || "").trim();
  if (!key) return null;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function userDir(userId) {
  return path.join(DATA_DIR, userId);
}

async function readUserJson(userId, name, fallback) {
  try {
    const raw = await readFile(path.join(userDir(userId), `${name}.json`), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeUserJson(userId, name, value) {
  const dir = userDir(userId);
  await mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${name}.json`);
  const tmpPath = `${finalPath}.tmp.${randomBytes(6).toString("hex")}`;
  await writeFile(tmpPath, JSON.stringify(value));
  await rename(tmpPath, finalPath);
}

async function deleteUserJson(userId, name) {
  try {
    await unlink(path.join(userDir(userId), `${name}.json`));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function requireUserId(req, res) {
  const userId = userIdFromKey(req.headers["x-openai-key"]);
  if (!userId) {
    sendJson(res, 401, { error: "Missing X-OpenAI-Key header. Cloud sync requires a key for identity." });
    return null;
  }
  return userId;
}

async function readSyncBody(req, res, maxBytes = MAX_BODY_BYTES) {
  try {
    return JSON.parse(await readRequestBody(req, maxBytes));
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Invalid JSON body." });
    return null;
  }
}

// ---------- Cloud sync route handlers ----------
async function handleBoardGet(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const items = await readUserJson(userId, "board", []);
  sendJson(res, 200, { items: Array.isArray(items) ? items : [] });
}

async function handleBoardPut(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = await readSyncBody(req, res, MAX_BOARD_BYTES);
  if (!body) return;
  const items = Array.isArray(body.items) ? body.items : [];
  await writeUserJson(userId, "board", items);
  sendJson(res, 200, { ok: true, count: items.length });
}

async function handleLogGet(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const entries = await readUserJson(userId, "log", []);
  sendJson(res, 200, { entries: Array.isArray(entries) ? entries : [] });
}

async function handleLogPut(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = await readSyncBody(req, res);
  if (!body) return;
  const entries = Array.isArray(body.entries) ? body.entries : [];
  await writeUserJson(userId, "log", entries);
  sendJson(res, 200, { ok: true, count: entries.length });
}

async function handleLogDelete(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  await deleteUserJson(userId, "log");
  sendJson(res, 200, { ok: true });
}

async function handleUsageGet(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const usage = await readUserJson(userId, "usage", { count: 0, usd: 0 });
  sendJson(res, 200, usage);
}

async function handleUsagePut(req, res) {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const body = await readSyncBody(req, res);
  if (!body) return;
  const data = {
    count: Number(body.count) || 0,
    usd: Number(body.usd) || 0
  };
  await writeUserJson(userId, "usage", data);
  sendJson(res, 200, { ok: true });
}

// ---------- OpenAI image generation ----------
async function handleGenerate(req, res) {
  const apiKey = req.headers["x-openai-key"] || process.env.OPENAI_API_KEY || "";
  if (!apiKey) {
    sendJson(res, 400, {
      error: "OpenAI API Key 未設定。請點右上角 API Key 按鈕輸入。",
      model: IMAGE_MODEL
    });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid JSON body." });
    return;
  }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) {
    sendJson(res, 400, { error: "Prompt is required." });
    return;
  }

  const style = String(body.style || "editorial product moodboard").trim();
  const context = String(body.context || "").trim();
  const count = Math.max(1, Math.min(Number(body.count) || 1, MAX_GEN_COUNT));
  const size = normalizeSize(body.aspectRatio);
  const finalPrompt = buildPrompt({ prompt, style, context });
  const referenceSrcs = Array.isArray(body.images) ? body.images.filter(Boolean) : [];

  try {
    let upstream;
    if (referenceSrcs.length) {
      // Image-edit mode: forward multipart to /v1/images/edits.
      const formData = new FormData();
      for (let i = 0; i < referenceSrcs.length; i += 1) {
        const dataUrl = String(referenceSrcs[i]);
        const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!match) continue;
        const blob = new Blob([Buffer.from(match[2], "base64")], { type: match[1] });
        formData.append("image", blob, `input${i}.png`);
      }
      formData.append("prompt", finalPrompt);
      formData.append("model", IMAGE_MODEL);
      formData.append("n", String(count));
      formData.append("size", size);
      upstream = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData
      });
    } else {
      upstream = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: finalPrompt,
          size,
          n: count
        })
      });
    }

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      sendJson(res, upstream.status, {
        error: payload.error?.message || "OpenAI image generation failed.",
        details: payload,
        model: IMAGE_MODEL
      });
      return;
    }

    const images = (payload.data || [])
      .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
      .filter(Boolean);

    sendJson(res, 200, {
      images,
      model: IMAGE_MODEL,
      revisedPrompt: payload.data?.[0]?.revised_prompt || finalPrompt
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : "Unable to reach OpenAI.",
      model: IMAGE_MODEL
    });
  }
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    status: "ok",
    model: IMAGE_MODEL,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    cloudSync: true
  });
}

function cacheControlFor(ext) {
  if (ext === ".html") return "no-cache";
  if ([".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico"].includes(ext)) {
    return "public, max-age=300, must-revalidate";
  }
  return "no-store";
}

async function handleStatic(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const decoded = decodeURIComponent(requestUrl.pathname);
  const safePath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": cacheControlFor(ext),
      ...SECURITY_HEADERS
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Not found");
  }
}

// ---------- Router ----------
const ROUTES = [
  { method: "POST", path: "/api/generate", handler: handleGenerate },
  { method: "GET", path: "/api/health", handler: handleHealth },
  { method: "GET", path: "/api/board", handler: handleBoardGet },
  { method: "PUT", path: "/api/board", handler: handleBoardPut },
  { method: "GET", path: "/api/log", handler: handleLogGet },
  { method: "PUT", path: "/api/log", handler: handleLogPut },
  { method: "DELETE", path: "/api/log", handler: handleLogDelete },
  { method: "GET", path: "/api/usage", handler: handleUsageGet },
  { method: "PUT", path: "/api/usage", handler: handleUsagePut }
];

const server = http.createServer(async (req, res) => {
  try {
    const route = ROUTES.find((r) => r.method === req.method && r.path === req.url);
    if (route) {
      await route.handler(req, res);
      return;
    }

    if (req.method === "GET") {
      await handleStatic(req, res);
      return;
    }

    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Method not allowed");
  } catch (error) {
    console.error("[server] Unhandled error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
    }
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`Layerboard listening on http://${HOST}:${PORT}`);
  console.log(`OpenAI image model: ${IMAGE_MODEL}`);
  console.log(`Cloud sync data dir: ${DATA_DIR}`);
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("[server] Failed to create data dir:", err);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠  OPENAI_API_KEY is not set. /api/generate will return 400 without per-request key.");
  }
});

// Graceful shutdown for platform redeploys (Zeabur/Docker send SIGTERM).
function shutdown(signal) {
  console.log(`Received ${signal}, closing server…`);
  server.close((err) => {
    if (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
