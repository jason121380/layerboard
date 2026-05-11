/**
 * magic-layer.js — perceptual image segmentation + OCR text extraction.
 *
 * Modes (set via state.layerMode):
 *   - "auto"    (default): OCR every readable text line → editable text items
 *               in the system default font, then saliency split the rest into
 *               subject + background. Most "Magic Layer"-like.
 *   - "subject": frequency-tuned saliency in LAB → Otsu → morphology →
 *               largest connected region. Subject + background only.
 *   - "palette": k-means in LAB → k color layers ordered by area.
 *   - "text"   : Sobel edge density → text-vs-graph split (image only).
 *
 * OCR is loaded lazily from the Tesseract.js CDN; if it fails we fall back to
 * subject mode silently.
 */

import { state, dom, bumpZ, showToast, showLoadingProgress } from "./state.js";
import {
  uid,
  loadImage,
  rgbToLab,
  labDistanceSq,
  rgbToHex,
  otsuThreshold,
  boxBlur
} from "./utils.js";
import {
  createItem,
  getSelectedItem,
  getSelectedItems,
  selectItem,
  selectItems,
  syncItemElement,
  updateControls
} from "./items.js";

const MAX_PROCESS_SIDE = 720;
const KMEANS_SAMPLE_SIZE = 8000;
const KMEANS_MAX_ITER = 14;

const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_LANGS = ["eng", "chi_tra"];
const OCR_MIN_CONFIDENCE = 55;

// ====================================================================
// Shared helpers
// ====================================================================

function drawToCanvas(image) {
  const scale = Math.min(
    1,
    MAX_PROCESS_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return { ctx, width, height, data: ctx.getImageData(0, 0, width, height).data };
}

/**
 * Build an RGBA layer canvas from a binary mask.
 * Crops to the mask's bounding box and feathers edges by 1px alpha.
 */
function maskToLayer(data, srcWidth, srcHeight, mask) {
  let minX = srcWidth;
  let minY = srcHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < srcHeight; y += 1) {
    for (let x = 0; x < srcWidth; x += 1) {
      if (mask[y * srcWidth + x]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const padding = 2;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(srcWidth - 1, maxX + padding);
  maxY = Math.min(srcHeight - 1, maxY + padding);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(width, height);

  let area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x + minX;
      const sy = y + minY;
      const mIdx = sy * srcWidth + sx;
      if (!mask[mIdx]) continue;
      area += 1;
      const sIdx = mIdx * 4;
      const dIdx = (y * width + x) * 4;
      out.data[dIdx] = data[sIdx];
      out.data[dIdx + 1] = data[sIdx + 1];
      out.data[dIdx + 2] = data[sIdx + 2];
      // 1-px alpha feather: edge pixels (no neighbour) → 200, interior → 255
      const interior =
        sx > 0 &&
        sy > 0 &&
        sx < srcWidth - 1 &&
        sy < srcHeight - 1 &&
        mask[(sy - 1) * srcWidth + sx] &&
        mask[(sy + 1) * srcWidth + sx] &&
        mask[sy * srcWidth + sx - 1] &&
        mask[sy * srcWidth + sx + 1];
      out.data[dIdx + 3] = interior ? 255 : 220;
    }
  }
  ctx.putImageData(out, 0, 0);

  return {
    src: canvas.toDataURL("image/png"),
    x: minX,
    y: minY,
    width,
    height,
    area
  };
}

/** Morphological dilation (radius 1, 4-connected). */
function dilate(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < width - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - width]) ||
        (y < height - 1 && mask[i + width])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/** Morphological erosion (radius 1, 4-connected). */
