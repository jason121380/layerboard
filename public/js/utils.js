/**
 * utils.js — pure helpers, no DOM state.
 */

export function uid(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to read that image."));
    image.src = src;
  });
}

export function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function pixelAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return [data[index], data[index + 1], data[index + 2], data[index + 3]];
}

export function quantizeColor(r, g, b, bucket) {
  return [
    Math.round(r / bucket) * bucket,
    Math.round(g / bucket) * bucket,
    Math.round(b / bucket) * bucket
  ];
}

// ---------- Color: sRGB ↔ LAB ----------
const LAB_KAPPA = 0.008856;
const LAB_REF = [0.95047, 1.0, 1.08883]; // D65 white

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labF(t) {
  return t > LAB_KAPPA ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / LAB_REF[0];
  const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / LAB_REF[1];
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / LAB_REF[2];
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labDistanceSq(a, b) {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

export function rgbToHex(r, g, b) {
  const clip = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${clip(r)}${clip(g)}${clip(b)}`;
}

// ---------- Otsu's automatic threshold ----------
export function otsuThreshold(values, max = 255) {
  const bins = max + 1;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v < 0 || !Number.isFinite(v)) continue;
    hist[Math.min(max, Math.floor(v))] += 1;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i += 1) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let varMax = 0;
  let threshold = 0;
  for (let t = 0; t < bins; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > varMax) {
      varMax = variance;
      threshold = t;
    }
  }
  return threshold;
}

// ---------- 1-D box blur (separable, fast) ----------
export function boxBlur(src, width, height, radius) {
  if (radius <= 0) return src;
  const dst = new Float32Array(src.length);
  const kernel = radius * 2 + 1;

  // Horizontal
  for (let y = 0; y < height; y += 1) {
    let acc = 0;
    const row = y * width;
    for (let x = -radius; x < width; x += 1) {
      const inIdx = row + Math.min(width - 1, Math.max(0, x + radius));
      acc += src[inIdx];
      if (x - radius - 1 >= 0) acc -= src[row + (x - radius - 1)];
      if (x >= 0) dst[row + x] = acc / kernel;
    }
  }
  // Vertical (reuse src as scratch)
  const tmp = new Float32Array(src.length);
  for (let x = 0; x < width; x += 1) {
    let acc = 0;
    for (let y = -radius; y < height; y += 1) {
      const inIdx = Math.min(height - 1, Math.max(0, y + radius)) * width + x;
      acc += dst[inIdx];
      if (y - radius - 1 >= 0) acc -= dst[(y - radius - 1) * width + x];
      if (y >= 0) tmp[y * width + x] = acc / kernel;
    }
  }
  return tmp;
}

export function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

export function intersectsRect(item, rect) {
  if (item.visible === false) return false;
  return (
    item.x < rect.x + rect.width &&
    item.x + item.width > rect.x &&
    item.y < rect.y + rect.height &&
    item.y + item.height > rect.y
  );
}

export function getItemsBounds(targetItems) {
  const minX = Math.min(...targetItems.map((i) => i.x));
  const minY = Math.min(...targetItems.map((i) => i.y));
  const maxX = Math.max(...targetItems.map((i) => i.x + i.width));
  const maxY = Math.max(...targetItems.map((i) => i.y + i.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

export function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const lines = (text || "").split("\n");
  let cursorY = y;
  for (const line of lines) {
    const words = line.split(/\s+/);
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        ctx.fillText(current, x, cursorY);
        cursorY += lineHeight;
        current = word;
      } else {
        current = test;
      }
    }
    ctx.fillText(current, x, cursorY);
    cursorY += lineHeight;
  }
}
