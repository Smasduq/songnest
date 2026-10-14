import { useEffect, useState } from "react";

export interface ArtworkColors {
  first: string;
  second: string;
}

export const DEFAULT_SPARKLE_COLORS: ArtworkColors = {
  first: "#9E7AFF",
  second: "#FE8BBB",
};

const cache = new Map<string, ArtworkColors>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Pick two vivid, harmonized colors from raw pixels. Hue-bucketed:
 * the strongest vivid bucket wins, the runner-up must sit clearly
 * apart on the wheel (or is derived by rotation). Lightness is lifted
 * into sparkle range so the colors glow on either theme.
 */
export function pickFromPixels(data: Uint8ClampedArray): ArtworkColors {
  const BINS = 12;
  const counts = new Array<number>(BINS).fill(0);
  // Hue is circular: accumulate unit vectors so reds near 0°/360°
  // average to red, not cyan.
  const cosSum = new Array<number>(BINS).fill(0);
  const sinSum = new Array<number>(BINS).fill(0);
  const sats = new Array<number>(BINS).fill(0);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.3 || l < 0.2 || l > 0.85) continue;
    const bin = Math.floor(h / (360 / BINS)) % BINS;
    counts[bin] += 1;
    const rad = (h * Math.PI) / 180;
    cosSum[bin] += Math.cos(rad);
    sinSum[bin] += Math.sin(rad);
    sats[bin] += s;
  }

  const ranked = counts
    .map((c, bin) => ({ bin, count: c }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);

  // Near-monochrome artwork: fall back to the defaults.
  if (ranked.length === 0 || ranked[0].count < 8) {
    return DEFAULT_SPARKLE_COLORS;
  }

  const top = ranked[0];
  const wheelDist = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, BINS - d);
  };
  const runner =
    ranked.find((e) => e.bin !== top.bin && wheelDist(e.bin, top.bin) >= 2) ??
    null;

  const avgHueOf = (bin: number, count: number): number => {
    const deg =
      (Math.atan2(sinSum[bin] / count, cosSum[bin] / count) * 180) / Math.PI;
    return ((deg % 360) + 360) % 360;
  };

  const avgHue = avgHueOf(top.bin, top.count);
  const avgSat = sats[top.bin] / top.count;
  const first = hslToHex(avgHue, Math.max(avgSat, 0.7), 0.65);

  let second: string;
  if (runner !== null) {
    const rs = sats[runner.bin] / runner.count;
    second = hslToHex(
      avgHueOf(runner.bin, runner.count),
      Math.max(rs, 0.7),
      0.65,
    );
  } else {
    second = hslToHex(avgHue + 40, Math.max(avgSat, 0.7), 0.65);
  }
  return { first, second };
}

/**
 * Read two vivid colors out of an artwork URL. CORS-tainted canvases,
 * missing art, and slow loads all resolve to the defaults — never rejects.
 */
export function getArtworkColors(coverUrl: string): Promise<ArtworkColors> {
  const hit = cache.get(coverUrl);
  if (hit !== undefined) return Promise.resolve(hit);
  if (coverUrl === "") return Promise.resolve(DEFAULT_SPARKLE_COLORS);

  return new Promise((resolve) => {
    let done = false;
    const finish = (c: ArtworkColors) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(c);
    };
    const timer = window.setTimeout(
      () => finish(DEFAULT_SPARKLE_COLORS),
      10000,
    );

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 48;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx === null) {
          finish(DEFAULT_SPARKLE_COLORS);
          return;
        }
        // Cover-fit so letterboxing never dilutes the palette.
        const s = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        const dw = img.naturalWidth * s;
        const dh = img.naturalHeight * s;
        ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
        const colors = pickFromPixels(
          ctx.getImageData(0, 0, size, size).data,
        );
        cache.set(coverUrl, colors);
        finish(colors);
      } catch {
        // Tainted canvas (no CORS headers) — keep the defaults.
        finish(DEFAULT_SPARKLE_COLORS);
      }
    };
    img.onerror = () => finish(DEFAULT_SPARKLE_COLORS);
    img.src = coverUrl;
  });
}

/** Reactive palette for a track's artwork; defaults until extraction lands. */
export function useArtworkColors(coverUrl: string): ArtworkColors {
  const [colors, setColors] = useState<ArtworkColors>(
    () => cache.get(coverUrl) ?? DEFAULT_SPARKLE_COLORS,
  );
  useEffect(() => {
    if (coverUrl === "") {
      setColors(DEFAULT_SPARKLE_COLORS);
      return;
    }
    let alive = true;
    void getArtworkColors(coverUrl).then((c) => {
      if (alive) setColors(c);
    });
    return () => {
      alive = false;
    };
  }, [coverUrl]);
  return colors;
}
