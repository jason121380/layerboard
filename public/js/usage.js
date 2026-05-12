/**
 * usage.js — cloud-sync image generation usage tracking.
 *
 * gpt-image-2 uses token-based pricing ($30 / 1M output tokens at 2026-04 launch).
 * A standard-quality 1024×1024 image ≈ ~1100 output tokens ≈ $0.033.
 * High quality / larger sizes scale up roughly linearly with pixel count.
 *
 * Storage stays in USD (data.usd) so a future rate change doesn't break old
 * records; display converts to TWD on the fly.
 */

import { state } from "./state.js";

const PRICE_PER_IMAGE = 0.04;   // USD, rough estimate for gpt-image-2 standard 1024×1024
const PRICE_PER_MAGIC = 0.005;  // USD, rough estimate for Replicate SAM 2 per call
export const USD_TO_TWD = 32;    // Fixed conversion rate; update if needed.

let cache = { count: 0, usd: 0, magicCount: 0, magicUsd: 0 };
let initPromise = null;
let saveTimer = null;

function getKey() {
  return localStorage.getItem("openai_api_key") || "";
}

function canSync() {
  return state.hasBackend !== false && !!getKey();
}

export function usdToTwd(usd) {
  return Math.round(usd * USD_TO_TWD);
}

export function formatTwd(usd) {
  return `NT$ ${usdToTwd(usd).toLocaleString("zh-TW")}`;
}

export async function initUsage() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!canSync()) { cache = { count: 0, usd: 0 }; return; }
    try {
      const res = await fetch("/api/usage", {
        headers: { "X-OpenAI-Key": getKey() }
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      cache = {
        count: Number(data.count) || 0,
        usd: Number(data.usd) || 0,
        magicCount: Number(data.magicCount) || 0,
        magicUsd: Number(data.magicUsd) || 0
      };
    } catch (err) {
      console.warn("[usage] cloud load failed:", err);
      cache = { count: 0, usd: 0, magicCount: 0, magicUsd: 0 };
    }
  })();
  return initPromise;
}

export function resetUsageCache() {
  cache = { count: 0, usd: 0, magicCount: 0, magicUsd: 0 };
  initPromise = null;
}

export function getUsage() {
  return { ...cache };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

async function saveNow() {
  if (!canSync()) return;
  try {
    await fetch("/api/usage", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-OpenAI-Key": getKey()
      },
      body: JSON.stringify(cache)
    });
  } catch (err) {
    console.warn("[usage] cloud save failed:", err);
  }
}

export function recordImages(n = 1, priceEach = PRICE_PER_IMAGE) {
  cache.count += n;
  cache.usd = Math.round((cache.usd + priceEach * n) * 10000) / 10000;
  scheduleSave();
  renderUsage();
}

export function recordMagic(n = 1, priceEach = PRICE_PER_MAGIC) {
  cache.magicCount = (cache.magicCount || 0) + n;
  cache.magicUsd = Math.round(((cache.magicUsd || 0) + priceEach * n) * 10000) / 10000;
  scheduleSave();
  renderUsage();
}

export function renderUsage() {
  const label = document.querySelector("#usageLabel");
  if (!label) return;
  if (!cache.count) {
    label.hidden = true;
    return;
  }
  label.hidden = false;
  // Show TWD with at least NT$ 1 so single-image runs aren't displayed as NT$ 0.
  const twd = Math.max(1, usdToTwd(cache.usd));
  label.textContent = `${cache.count} 張 · NT$ ${twd.toLocaleString("zh-TW")}`;
}