function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      if (
        mask[i - 1] &&
        mask[i + 1] &&
        mask[i - width] &&
        mask[i + width]
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/**
 * Find all connected components in a binary mask. Returns an array of
 * { mask, area } sorted by area desc, filtered by minAreaRatio (fraction
 * of total pixels) and capped at maxCount.
 */
function findComponents(mask, width, height, minAreaRatio = 0.008, maxCount = 8) {
  const total = width * height;
  const minArea = Math.max(40, Math.round(total * minAreaRatio));
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);
      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; queue[tail++] = idx - 1; }
      if (x < width - 1 && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; queue[tail++] = idx + 1; }
      if (y > 0 && mask[idx - width] && !visited[idx - width]) { visited[idx - width] = 1; queue[tail++] = idx - width; }
      if (y < height - 1 && mask[idx + width] && !visited[idx + width]) { visited[idx + width] = 1; queue[tail++] = idx + width; }
    }

    if (tail >= minArea) {
      const m = new Uint8Array(mask.length);
      for (let i = 0; i < tail; i += 1) m[queue[i]] = 1;
      components.push({ mask: m, area: tail });
    }
  }

  components.sort((a, b) => b.area - a.area);
  return components.slice(0, maxCount);
}

/** Backwards-compat helper: returns a mask containing only the largest component. */
function largestComponent(mask, width, height) {
  const comps = findComponents(mask, width, height, 0, 1);
  return comps[0]?.mask || new Uint8Array(mask.length);
}

// ====================================================================
// Mode 1: Subject (saliency-based foreground / background split)
// ====================================================================

function getSensitivity() {
  const v = Number(dom.sensitivityInput?.value);
  if (Number.isFinite(v)) return v / 100;
  return 0.5;
}

function buildSaliencyMask(data, width, height, sensitivity) {
  // Build per-channel float images in LAB.
  const total = width * height;
  const labL = new Float32Array(total);
  const labA = new Float32Array(total);
  const labB = new Float32Array(total);
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;

  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    const lab = rgbToLab(data[px], data[px + 1], data[px + 2]);
    labL[i] = lab[0];
    labA[i] = lab[1];
    labB[i] = lab[2];
    sumL += lab[0];
    sumA += lab[1];
    sumB += lab[2];
  }
  const meanL = sumL / total;
  const meanA = sumA / total;
  const meanB = sumB / total;

  // Gaussian-ish smoothing via two box blurs.
  const radius = Math.max(2, Math.round(Math.min(width, height) / 80));
  const blurL = boxBlur(boxBlur(labL, width, height, radius), width, height, radius);
  const blurA = boxBlur(boxBlur(labA, width, height, radius), width, height, radius);
  const blurB = boxBlur(boxBlur(labB, width, height, radius), width, height, radius);

  // Saliency = distance between blurred LAB and global mean LAB.
  const saliency = new Float32Array(total);
  let maxSal = 0;
  for (let i = 0; i < total; i += 1) {
    const dl = blurL[i] - meanL;
    const da = blurA[i] - meanA;
    const db = blurB[i] - meanB;
    const v = Math.sqrt(dl * dl + da * da + db * db);
    saliency[i] = v;
    if (v > maxSal) maxSal = v;
  }

  // Normalise to 0..255 then Otsu threshold.
  const norm = new Uint8Array(total);
  if (maxSal > 0) {
    for (let i = 0; i < total; i += 1) {
      norm[i] = Math.min(255, Math.round((saliency[i] / maxSal) * 255));
    }
  }
  const auto = otsuThreshold(norm);
  // Sensitivity 0..1 nudges the threshold ±35 levels.
  const threshold = Math.max(8, Math.min(248, Math.round(auto + (sensitivity - 0.5) * 70)));

  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (norm[i] >= threshold) mask[i] = 1;
  }

  // Open then close: removes speckles + fills holes.
  let cleaned = erode(mask, width, height);
  cleaned = dilate(cleaned, width, height);
  cleaned = dilate(cleaned, width, height);
  cleaned = erode(cleaned, width, height);

  // Return the cleaned mask with ALL components; callers decide whether to
  // keep all of them as separate object layers or only the largest.
  return cleaned;
}

