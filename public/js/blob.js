/**
 * blob.js — uploads base64 data URLs to /api/blob and returns a permanent
 * URL pointing at the server-side content-addressed blob store.
 *
 * Why: storing the entire base64 inside the board JSON makes every canvas
 * multi-MB and slow to PUT/GET on switch. Routing through blob storage
 * keeps the board JSON small (just metadata + tiny URLs).
 *
 * If we can't reach the server or there's no key, we silently keep the
 * original data URL — the app keeps working, just at the old performance
 * cost for that one item.
 */

function getKey() {
  return localStorage.getItem("openai_api_key") || "";
}

const inflight = new Map(); // dedupe parallel uploads of the same data URL

export async function uploadToBlob(src) {
  if (!src || typeof src !== "string") return src;
  if (!src.startsWith("data:")) return src; // already an URL (blob, http, etc.)
  const key = getKey();
  if (!key) return src; // no identity → keep data URL (will retry next save)
  if (inflight.has(src)) return inflight.get(src);
  const promise = (async () => {
    try {
      const res = await fetch("/api/blob", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenAI-Key": key
        },
        body: JSON.stringify({ data: src })
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      return data.url || src;
    } catch (err) {
      console.warn("[blob] upload failed, keeping data URL:", err);
      return src;
    } finally {
      inflight.delete(src);
    }
  })();
  inflight.set(src, promise);
  return promise;
}
