// WebP through Chromium's libwebp — the browser Playwright already installs for
// the e2e suite — for the stand-in build (scripts/assets/README.md §7), which
// runs where Blender, numpy and PIL do not.
//
// A canvas premultiplies its pixels, so `toBlob` would lose the colour under a
// transparent pixel and the precision of every faint one: a ground layer whose
// alpha is height (or an emissive mask that is 0 almost everywhere) would come
// back black. So each picture is encoded in two passes and muxed by hand:
//   * the colour, drawn opaque, through `toBlob('image/webp', q)` — lossy VP8,
//     what Blender's `img.save(quality=q)` writes;
//   * the alpha, drawn as an opaque grey picture, through `toBlob(…, 1.0)` —
//     Chromium's lossless VP8L — whose image stream becomes an `ALPH` chunk
//     with lossless compression (the WebP container spec, "Alpha").
// The result is a plain VP8X + ALPH + VP8 file, with no ICC profile, and its
// alpha is exact.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Routed inside the browser, never fetched. */
const ORIGIN = 'https://reallm-standin.invalid';

/** RIFF chunks of a WebP file: `[{ id, data }]` in file order. */
export function webpChunks(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  const chunks = [];
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    chunks.push({ id, data: buf.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size & 1);
  }
  return chunks;
}

function chunk(id, data) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}

/** A WebP file from a lossy `VP8 ` payload and, optionally, a lossless alpha stream. */
export function muxWebp(width, height, vp8, alphaStream) {
  if (alphaStream === null) {
    const body = chunk('VP8 ', vp8);
    return Buffer.concat([Buffer.from('RIFF'), u32(4 + body.length), Buffer.from('WEBP'), body]);
  }
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x10; // the alpha flag
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  // ALPH header: no pre-processing, no filtering, compression 1 (lossless).
  const alph = Buffer.concat([Buffer.from([0x01]), alphaStream]);
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('ALPH', alph), chunk('VP8 ', vp8)]);
  return Buffer.concat([Buffer.from('RIFF'), u32(4 + body.length), Buffer.from('WEBP'), body]);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/**
 * One Chromium for a whole build. `encode(rgba, width, height, quality)` takes
 * straight (not premultiplied) 8-bit RGBA, row 0 at the top, and resolves to
 * the WebP bytes; `quality` is libwebp's 0–100, as `save_webp` passes it.
 * `decode(bytes)` reads a WebP back to straight RGBA through a WebGL texture
 * upload, which leaves the colour under transparent pixels alone.
 */
export async function openCodec() {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const bodies = new Map();
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>webp</title>' });
    const body = bodies.get(path);
    return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'application/octet-stream', body });
  });
  await page.goto(`${ORIGIN}/`);
  let serial = 0;

  async function encode(rgba, width, height, quality) {
    if (rgba.length !== width * height * 4) throw new Error(`encode: ${rgba.length} bytes for ${width}×${height}`);
    const path = `/rgba/${serial++}`;
    bodies.set(path, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
    const out = await page.evaluate(encodeInPage, { path, width, height, quality: quality / 100 });
    bodies.delete(path);
    const vp8 = webpChunks(Buffer.from(out.colour, 'base64')).find((c) => c.id === 'VP8 ');
    if (vp8 === undefined) throw new Error('Chromium wrote no lossy VP8 chunk');
    let alphaStream = null;
    if (out.alpha !== null) {
      const vp8l = webpChunks(Buffer.from(out.alpha, 'base64')).find((c) => c.id === 'VP8L');
      if (vp8l === undefined) throw new Error('Chromium wrote no lossless VP8L chunk for the alpha');
      // The VP8L header is a signature byte and 32 bits of size and flags; an
      // ALPH stream is the image stream alone, its size implied by the canvas.
      alphaStream = vp8l.data.subarray(5);
    }
    return muxWebp(width, height, vp8.data, alphaStream);
  }

  async function decode(bytes) {
    const path = `/webp/${serial++}`;
    bodies.set(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const out = await page.evaluate(decodeInPage, { path });
    bodies.delete(path);
    return { width: out.width, height: out.height, data: new Uint8Array(Buffer.from(out.data, 'base64')) };
  }

  return { encode, decode, page, close: () => browser.close() };
}

/** Runs inside the page: the colour pass and, when anything is translucent, the alpha pass. */
async function encodeInPage({ path, width, height, quality }) {
  const rgba = new Uint8ClampedArray(await (await fetch(path)).arrayBuffer());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  const toBase64 = async (q) => {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', q));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const colour = new ImageData(width, height);
  let translucent = false;
  for (let i = 0; i < rgba.length; i += 4) {
    colour.data[i] = rgba[i];
    colour.data[i + 1] = rgba[i + 1];
    colour.data[i + 2] = rgba[i + 2];
    colour.data[i + 3] = 255;
    if (rgba[i + 3] !== 255) translucent = true;
  }
  g.putImageData(colour, 0, 0);
  const out = { colour: await toBase64(quality), alpha: null };
  if (translucent) {
    const grey = new ImageData(width, height);
    for (let i = 0; i < rgba.length; i += 4) {
      grey.data[i] = grey.data[i + 1] = grey.data[i + 2] = rgba[i + 3];
      grey.data[i + 3] = 255;
    }
    g.putImageData(grey, 0, 0);
    out.alpha = await toBase64(1.0);
  }
  return out;
}

/** Runs inside the page: a WebP to straight RGBA, through an unpremultiplied WebGL upload. */
async function decodeInPage({ path }) {
  const blob = await (await fetch(path)).blob();
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { width, height } = bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return { width, height, data: btoa(s) };
}