async function runSubjectMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const cleanedMask = buildSaliencyMask(data, width, height, getSensitivity());

  let totalArea = 0;
  for (let i = 0; i < cleanedMask.length; i += 1) totalArea += cleanedMask[i];
  if (totalArea / cleanedMask.length < 0.005) return [];

  // Multi-object: every salient connected component becomes its own layer.
  const components = findComponents(cleanedMask, width, height, 0.008, 8);
  if (!components.length) return [];

  const layers = [];
  for (let i = 0; i < components.length; i += 1) {
    const compLayer = maskToLayer(data, width, height, components[i].mask);
    if (compLayer) {
      layers.push({
        ...compLayer,
        kind: components.length === 1 ? "subject" : "object",
        objectIndex: i + 1,
        objectTotal: components.length
      });
    }
  }

  // Background = whatever wasn't claimed by any component.
  const claimed = new Uint8Array(cleanedMask.length);
  for (const c of components) {
    for (let i = 0; i < c.mask.length; i += 1) if (c.mask[i]) claimed[i] = 1;
  }
  const backgroundMask = new Uint8Array(cleanedMask.length);
  for (let i = 0; i < cleanedMask.length; i += 1) backgroundMask[i] = claimed[i] ? 0 : 1;
  const backgroundLayer = maskToLayer(data, width, height, backgroundMask);
  if (backgroundLayer) layers.push({ ...backgroundLayer, kind: "background" });

  return layers.map((layer) => ({ ...layer, sourceWidth: width, sourceHeight: height }));
}

// ====================================================================
// Mode 2: Palette (k-means in LAB)
// ====================================================================

function kmeansPlusPlusSeed(samples, k) {
  if (samples.length <= k) return samples.slice();
  const centroids = [];
  const firstIdx = Math.floor(Math.random() * samples.length);
  centroids.push(samples[firstIdx]);

  while (centroids.length < k) {
    let totalDist = 0;
    const dists = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      let best = Infinity;
      for (const c of centroids) {
        const d = labDistanceSq(samples[i], c);
        if (d < best) best = d;
      }
      dists[i] = best;
      totalDist += best;
    }
    if (!totalDist) break;
    let pick = Math.random() * totalDist;
    let chosen = 0;
    for (let i = 0; i < samples.length; i += 1) {
      pick -= dists[i];
      if (pick <= 0) {
        chosen = i;
        break;
      }
    }
    centroids.push(samples[chosen]);
  }

  return centroids;
}

function kmeans(samples, k) {
  let centroids = kmeansPlusPlusSeed(samples, k);
  const assignments = new Int32Array(samples.length);

  for (let iter = 0; iter < KMEANS_MAX_ITER; iter += 1) {
    let changed = 0;
    for (let i = 0; i < samples.length; i += 1) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = labDistanceSq(samples[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed += 1;
      }
    }

    const sums = centroids.map(() => [0, 0, 0]);
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < samples.length; i += 1) {
      const c = assignments[i];
      sums[c][0] += samples[i][0];
      sums[c][1] += samples[i][1];
      sums[c][2] += samples[i][2];
      counts[c] += 1;
    }
    centroids = sums.map((s, c) =>
      counts[c] ? [s[0] / counts[c], s[1] / counts[c], s[2] / counts[c]] : centroids[c]
    );

    if (!changed) break;
  }

  return centroids;
}

function pickK() {
  // Sensitivity 0..1 → k = 3..8
  const ratio = getSensitivity();
  return Math.min(8, Math.max(3, 3 + Math.round(ratio * 5)));
}

function labCentroidToHex(centroid) {
  // Inverse LAB → sRGB (approximate; fine for swatch labels).
  const fy = (centroid[0] + 16) / 116;
  const fx = centroid[1] / 500 + fy;
  const fz = fy - centroid[2] / 200;
  const finv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = 0.95047 * finv(fx);
  const y = 1.0 * finv(fy);
  const z = 1.08883 * finv(fz);
  const r = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const g = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const b = x * 0.0557 + y * -0.204 + z * 1.057;
  const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return rgbToHex(toSrgb(r) * 255, toSrgb(g) * 255, toSrgb(b) * 255);
}

