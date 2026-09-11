// libopus through Chromium's WebCodecs `AudioEncoder` — the browser Playwright
// already installs for the e2e suite (`npx playwright install chromium`) — so
// the build needs no native encoder and runs on any OS.
//
// Not macOS `afconvert -d opus`: Apple's encoder runs libopus in its VoIP
// application, which high-passes the input at about 60 Hz (-12 dB at 30 Hz,
// -5 dB at 50 Hz, with the phase turned half-way round), and that takes the
// kick and the bass fundamentals with it. Here the encoder is asked for the
// `audio` application and a music signal.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Routed inside the browser, never fetched: an https origin is a secure context, which WebCodecs needs. */
const ORIGIN = 'https://reallm-audio.invalid';

/**
 * Encodes each job `{ channels: Float32Array[], bitrate }` (48 kHz) into 20 ms
 * Opus packets. Resolves, in job order, to `{ channels, priming, frames,
 * packets }`: `priming` is the encoder's pre-skip, the samples of delay in
 * front of the first real one, and `frames` is the input length.
 */
export async function encodeOpus(jobs) {
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const bodies = new Map();
    await page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>opus</title>' });
      const body = bodies.get(path);
      return body === undefined ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'application/octet-stream', body });
    });
    await page.goto(`${ORIGIN}/`);

    const results = [];
    for (const [k, job] of jobs.entries()) {
      const frames = job.channels[0].length;
      // Planar float32, channel after channel: a fetch moves it in one piece.
      const pcm = Buffer.alloc(frames * job.channels.length * 4);
      job.channels.forEach((c, i) => Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(pcm, i * frames * 4));
      const path = `/pcm/${k}`;
      bodies.set(path, pcm);
      const out = await page.evaluate(inPage, { path, channels: job.channels.length, frames, bitrate: job.bitrate });
      bodies.delete(path);
      results.push({
        channels: job.channels.length,
        priming: out.priming,
        frames,
        packets: out.packets.map((b64) => Buffer.from(b64, 'base64')),
      });
    }
    return results;
  } finally {
    await browser.close();
  }
}

/** Runs inside the page: one `AudioEncoder` pass over one PCM body. */
async function inPage({ path, channels, frames, bitrate }) {
  const planar = new Float32Array(await (await fetch(path)).arrayBuffer());
  const config = {
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: channels,
    bitrate,
    opus: { application: 'audio', signal: 'music', complexity: 10, frameDuration: 20000 },
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`this Chromium cannot encode ${JSON.stringify(config)}`);

  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
      const d = meta?.decoderConfig?.description;
      if (d !== undefined) description = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(config);
  const CHUNK = 48000;
  for (let at = 0; at < frames; at += CHUNK) {
    const n = Math.min(CHUNK, frames - at);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) data.set(planar.subarray(c * frames + at, c * frames + at + n), c * n);
    const audio = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((at / 48000) * 1e6), data });
    encoder.encode(audio);
    audio.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure !== null) throw failure;

  const base64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // OpusHead bytes 10–11 (little-endian) are the pre-skip; libopus at 48 kHz says 312.
  const priming = description !== null && description.length >= 12 ? description[10] | (description[11] << 8) : 312;
  return { priming, packets: packets.map(base64), echoed: support.config.opus ?? null };
}
