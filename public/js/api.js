/**
 * api.js — server calls and PNG export.
 */

import { state, dom, showToast, showLoadingProgress } from "./state.js";
import { loadImage, wrapText } from "./utils.js";
import { createItem, getSelectedItems } from "./items.js";
import { scheduleAutoSave } from "./persist.js";
import { recordImages, USD_TO_TWD } from "./usage.js";
import { logStart, logEnd } from "./generation-log.js";

export async function exportSelectedItems() {
  const items = getSelectedItems().filter((i) => i.visible !== false);
  if (!items.length) {
    showToast("請先選取要匯出的物件。");
    return;
  }
  const minX = Math.min(...items.map((i) => i.x)) - 20;
  const minY = Math.min(...items.map((i) => i.y)) - 20;
  const maxX = Math.max(...items.map((i) => i.x + i.width)) + 20;
  const maxY = Math.max(...items.map((i) => i.y + i.height)) + 20;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(maxX - minX);
  canvas.height = Math.ceil(maxY - minY);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const item of [...items].sort((a, b) => a.z - b.z)) {
    ctx.globalAlpha = item.opacity ?? 1;
    try {
      const img = await loadImage(item.src);
      ctx.drawImage(img, item.x - minX, item.y - minY, item.width, item.height);
    } catch {
      ctx.fillStyle = "#ddd6c7";
      ctx.fillRect(item.x - minX, item.y - minY, item.width, item.height);
    }
  }
  ctx.globalAlpha = 1;
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `export-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  showToast("已匯出選取項目。");
}

export const seedPrompts = [
  "半透明玻璃香氛瓶、銀色金屬托盤、苔蘚綠背景、早晨斜射光",
  "模組化工作桌、黑色碳纖維、青綠色細節、安靜高效的創作者工具",
  "夏季飲料包裝、番茄紅和奶油白、手工紙材質、陽光下的桌面",
  "未來感運動鞋、紫色 TPU 透明片、濕潤柏油路、低角度攝影",
  "咖啡館品牌情緒板、黃銅招牌、深綠瓷磚、柔和自然光"
];

function setLoading(isLoading) {
  if (!dom.generateBtn) return;
  dom.generateBtn.disabled = isLoading;
  dom.generateBtn.classList.toggle("is-loading", isLoading);
  dom.generateBtn.setAttribute("aria-label", isLoading ? "Generating image" : "Generate image");
  const span = dom.generateBtn.querySelector("span");
  if (span) span.textContent = isLoading ? "…" : "→";

  if (dom.promptInput) {
    dom.promptInput.disabled = isLoading;
    dom.promptInput.style.opacity = isLoading ? "0.5" : "";
  }
  if (dom.uploadBtn) dom.uploadBtn.disabled = isLoading;

  const row = document.querySelector(".mixer-input-row");
  row?.classList.toggle("is-generating", isLoading);
}

function getApiKey() {
  return localStorage.getItem("openai_api_key") || "";
}

export function saveApiKey(key) {
  if (key) localStorage.setItem("openai_api_key", key.trim());
  else localStorage.removeItem("openai_api_key");
}

const PROMPT_SUFFIX =
  "Visual direction: editorial product moodboard.\n" +
  "Create a polished visual asset suitable for a design moodboard. " +
  "Avoid text, watermarks, logos, and UI chrome unless explicitly requested.";

function buildFinalPrompt(prompt) {
  return `${prompt}\n${PROMPT_SUFFIX}`;
}

/** Map aspect ratio string to gpt-image-2 size. */
function sizeForRatio(ratio) {
  if (ratio === "portrait") return "1024x1536";
  if (ratio === "landscape") return "1536x1024";
  return "1024x1024";
}

/** Display dimensions (board px) for new items at each ratio. */
function displayDimsForRatio(ratio) {
  if (ratio === "portrait") return { width: 260, height: 390 };
  if (ratio === "landscape") return { width: 420, height: 236 };
  return { width: 330, height: 330 };
}

/** Convert any image src (data URL or http URL) to a PNG Blob suitable for the
 *  OpenAI edits endpoint. */
async function srcToPngBlob(src) {
  if (src.startsWith("data:image/png") || src.startsWith("blob:")) {
    return await (await fetch(src)).blob();
  }
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Call our own /api/generate proxy (Node host). Accepts optional array of
 *  reference image data URLs — server forwards to /v1/images/edits when present. */
async function generateViaBackend(prompt, key, referenceSrcs = [], aspectRatio = "square") {
  const headers = { "Content-Type": "application/json" };
  if (key) headers["X-OpenAI-Key"] = key;
  const response = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      context: "",
      style: "editorial product moodboard",
      aspectRatio,
      count: 1,
      images: referenceSrcs
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Image generation failed.");
  return payload;
}

/** Call OpenAI Images API directly from the browser. Used in static deploy. */
async function generateDirect(prompt, key, referenceSrcs = [], aspectRatio = "square") {
  const model = (dom.modelLabel?.textContent || "gpt-image-2").replace(/\s·.+$/, "").trim();
  const size = sizeForRatio(aspectRatio);

  // Edit mode (image + prompt) — gpt-image-2 accepts multiple `image` parts.
  if (referenceSrcs.length) {
    const formData = new FormData();
    for (let i = 0; i < referenceSrcs.length; i += 1) {
      const blob = await srcToPngBlob(referenceSrcs[i]);
      formData.append("image", blob, `input${i}.png`);
    }
    formData.append("prompt", buildFinalPrompt(prompt));
    formData.append("model", model);
    formData.append("n", "1");
    formData.append("size", size);
    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: formData
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || "OpenAI image edit failed.");
    const images = (payload.data || [])
      .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
      .filter(Boolean);
    return { images, model, revisedPrompt: payload.data?.[0]?.revised_prompt };
  }

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      prompt: buildFinalPrompt(prompt),
      size,
      n: 1
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI image generation failed.");
  }
  const images = (payload.data || [])
    .map((item) => (item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url))
    .filter(Boolean);
  return {
    images,
    model,
    revisedPrompt: payload.data?.[0]?.revised_prompt
  };
}

// User can dismiss the confirm dialog for the rest of the session.
let skipConfirmThisSession = false;

function confirmGenerate(prompt, referenceItems = []) {
  return new Promise((resolve) => {
    const modal = document.querySelector("#generateConfirmModal");
    const okBtn = document.querySelector("#confirmGenerateOk");
    const cancelBtn = document.querySelector("#confirmGenerateCancel");
    const skipBox = document.querySelector("#confirmSkipNext");
    const promptText = document.querySelector("#confirmPromptText");
    const modelText = document.querySelector("#confirmModelText");
    const titleText = modal?.querySelector(".api-modal-title");
    if (!modal || !okBtn || !cancelBtn) return resolve(true);

    const hasRefs = referenceItems.length > 0;
    if (promptText) promptText.textContent = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
    if (modelText) modelText.textContent = (dom.modelLabel?.textContent || "gpt-image-2").replace(/\s·.+$/, "");
    if (titleText) {
      titleText.textContent = hasRefs ? `以 ${referenceItems.length} 張選取圖編輯？` : "確認生成圖片？";
    }
    const costText = document.querySelector("#confirmCostText");
    if (costText) {
      const twd = (0.04 * USD_TO_TWD).toFixed(1); // 0.04 USD × 32 ≈ 1.3
      costText.textContent = `NT$ ${twd}`;
    }
    // Reference thumbnails row — added/updated in edit mode, hidden otherwise.
    let refRow = modal.querySelector(".confirm-ref-row");
    if (hasRefs) {
      if (!refRow) {
        refRow = document.createElement("div");
        refRow.className = "confirm-row confirm-ref-row";
        refRow.innerHTML = '<span class="confirm-label">參考圖</span><span class="confirm-value confirm-ref-value"></span>';
        modal.querySelector(".api-modal-card").insertBefore(refRow, modal.querySelector(".confirm-skip"));
      }
      const valueEl = refRow.querySelector(".confirm-ref-value");
      valueEl.innerHTML = referenceItems
        .slice(0, 8)
        .map((it) => `<img class="confirm-ref-thumb" src="${it.src}" alt="reference">`)
        .join("");
      if (referenceItems.length > 8) {
        valueEl.innerHTML += `<span class="confirm-ref-more">+${referenceItems.length - 8}</span>`;
      }
      refRow.hidden = false;
    } else if (refRow) {
      refRow.hidden = true;
    }
    if (skipBox) skipBox.checked = false;
    modal.hidden = false;

    function cleanup() {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    }
    function onOk() {
      if (skipBox?.checked) skipConfirmThisSession = true;
      cleanup();
      resolve(true);
    }
    function onCancel() { cleanup(); resolve(false); }
    function onBackdrop(e) { if (e.target === modal) onCancel(); }
    function onKey(e) {
      if (e.key === "Enter") onOk();
      else if (e.key === "Escape") onCancel();
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    okBtn.focus();
  });
}

export async function generateImages() {
  const prompt = dom.promptInput?.value.trim() || "";
  if (!prompt) {
    showToast("先寫一段 prompt。");
    dom.promptInput?.focus();
    return;
  }

  const key = getApiKey();
  // Default to direct OpenAI call unless we've definitively detected a backend.
  // (null = probe still running / failed → safer to assume static.)
  const useBackend = state.hasBackend === true;
  if (!useBackend && !key) {
    showToast("請先點左下角輸入 OpenAI Key。");
    return;
  }

  // Selected images on the board become reference inputs for image-edit mode.
  const referenceItems = getSelectedItems().filter(
    (item) => ["image", "layer"].includes(item.type) && item.src
  );
  const referenceSrcs = referenceItems.map((item) => item.src);
  const isEdit = referenceSrcs.length > 0;

  if (!skipConfirmThisSession) {
    const ok = await confirmGenerate(prompt, referenceItems);
    if (!ok) return;
  }

  setLoading(true);
  const start = Date.now();
  const initialLabel = isEdit
    ? `以 ${referenceSrcs.length} 張參考圖編輯中… 0 秒`
    : "生成中… 0 秒";
  const progress = showLoadingProgress(initialLabel);
  const logId = logStart({
    prompt,
    mode: isEdit ? "edit" : "generate",
    referenceCount: referenceSrcs.length,
    aspectRatio: state.aspectRatio || "square",
    model: (dom.modelLabel?.textContent || "gpt-image-2").replace(/\s·.+$/, ""),
    backend: state.hasBackend === true ? "server" : "direct"
  });
  const tick = window.setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    const verb = isEdit ? "編輯" : "生成";
    const label =
      sec < 8 ? `${verb}中… ${sec} 秒` :
      sec < 20 ? `${verb}中… ${sec} 秒（OpenAI 通常 15–25 秒）` :
      sec < 40 ? `仍在等 OpenAI 回應… ${sec} 秒` :
      `${sec} 秒，OpenAI 可能塞車中，請耐心等`;
    progress.update(label);
  }, 500);

  const aspectRatio = state.aspectRatio || "square";

  try {
    let payload;
    if (useBackend) {
      try {
        payload = await generateViaBackend(prompt, key, referenceSrcs, aspectRatio);
      } catch (err) {
        // 404 or network failure → backend isn't there, fall back to direct.
        if (/404|fetch|failed/i.test(err.message) && key) {
          state.hasBackend = false;
          payload = await generateDirect(prompt, key, referenceSrcs, aspectRatio);
        } else {
          throw err;
        }
      }
    } else {
      payload = await generateDirect(prompt, key, referenceSrcs, aspectRatio);
    }

    if (payload.model && dom.modelLabel) {
      const suffix = state.hasBackend === true ? "" : " · Static";
      dom.modelLabel.textContent = `${payload.model}${suffix}`;
    }

    const baseX = 1720 + Math.random() * 420;
    const baseY = 690 + Math.random() * 360;
    const dims = displayDimsForRatio(aspectRatio);

    for (const src of payload.images || []) {
      createItem({
        type: "image",
        src,
        fit: "contain",
        x: Math.round(baseX + Math.random() * 360),
        y: Math.round(baseY + Math.random() * 280),
        width: dims.width,
        height: dims.height,
        prompt,
        source: isEdit ? "edit" : "generated"
      });
    }
    recordImages(payload.images?.length || 1);
    scheduleAutoSave();
    const sec = Math.max(1, Math.round((Date.now() - start) / 1000));
    progress.end(`已生成（${sec} 秒）。`);
    logEnd(logId, {
      status: "success",
      durationMs: Date.now() - start,
      imageCount: payload.images?.length || 0,
      revisedPrompt: payload.revisedPrompt || null
    });

    // Clear prompt input after a successful run so user can compose the next one.
    if (dom.promptInput) {
      dom.promptInput.value = "";
      dom.promptInput.style.height = "auto";
    }
  } catch (error) {
    progress.end(`生成失敗:${error.message}`);
    logEnd(logId, {
      status: "failed",
      durationMs: Date.now() - start,
      error: error.message || String(error)
    });
  } finally {
    window.clearInterval(tick);
    setLoading(false);
  }
}

export async function generateSimilar() {
  const selectedImages = getSelectedItems().filter((item) =>
    ["image", "layer"].includes(item.type)
  );
  if (!selectedImages.length) return;
  const seed = selectedImages
    .map((item, index) => item.caption || `selected visual ${index + 1}`)
    .join(", ");
  if (dom.promptInput) {
    dom.promptInput.value = `Create a fresh variation inspired by these selected board items: ${seed}. Keep the moodboard direction but change composition, materials, and lighting.`;
  }
  await generateImages();
}

export async function exportBoard() {
  const visibleItems = state.items.filter((item) => item.visible !== false);
  if (!visibleItems.length) {
    showToast("Board 上還沒有可匯出的內容。");
    return;
  }

  const minX = Math.max(0, Math.min(...visibleItems.map((it) => it.x)) - 40);
  const minY = Math.max(0, Math.min(...visibleItems.map((it) => it.y)) - 40);
  const maxX = Math.max(...visibleItems.map((it) => it.x + it.width)) + 40;
  const maxY = Math.max(...visibleItems.map((it) => it.y + it.height)) + 40;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(3200, Math.ceil(maxX - minX));
  canvas.height = Math.min(2400, Math.ceil(maxY - minY));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fbfaf5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const item of [...visibleItems].sort((a, b) => a.z - b.z)) {
    const x = item.x - minX;
    const y = item.y - minY;
    ctx.globalAlpha = item.opacity ?? 1;
    if (item.type === "note") {
      ctx.fillStyle = "#fff8c9";
      ctx.fillRect(x, y, item.width, item.height);
      ctx.fillStyle = "#262016";
      ctx.font = "20px system-ui, sans-serif";
      wrapText(ctx, item.text || "", x + 18, y + 36, item.width - 36, 26);
    } else {
      try {
        const image = await loadImage(item.src);
        ctx.drawImage(image, x, y, item.width, item.height);
      } catch {
        ctx.fillStyle = "#ddd6c7";
        ctx.fillRect(x, y, item.width, item.height);
      }
    }
  }
  ctx.globalAlpha = 1;

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `layerboard-${new Date().toISOString().slice(0, 10)}.png`;
  link.click();
  showToast("已匯出 PNG。");
}

export function pickRandomSeedPrompt() {
  return seedPrompts[Math.floor(Math.random() * seedPrompts.length)];
}