async function runPaletteMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const total = width * height;
  const k = pickK();

  // Stratified random sample for centroid seeding.
  const stride = Math.max(1, Math.floor(total / KMEANS_SAMPLE_SIZE));
  const samples = [];
  const sampleIndices = [];
  for (let i = 0; i < total; i += stride) {
    const px = i * 4;
    if (data[px + 3] < 24) continue;
    samples.push(rgbToLab(data[px], data[px + 1], data[px + 2]));
    sampleIndices.push(i);
  }
  if (samples.length < k) return [];

  const centroids = kmeans(samples, k);

  // Assign every pixel to nearest centroid.
  const masks = Array.from({ length: k }, () => new Uint8Array(total));
  const counts = new Int32Array(k);
  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    if (data[px + 3] < 24) continue;
    const lab = rgbToLab(data[px], data[px + 1], data[px + 2]);
    let best = 0;
    let bestDist = Infinity;
    for (let c = 0; c < k; c += 1) {
      const d = labDistanceSq(lab, centroids[c]);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    masks[best][i] = 1;
    counts[best] += 1;
  }

  // Build layer images, sorted by area desc.
  const layers = [];
  for (let c = 0; c < k; c += 1) {
    if (counts[c] / total < 0.012) continue; // skip dust clusters
    const layer = maskToLayer(data, width, height, masks[c]);
    if (!layer) continue;
    layers.push({
      ...layer,
      kind: "palette",
      hex: labCentroidToHex(centroids[c]),
      sourceWidth: width,
      sourceHeight: height
    });
  }
  layers.sort((a, b) => b.area - a.area);
  return layers;
}

// ====================================================================
// Public: split selected items
// ====================================================================

// ====================================================================
// Mode 3: Text/Graph split — Sobel edge density → dilate → separate
// ====================================================================

async function runTextGraphMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);
  const total = width * height;

  // Grayscale
  const gray = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    const px = i * 4;
    gray[i] = 0.299 * data[px] + 0.587 * data[px + 1] + 0.114 * data[px + 2];
  }

  // Sobel edge magnitude
  const edgeMap = new Float32Array(total);
  let maxEdge = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -gray[(y - 1) * width + (x - 1)] + gray[(y - 1) * width + (x + 1)]
        - 2 * gray[y * width + (x - 1)] + 2 * gray[y * width + (x + 1)]
        - gray[(y + 1) * width + (x - 1)] + gray[(y + 1) * width + (x + 1)];
      const gy =
        -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)]
        + gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeMap[y * width + x] = mag;
      if (mag > maxEdge) maxEdge = mag;
    }
  }

  // Normalise → Otsu threshold
  const edgeNorm = new Uint8Array(total);
  if (maxEdge > 0) {
    for (let i = 0; i < total; i += 1) {
      edgeNorm[i] = Math.min(255, Math.round((edgeMap[i] / maxEdge) * 255));
    }
  }
  const edgeThresh = otsuThreshold(edgeNorm);
  let textMask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (edgeNorm[i] >= edgeThresh) textMask[i] = 1;
  }

  // Dilate to fill character interiors
  const dilateR = Math.max(2, Math.round(Math.min(width, height) / 55));
  for (let r = 0; r < dilateR; r += 1) textMask = dilate(textMask, width, height);

  const graphMask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) graphMask[i] = textMask[i] ? 0 : 1;

  const layers = [];
  const textLayer = maskToLayer(data, width, height, textMask);
  if (textLayer) layers.push({ ...textLayer, kind: "text" });
  const graphLayer = maskToLayer(data, width, height, graphMask);
  if (graphLayer) layers.push({ ...graphLayer, kind: "graph" });

  return layers.map((l) => ({ ...l, sourceWidth: width, sourceHeight: height }));
}

function captionFor(layer, base, index, total) {
  if (layer.kind === "text") return (layer.text || "文字").slice(0, 24);
  if (layer.kind === "graph") return "圖形";
  if (layer.kind === "subject") return `${base || "主體"}`;
  if (layer.kind === "object") {
    const n = layer.objectTotal || total;
    return `${base || "物件"} ${layer.objectIndex || index + 1}/${n}`;
  }
  if (layer.kind === "background") return `${base || "主體"} · 背景`;
  if (layer.kind === "palette") return `${layer.hex || `色彩 ${index + 1}`}`;
  return `${base || "圖層"} ${index + 1}/${total}`;
}

// ====================================================================
// Mode 4: Auto — OCR text → editable text items + saliency subject/bg
// ====================================================================

