/**
 * usage.js — local image generation usage tracking.
 *
 * gpt-image-1 pricing (2025):
 *   low  quality 1024×1024 → $0.02
 *   med  quality 1024×1024 → $0.07
 *   high quality 1024×1024 → $0.19
 *   (portrait / landscape ≈ same tier)
 * Default assumed: low quality → $0.02/image
 */

const STORAGE_KEY = "layerboard_usage";
const PRICE_PER_IMAGE = 0.02; // USD, gpt-image-1 low quality

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { count: 0, usd: 0 };
  } catch {
    return { count: 0, usd: 0 };
  }
}

function save(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
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
  label.textContent = `${data.count} 張 · $${data.usd.toFixed(2)}`;
}
