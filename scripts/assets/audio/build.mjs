#!/usr/bin/env node
// Builds the placeholder sound set into `public/assets/audio/` (SPEC-006 §2).
//
//   node scripts/assets/audio/build.mjs [bankId …] [--wav=DIR]
//
// Every bank and track in `ASSETS.audio` (`src/data/assets.ts`) is synthesised
// (`sfx.mjs`, `music.mjs`), encoded to Opus by libopus inside Playwright's
// Chromium (`opus.mjs`) and muxed into the manifest's `.webm` (`webm.mjs`).
// The `.mp3` fallback is written too when `lame` is on PATH. Pass bank ids to
// rebuild only those, and `--wav=DIR` to keep 16-bit renders for listening.
// The output is deterministic: a rebuild writes the same samples.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS } from '../../../src/data/assets.ts';
import { rng, SR } from './dsp.mjs';
import { TRACKS } from './music.mjs';
import { encodeOpus } from './opus.mjs';
import { renderSfxBank } from './sfx.mjs';
import { opusWebm } from './webm.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public');
/** Opus bitrates in bit/s: the sfx banks are mono, the music is stereo. */
const OPUS_BPS = { sfx: 64000, music: 112000 };
/** MP3 CBR in kbit/s, for the browsers that cannot take Opus. */
const MP3_KBPS = { sfx: 96, music: 160 };
const MUSIC_PREFIX = 'music_';
/** 100 ms of a track's tail encoded in front of it, and 40 ms of its head behind it. */
const PRE_ROLL = 4800;
const POST_ROLL = 1920;

function available(command) {
  return spawnSync(command, ['--help'], { stdio: 'ignore' }).error?.code !== 'ENOENT';
}

/** 16-bit PCM WAV with TPDF dither, interleaved — for `lame` and for listening. */
function writeWav(channels, path) {
  const frames = channels[0].length;
  const count = channels.length;
  const out = Buffer.alloc(44 + frames * count * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + frames * count * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(count, 22);
  out.writeUInt32LE(SR, 24);
  out.writeUInt32LE(SR * count * 2, 28);
  out.writeUInt16LE(count * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(frames * count * 2, 40);
  const dither = rng(1);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const value = channels[c][i] * 32767 + (dither() - dither());
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), 44 + (i * count + c) * 2);
    }
  }
  writeFileSync(path, out);
}

/**
 * A track loops over the whole file, so its seam is the file's two ends: it is
 * encoded with its own tail in front and its head behind, and the WebM trims
 * both off again (`webm.mjs`). A bank's loops carry their own roll (`sfx.mjs`).
 */
function rolled(channels) {
  return channels.map((c) => {
    const out = new Float32Array(PRE_ROLL + c.length + POST_ROLL);
    out.set(c.subarray(c.length - PRE_ROLL), 0);
    out.set(c, PRE_ROLL);
    out.set(c.subarray(0, POST_ROLL), PRE_ROLL + c.length);
    return out;
  });
}

const kb = (path) => `${(statSync(path).size / 1024).toFixed(0).padStart(4)} KB`;

const args = process.argv.slice(2);
const wavDir = args.find((arg) => arg.startsWith('--wav='))?.slice('--wav='.length);
const only = new Set(args.filter((arg) => !arg.startsWith('--')));
for (const id of only) {
  if (!(id in ASSETS.audio)) throw new Error(`"${id}" is not a bank in ASSETS.audio`);
}
const lame = available('lame');

const renders = [];
for (const [id, entry] of Object.entries(ASSETS.audio)) {
  if (only.size > 0 && !only.has(id)) continue;
  const started = performance.now();
  const kind = entry.sprite === undefined ? 'music' : 'sfx';
  let channels;
  if (kind === 'sfx') {
    channels = [renderSfxBank(entry.sprite)];
  } else {
    const track = TRACKS[id.slice(MUSIC_PREFIX.length)];
    if (track === undefined) throw new Error(`no track for "${id}" — add one to scripts/assets/audio/music.mjs`);
    channels = track();
  }
  renders.push({ id, entry, kind, channels, ms: performance.now() - started });
}

// One browser for the whole set.
const encoded = await encodeOpus(
  renders.map(({ kind, channels }) => ({ channels: kind === 'music' ? rolled(channels) : channels, bitrate: OPUS_BPS[kind] })),
);

const wavRoot = wavDir ?? (lame ? mkdtempSync(join(tmpdir(), 'reallm-audio-')) : null);
if (wavDir !== undefined) mkdirSync(wavDir, { recursive: true });
try {
  renders.forEach(({ id, entry, kind, channels, ms }, k) => {
    const frames = channels[0].length;
    const [webmSrc, mp3Src] = entry.src;
    const webm = join(PUBLIC, webmSrc);
    mkdirSync(dirname(webm), { recursive: true });
    writeFileSync(webm, opusWebm(encoded[k], kind === 'music' ? { skip: PRE_ROLL, keep: frames } : { keep: frames }));
    let report = `${id.padEnd(22)} ${(frames / SR).toFixed(2).padStart(6)} s  ${channels.length === 1 ? 'mono  ' : 'stereo'}  webm ${kb(webm)}`;

    if (wavRoot !== null) {
      const wav = join(wavRoot, `${id}.wav`);
      writeWav(channels, wav);
      if (lame) {
        const mp3 = join(PUBLIC, mp3Src);
        execFileSync('lame', ['--quiet', '--noreplaygain', '-b', String(MP3_KBPS[kind]), ...(kind === 'sfx' ? ['-m', 'm'] : []), wav, mp3]);
        report += `  mp3 ${kb(mp3)}`;
      }
    }
    console.log(`${report}  (rendered in ${Math.round(ms)} ms)`);
  });
  if (!lame) console.warn('\n`lame` is not on PATH, so no .mp3 fallback was written (brew install lame).');
} finally {
  if (wavRoot !== null && wavDir === undefined) rmSync(wavRoot, { recursive: true, force: true });
}