let tesseractScriptPromise = null;
let tesseractWorkerPromise = null;

function loadTesseractScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractScriptPromise) return tesseractScriptPromise;
  tesseractScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_CDN;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract global missing")));
    script.onerror = () => reject(new Error("Tesseract CDN load failed"));
    document.head.append(script);
  });
  return tesseractScriptPromise;
}

// Live progress hook for Tesseract. magicLayerSelected swaps this in.
let ocrProgressHook = null;
function setOcrProgressHook(fn) { ocrProgressHook = fn; }

function tesseractLogger(message) {
  if (!ocrProgressHook) return;
  // Each message: { status: "loading language traineddata" | "recognizing text" | …, progress: 0..1 }
  const status = message?.status || "";
  const pct = message?.progress != null ? Math.round(message.progress * 100) : null;
  const zh =
    status === "loading tesseract core" ? "OCR 引擎載入" :
    status === "initializing tesseract" ? "OCR 引擎啟動" :
    status === "loading language traineddata" ? "下載字典" :
    status === "initializing api" ? "OCR API 啟動" :
    status === "recognizing text" ? "辨識文字中" :
    status || "OCR 處理中";
  ocrProgressHook(pct != null ? `${zh} ${pct}%` : zh);
}

async function getOcrWorker() {
  if (tesseractWorkerPromise) return tesseractWorkerPromise;
  tesseractWorkerPromise = (async () => {
    const Tesseract = await loadTesseractScript();
    return Tesseract.createWorker(OCR_LANGS, 1, { logger: tesseractLogger });
  })().catch((err) => {
    tesseractWorkerPromise = null;
    throw err;
  });
  return tesseractWorkerPromise;
}

/** Sample the dominant text colour inside a bbox via Otsu split on luminance. */
function sampleTextColor(data, width, height, bbox) {
  const x0 = Math.max(0, Math.floor(bbox.x0));
  const y0 = Math.max(0, Math.floor(bbox.y0));
  const x1 = Math.min(width - 1, Math.ceil(bbox.x1));
  const y1 = Math.min(height - 1, Math.ceil(bbox.y1));
  if (x1 <= x0 || y1 <= y0) return "#26252a";

  const lums = [];
  const colors = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lums.push(Math.round(lum));
      colors.push([r, g, b, lum]);
    }
  }
  if (!colors.length) return "#26252a";

  const threshold = otsuThreshold(lums);
  let darkR = 0, darkG = 0, darkB = 0, darkN = 0;
  let lightR = 0, lightG = 0, lightB = 0, lightN = 0;
  for (const [r, g, b, lum] of colors) {
    if (lum < threshold) { darkR += r; darkG += g; darkB += b; darkN += 1; }
    else { lightR += r; lightG += g; lightB += b; lightN += 1; }
  }
  // Text class is usually the smaller pixel population inside its line bbox.
  const useDark = darkN > 0 && (darkN <= lightN || lightN === 0);
  const n = useDark ? darkN : lightN;
  if (!n) return "#26252a";
  const r = Math.round((useDark ? darkR : lightR) / n);
  const g = Math.round((useDark ? darkG : lightG) / n);
  const b = Math.round((useDark ? darkB : lightB) / n);
  return rgbToHex(r, g, b);
}

/**
 * Run OCR on the source image (at natural resolution for accuracy), then
 * return text payloads in *processed-canvas* coords so they line up with
 * masks built by other passes.
 */
