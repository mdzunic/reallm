// Opus packets (`opus.mjs`) → Opus-in-WebM, the container the manifest ships
// (SPEC-006 §2). Pure Node, no dependencies.
//
// The trim travels with the packets: the encoder's pre-skip (plus any pre-roll
// the caller asks to skip) becomes the track's `CodecDelay` and the OpusHead
// pre-skip, and whatever follows the last sample kept becomes the last block's
// `DiscardPadding`. A decoder that honours both hands back exactly the samples
// asked for. That is what makes a seamless loop possible: encode the loop with
// its own tail in front and its head behind, so the codec sees the right
// neighbours on both sides of the seam, then keep exactly one period.

const SAMPLE_RATE = 48000;
/** 20 ms, the frame duration `opus.mjs` asks the encoder for. */
const FRAMES_PER_PACKET = 960;
const MS_PER_PACKET = (FRAMES_PER_PACKET / SAMPLE_RATE) * 1000;

/** Samples one packet decodes to, from its TOC byte (RFC 6716 §3.1). */
function packetFrames(packet) {
  const config = packet[0] >> 3;
  let size;
  if (config < 12) size = [480, 960, 1920, 2880][config & 3]; // SILK
  else if (config < 16) size = [480, 960][config & 1]; // hybrid
  else size = [120, 240, 480, 960][config & 3]; // CELT
  const code = packet[0] & 3;
  return size * (code === 0 ? 1 : code === 3 ? packet[1] & 0x3f : 2);
}

// ------------------------------------------------------------------ EBML

function id(n) {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, 'hex');
}

/** An element size as an EBML variable-length integer, shortest form. */
function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new RangeError('element too large');
}

const element = (n, body) => Buffer.concat([id(n), vint(body.length), body]);
const master = (n, children) => element(n, Buffer.concat(children));
const str = (n, s) => element(n, Buffer.from(s, 'ascii'));

function uint(n, v) {
  const bytes = [];
  let x = v;
  do {
    bytes.unshift(x % 256);
    x = Math.floor(x / 256);
  } while (x > 0);
  return element(n, Buffer.from(bytes));
}

function int(n, v) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(v));
  return element(n, b);
}

function float(n, v) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return element(n, b);
}

/** Track 1, a timestamp relative to the cluster, then the Opus packet. */
function block(packet, relativeMs, flags) {
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head.writeInt16BE(relativeMs, 1);
  head[3] = flags;
  return Buffer.concat([head, packet]);
}

/** Five-second clusters keep every relative timestamp in int16. */
const PACKETS_PER_CLUSTER = 250;

/**
 * Muxes `{ channels, priming, frames, packets }` from `encodeOpus` into WebM.
 * The first `skip` of the `frames` input samples are decoded and dropped, and
 * `keep` samples follow them; packets that only carry audio past the last
 * sample kept are left out.
 */
export function opusWebm({ channels, priming, frames, packets }, { skip = 0, keep = frames - skip } = {}) {
  const ns = (samples) => Math.round((samples / SAMPLE_RATE) * 1e9);
  const preSkip = priming + skip;
  if (preSkip > 0xffff) throw new RangeError(`a pre-skip of ${preSkip} samples does not fit the OpusHead`);
  if (skip + keep > frames) throw new RangeError('keep runs past the encoded audio');
  const end = preSkip + keep;
  const count = Math.ceil(end / FRAMES_PER_PACKET);
  if (count > packets.length) throw new RangeError(`${count} packets are needed but the encoder returned ${packets.length}`);
  for (const packet of packets.slice(0, count)) {
    if (packetFrames(packet) !== FRAMES_PER_PACKET) throw new Error(`a packet of ${packetFrames(packet)} samples, not ${FRAMES_PER_PACKET}`);
  }
  const discard = count * FRAMES_PER_PACKET - end;

  // RFC 7845 §5.1, channel mapping family 0 (mono or stereo).
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead', 0, 'latin1');
  opusHead[8] = 1;
  opusHead[9] = channels;
  opusHead.writeUInt16LE(preSkip, 10);
  opusHead.writeUInt32LE(SAMPLE_RATE, 12);

  const header = master(0x1a45dfa3, [
    uint(0x4286, 1), // EBMLVersion
    uint(0x42f7, 1), // EBMLReadVersion
    uint(0x42f2, 4), // EBMLMaxIDLength
    uint(0x42f3, 8), // EBMLMaxSizeLength
    str(0x4282, 'webm'),
    uint(0x4287, 4), // DocTypeVersion
    uint(0x4285, 2), // DocTypeReadVersion
  ]);
  const info = master(0x1549a966, [
    uint(0x2ad7b1, 1_000_000), // TimestampScale: 1 ms
    float(0x4489, (keep / SAMPLE_RATE) * 1000), // Duration, in TimestampScale units
    str(0x4d80, 'reallm scripts/assets/audio'),
    str(0x5741, 'reallm scripts/assets/audio'),
  ]);
  const tracks = master(0x1654ae6b, [
    master(0xae, [
      uint(0xd7, 1), // TrackNumber
      uint(0x73c5, 1), // TrackUID
      uint(0x83, 2), // TrackType: audio
      uint(0x9c, 0), // FlagLacing
      str(0x86, 'A_OPUS'),
      element(0x63a2, opusHead), // CodecPrivate
      uint(0x56aa, ns(preSkip)), // CodecDelay
      uint(0x56bb, 80_000_000), // SeekPreRoll, 80 ms as RFC 7845 recommends
      master(0xe1, [float(0xb5, SAMPLE_RATE), uint(0x9f, channels)]),
    ]),
  ]);

  const clusters = [];
  for (let first = 0; first < count; first += PACKETS_PER_CLUSTER) {
    const children = [uint(0xe7, first * MS_PER_PACKET)]; // Cluster Timestamp
    const last = Math.min(first + PACKETS_PER_CLUSTER, count);
    for (let i = first; i < last; i++) {
      const relative = (i - first) * MS_PER_PACKET;
      if (i === count - 1 && discard > 0) {
        // DiscardPadding only exists on a BlockGroup, not a SimpleBlock.
        children.push(master(0xa0, [element(0xa1, block(packets[i], relative, 0x00)), int(0x75a2, ns(discard))]));
      } else {
        children.push(element(0xa3, block(packets[i], relative, 0x80))); // SimpleBlock, keyframe
      }
    }
    clusters.push(master(0x1f43b675, children));
  }
  return Buffer.concat([header, master(0x18538067, [info, tracks, ...clusters])]);
}
