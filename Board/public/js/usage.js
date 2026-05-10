/**
 * usage.js — local image generation usage tracking.
 *
 * gpt-image-2 uses token-based pricing ($30 / 1M output tokens at 2026-04 launch).
 * A standard-quality 1024×1024 image ≈ ~1100 output tokens ≈ $0.033.
 * High quality / larger sizes scale up roughly linearly with pixel count.
 *
 * This counter is a *rough* estimate; for exact billing check your OpenAI usage
 * dashboard. Override the constant if you mostly run high quality or large sizes.
 */

const STORAGE_KEY = "layerboard_usage";
const PRICE_PER_IMAGE = 0.04; // USD, rough estimate for gpt-image-2 standard 1024×1024

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