async function ocrExtract(image, data, width, height) {
  let worker;
  try {
    worker = await getOcrWorker();
  } catch (err) {
    console.warn("[magic-layer] OCR unavailable:", err.message);
    return { items: [], bboxes: [] };
  }

  const ocrCanvas = document.createElement("canvas");
  ocrCanvas.width = image.naturalWidth;
  ocrCanvas.height = image.naturalHeight;
  ocrCanvas.getContext("2d").drawImage(image, 0, 0);

  let result;
  try {
    result = await worker.recognize(ocrCanvas);
  } catch (err) {
    console.warn("[magic-layer] OCR recognise failed:", err.message);
    return { items: [], bboxes: [] };
  }

  const lines = result?.data?.lines || [];
  const scale = width / image.naturalWidth; // natural → processed coord scale

  const items = [];
  const bboxes = [];
  for (const line of lines) {
    const text = (line.text || "").replace(/\s+$/g, "");
    if (!text || text.trim().length < 2) continue;
    if ((line.confidence ?? 0) < OCR_MIN_CONFIDENCE) continue;

    const x0 = Math.max(0, Math.round(line.bbox.x0 * scale));
    const y0 = Math.max(0, Math.round(line.bbox.y0 * scale));
    const x1 = Math.min(width, Math.round(line.bbox.x1 * scale));
    const y1 = Math.min(height, Math.round(line.bbox.y1 * scale));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 6 || h < 6) continue;

    const color = sampleTextColor(data, width, height, { x0, y0, x1, y1 });

    items.push({
      kind: "text",
      x: x0,
      y: y0,
      width: w,
      height: h,
      text,
      // 0.78 of bbox height matches the typical cap-height ratio of latin/CJK fonts.
      fontSize: Math.max(6, h * 0.78),
      color
    });
    bboxes.push({ x0, y0, x1, y1 });
  }

  return { items, bboxes };
}

/** Zero out a mask wherever a text bbox overlaps. */
function maskOutBboxes(mask, width, height, bboxes, padding = 2) {
  for (const bbox of bboxes) {
    const x0 = Math.max(0, bbox.x0 - padding);
    const y0 = Math.max(0, bbox.y0 - padding);
    const x1 = Math.min(width - 1, bbox.x1 + padding);
    const y1 = Math.min(height - 1, bbox.y1 + padding);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        mask[y * width + x] = 0;
      }
    }
  }
}

async function runAutoMode(selected) {
  const image = await loadImage(selected.src);
  const { data, width, height } = drawToCanvas(image);

  const { items: textItems, bboxes: textBboxes } = await ocrExtract(image, data, width, height);

  // No text found → don't force-split into subject/background. Magic Layer in
  // auto mode is text-focused; user can switch to "subject" / "palette" via
  // state.layerMode when they want image splitting.
  if (!textItems.length) return [];

  const cleanedMask = buildSaliencyMask(data, width, height, getSensitivity());
  maskOutBboxes(cleanedMask, width, height, textBboxes, 2);

  let totalArea = 0;
  for (let i = 0; i < cleanedMask.length; i += 1) totalArea += cleanedMask[i];

  const out = textItems.map((t) => ({ ...t, sourceWidth: width, sourceHeight: height }));

  // Beyond text, also separate every distinct salient object as its own
  // layer (multi-component). Skipped when nothing meaningful is left.
  if (totalArea / cleanedMask.length > 0.02) {
    const components = findComponents(cleanedMask, width, height, 0.008, 8);
    for (let i = 0; i < components.length; i += 1) {
      const compLayer = maskToLayer(data, width, height, components[i].mask);
      if (compLayer) {
        out.push({
          ...compLayer,
          kind: components.length === 1 ? "subject" : "object",
          objectIndex: i + 1,
          objectTotal: components.length,
          sourceWidth: width,
          sourceHeight: height
        });
      }
    }
    const claimed = new Uint8Array(cleanedMask.length);
    for (const c of components) {
      for (let i = 0; i < c.mask.length; i += 1) if (c.mask[i]) claimed[i] = 1;
    }
    const backgroundMask = new Uint8Array(cleanedMask.length);
    for (let i = 0; i < cleanedMask.length; i += 1) backgroundMask[i] = claimed[i] ? 0 : 1;
    maskOutBboxes(backgroundMask, width, height, textBboxes, 2);
    const backgroundLayer = maskToLayer(data, width, height, backgroundMask);
    if (backgroundLayer) out.push({ ...backgroundLayer, kind: "background", sourceWidth: width, sourceHeight: height });
  }

  return out;
}

async function runForMode(selected, mode) {
  if (mode === "auto") return runAutoMode(selected);
  if (mode === "palette") return runPaletteMode(selected);
  if (mode === "text") return runTextGraphMode(selected);
  return runSubjectMode(selected);
}

