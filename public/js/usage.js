/**
 * usage.js — local image generation usage tracking.
 *
 * gpt-image-2 uses token-based pricing ($30 / 1M output tokens at 2026-04 launch).
 * A standard-quality 1024×1024 image ≈ ~1100 output tokens ≈ $0.033.
 * High quality / larger sizes scale up roughly linearly with pixel count.
 *
 * Storage stays in USD (data.usd) so a future rate change doesn't break old
 * records; display converts to TWD on the fly.
 */

import { namespaced } from "./namespace.js";

const PRICE_PER_IMAGE = 0.04;   // USD, rough estimate for gpt-image-2 standard 1024×1024
export const USD_TO_TWD = 32;    // Fixed conversion rate; update if needed.
function storageKey() { return namespaced("layerboard_usage"); }

export function usdToTwd(usd) {
  return Math.round(usd * USD_TO_TWD);
}

export function formatTwd(usd) {
  return `NT$ ${usdToTwd(usd).toLocaleString("zh-TW")}`;
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(storageKey())) || { count: 0, usd: 0 };
  } catch {
    return { count: 0, usd: 0 };
  }
}

function save(data) {
  localStorage.setItem(storageKey(), JSON.stringify(data));
}

export function recordImages(n = 1, priceEach = PRICE_PER_IMAGE) {
  const data = load();
  data.count += n;
  data.usd = Math.round((data.usd + priceEach * n) * 10000) / 10000;
  save(data);
  renderUsage();
}

export function renderUsage() {
  const label = document.querySelector("#usageLabel");
  if (!label) return;
  const data = load();
  if (!data.count) {
    label.hidden = true;
    return;
  }
  label.hidden = false;
  // Show TWD with at least NT$ 1 so single-image runs aren't displayed as NT$ 0.
  const twd = Math.max(1, usdToTwd(data.usd));
  label.textContent = `${data.count} 張 · NT$ ${twd.toLocaleString("zh-TW")}`;
}
