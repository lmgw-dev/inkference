// A minimal PNG reader, enough for the screenshots WebDriver BiDi hands back (8-bit RGB/RGBA,
// non-interlaced). It exists so dark-check can grade the PIXELS IT ACTUALLY RENDERED instead of
// trusting the DOM-side census alone.
//
// Why that matters: the census hit-tests a grid with elementsFromPoint and reads each element's
// computed background. A painter that is not an element's own background is invisible to it —
// amazon.de fills its page gutters with `box-shadow: rgb(240,242,242) 0 0 0 2000px`, which paints
// OUTSIDE the element's box and is not hit-testable, so the census scored a page whose gutters
// were plainly light as 0% light. Pixels cannot be fooled that way.
//
// No dependency on purpose: the repo has no image library and this is ~70 lines of spec.

import { inflateSync } from "node:zlib";

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

// Paeth, straight from the PNG spec.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Returns { width, height, channels, data } with data as raw samples, row-major.
export function decodePng(buf) {
  for (let i = 0; i < SIG.length; i++) {
    if (buf[i] !== SIG[i]) throw new Error("not a PNG");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + data + crc
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  if (depth !== 8) throw new Error("only 8-bit PNG supported, got depth " + depth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("unsupported colour type " + colorType);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const o = y * stride;
    const prev = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[o + x - channels] : 0; // left
      const b = y > 0 ? out[prev + x] : 0; // up
      const c = y > 0 && x >= channels ? out[prev + x - channels] : 0; // up-left
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error("bad row filter " + filter);
      out[o + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// The same definition of "light" the paint census uses (keep LIGHT_LUMINANCE in sync):
// WCAG relative luminance over 0.3.
const srgb = (n) => {
  const v = n / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

// Fraction of sampled pixels that read light. `step` subsamples — every 4th pixel in each
// direction is ~16x less work and moves the answer by well under a percent.
export function lightFractionOf(png, step = 4) {
  const { width, height, channels, data } = png;
  let light = 0;
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width * channels + x * channels;
      const l = 0.2126 * srgb(data[i]) + 0.7152 * srgb(data[i + 1]) + 0.0722 * srgb(data[i + 2]);
      if (l > 0.3) light++;
      total++;
    }
  }
  return total ? light / total : 0;
}