async function splitItemIntoLayers(selected) {
  const mode = state.layerMode || "auto";
  let layers = await runForMode(selected, mode);
  // Subject mode can return empty for low-contrast images — fall back to
  // palette so the user still gets *something*. "auto" mode intentionally
  // doesn't fall back: no text means no magic layer.
  if (!layers.length && mode === "subject") {
    layers = await runPaletteMode(selected);
  }

  if (!layers.length) return { group: null, layers: [] };

  const group = uid("layer-group");
  const scaleX = selected.width / layers[0].sourceWidth;
  const scaleY = selected.height / layers[0].sourceHeight;

  const created = layers.map((layer, index) => {
    if (layer.kind === "text") {
      return createItem({
        type: "text",
        text: layer.text,
        caption: captionFor(layer, selected.caption, index, layers.length),
        x: Math.round(selected.x + layer.x * scaleX),
        y: Math.round(selected.y + layer.y * scaleY),
        width: Math.max(48, Math.round(layer.width * scaleX)),
        height: Math.max(14, Math.round(layer.height * scaleY)),
        fontSize: Math.max(10, Math.round(layer.fontSize * scaleY)),
        color: layer.color,
        layerGroup: group,
        sourceId: selected.id,
        select: false
      });
    }
    return createItem({
      type: "layer",
      src: layer.src,
      caption: captionFor(layer, selected.caption, index, layers.length),
      x: Math.round(selected.x + layer.x * scaleX),
      y: Math.round(selected.y + layer.y * scaleY),
      width: Math.max(34, Math.round(layer.width * scaleX)),
      height: Math.max(34, Math.round(layer.height * scaleY)),
      fit: "contain",
      layerGroup: group,
      sourceId: selected.id,
      select: false
    });
  });

  selected.visible = false;
  syncItemElement(selected);
  return { group, layers: created };
}

export async function magicLayerSelected() {
  const targets = getSelectedItems().filter(
    (item) => ["image", "layer"].includes(item.type) && item.src
  );
  if (!targets.length) return;

  if (dom.magicBtn) {
    dom.magicBtn.disabled = true;
    dom.magicBtn.classList.add("is-busy");
    dom.magicBtn.textContent = "拆解中…";
  }

  const mode = state.layerMode || "auto";
  const firstRun = mode === "auto" && !window.Tesseract;
  const progress = showLoadingProgress(
    firstRun ? "OCR 首次啟動：下載引擎 + 字典約 10–15 MB…" : "拆解圖層中…"
  );
  setOcrProgressHook((label) => progress.update(label));

  try {
    const createdLayers = [];
    let lastGroup = null;
    for (let i = 0; i < targets.length; i += 1) {
      if (targets.length > 1) {
        progress.update(`處理第 ${i + 1} / ${targets.length} 張…`);
      }
      const result = await splitItemIntoLayers(targets[i]);
      createdLayers.push(...result.layers);
      lastGroup = result.group || lastGroup;
    }

    if (!createdLayers.length) {
      const autoMsg = mode === "auto"
        ? "這張圖沒有偵測到文字，原圖層保持不變。"
        : "沒有分出可用的圖層。試試別張圖或調整 sensitivity。";
      progress.end(autoMsg);
      return;
    }

    selectItems(createdLayers.map((layer) => layer.id));
    renderLayerPanel(targets.length === 1 ? lastGroup : null);
    const textCount = createdLayers.filter((l) => l.type === "text").length;
    const layerCount = createdLayers.length - textCount;
    const summary = textCount
      ? `拆出 ${textCount} 段可編輯文字${layerCount ? ` + ${layerCount} 個圖層` : ""}。`
      : `從 ${targets.length} 張圖拆出 ${createdLayers.length} 個圖層。`;
    progress.end(summary);
  } catch (error) {
    progress.end(`拆解失敗：${error.message}`);
  } finally {
    setOcrProgressHook(null);
    if (dom.magicBtn) dom.magicBtn.classList.remove("is-busy");
    updateControls();
  }
}

// ====================================================================
// Layer panel render
// ====================================================================

export function renderLayerPanel(_group = null) {
  // Panel removed — no-op.
}
