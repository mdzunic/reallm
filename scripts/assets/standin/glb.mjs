// EXT_meshopt_compression for the stand-in build (scripts/assets/README.md §7)
// — what Blender 5.2's glTF exporter does with
// `export_meshopt_compression_enable` (SPEC-052 §1): every buffer view is
// compressed with meshoptimizer's own encoder (the `meshoptimizer` package
// three's types already bring in), the attributes stay float, and the file
// requires the extension, which three's MeshoptDecoder reads (SPEC-046).
//
// `compressGlb(bytes, { dropTexcoords })` also serves SPEC-052 §4.3's rebuilt
// props: today's Blender exports of the `_a` and `_b` builders lose their
// TEXCOORD_0, the vertices a UV seam alone had split are welded again, and the
// triangles — the builders' own, untouched — are reordered for the encoder.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EXT = 'EXT_meshopt_compression';
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAYS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** `{ json, bin }` of a GLB file. */
export function readGlb(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.readUInt32LE(0) !== GLB_MAGIC || buf.readUInt32LE(4) !== 2) throw new Error('not a glTF 2 binary');
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== JSON_CHUNK) throw new Error('the first GLB chunk is not JSON');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLength));
  let bin = Buffer.alloc(0);
  const at = 20 + jsonLength;
  if (at + 8 <= buf.length && buf.readUInt32LE(at + 4) === BIN_CHUNK) bin = buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at));
  return { json, bin };
}

/** A GLB file from its JSON and BIN chunk. */
export function writeGlb(json, bin) {
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const body = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length + 8 + body.length, 8);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return Buffer.concat([head, chunk(JSON_CHUNK, text), chunk(BIN_CHUNK, body)]);
}

/** An accessor's elements as a typed array (tightly packed, uncompressed input only). */
function accessorArray(json, bin, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  if (view.extensions?.[EXT]) throw new Error('the input is already meshopt-compressed');
  const Type = ARRAYS[acc.componentType];
  const n = COMPONENTS[acc.type];
  const stride = view.byteStride ?? n * Type.BYTES_PER_ELEMENT;
  if (stride !== n * Type.BYTES_PER_ELEMENT) throw new Error('interleaved buffer views are not supported');
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const bytes = bin.subarray(start, start + acc.count * stride);
  return { array: new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), size: n, componentType: acc.componentType };
}

/**
 * The compressed copy of a GLB. Options: `dropTexcoords` removes TEXCOORD_n
 * and re-welds what only a UV had split. Throws on anything it does not
 * expect from the generators (sparse accessors, interleaving, morph targets).
 */
export async function compressGlb(bytes, { dropTexcoords = false } = {}) {
  const { MeshoptEncoder } = require('meshoptimizer');
  await MeshoptEncoder.ready;
  const { json, bin } = readGlb(bytes);
  if ((json.buffers ?? []).length !== 1) throw new Error('expected one buffer');
  if (json.images?.length || json.animations?.length || json.skins?.length) throw new Error('only static, untextured models are compressed');

  // 1. Every primitive as plain arrays, welded and reordered.
  const prims = [];
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (prim.targets) throw new Error('morph targets are not supported');
      const names = Object.keys(prim.attributes).filter((name) => !(dropTexcoords && name.startsWith('TEXCOORD_')));
      const attrs = names.map((name) => ({ name, ...accessorArray(json, bin, prim.attributes[name]) }));
      const count = attrs[0].array.length / attrs[0].size;
      const source = accessorArray(json, bin, prim.indices).array;
      // weld vertices whose kept attributes are bit-identical
      const keyOf = (v) => attrs.map((a) => Buffer.from(a.array.buffer, v * a.size * a.array.BYTES_PER_ELEMENT, a.size * a.array.BYTES_PER_ELEMENT).toString('hex')).join('|');
      const weld = new Uint32Array(count);
      const seen = new Map();
      let unique = 0;
      for (let v = 0; v < count; v++) {
        const key = keyOf(v);
        let at = seen.get(key);
        if (at === undefined) {
          at = unique++;
          seen.set(key, at);
        }
        weld[v] = at;
      }
      const indices = new Uint32Array(source.length);
      for (let i = 0; i < source.length; i++) indices[i] = weld[source[i]];
      // the encoder's own vertex-cache and fetch order (indices are rewritten in place)
      const [remap, kept] = MeshoptEncoder.reorderMesh(indices, true, true);
      const out = attrs.map((a) => {
        const array = new a.array.constructor(kept * a.size);
        for (let v = 0; v < count; v++) {
          const to = remap[weld[v]];
          if (to === 0xffffffff) continue;
          for (let k = 0; k < a.size; k++) array[to * a.size + k] = a.array[v * a.size + k];
        }
        return { ...a, array };
      });
      prims.push({ prim, attrs: out, indices, vertexCount: kept });
    }
  }

  // 2. New accessors and buffer views: one view per accessor, each encoded.
  const accessors = [];
  const views = [];
  const encoded = [];
  let fallbackBytes = 0;
  let packed = 0;
  const addView = (array, count, stride, mode, target) => {
    const raw = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const data = MeshoptEncoder.encodeGltfBuffer(raw, count, stride, mode);
    const view = {
      buffer: 1,
      byteOffset: fallbackBytes,
      byteLength: raw.byteLength,
      target,
      extensions: { [EXT]: { buffer: 0, byteOffset: packed, byteLength: data.byteLength, byteStride: stride, count, mode } },
    };
    if (mode === 'ATTRIBUTES') view.byteStride = stride;
    views.push(view);
    encoded.push(Buffer.from(data));
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad) encoded.push(Buffer.alloc(pad));
    packed += data.byteLength + pad;
    fallbackBytes += raw.byteLength + ((4 - (raw.byteLength % 4)) % 4);
    return views.length - 1;
  };
  for (const { prim, attrs, indices, vertexCount } of prims) {
    const attributes = {};
    for (const a of attrs) {
      const stride = a.size * a.array.BYTES_PER_ELEMENT;
      const acc = { bufferView: addView(a.array, vertexCount, stride, 'ATTRIBUTES', 34962), componentType: a.componentType, count: vertexCount, type: Object.keys(COMPONENTS)[a.size - 1] };
      if (a.name === 'POSITION') {
        acc.min = [0, 1, 2].map((k) => Math.min(...Array.from({ length: vertexCount }, (_, v) => a.array[v * 3 + k])));
        acc.max = [0, 1, 2].map((k) => Math.max(...Array.from({ length: vertexCount }, (_, v) => a.array[v * 3 + k])));
      }
      accessors.push(acc);
      attributes[a.name] = accessors.length - 1;
    }
    const small = vertexCount <= 0xffff;
    const index = small ? Uint16Array.from(indices) : indices;
    accessors.push({ bufferView: addView(index, index.length, small ? 2 : 4, 'TRIANGLES', 34963), componentType: small ? 5123 : 5125, count: index.length, type: 'SCALAR' });
    prim.attributes = attributes;
    prim.indices = accessors.length - 1;
  }

  json.accessors = accessors;
  json.bufferViews = views;
  json.buffers = [{ byteLength: packed }, { byteLength: fallbackBytes, extensions: { [EXT]: { fallback: true } } }];
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), EXT])].sort();
  json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), EXT])].sort();
  return writeGlb(json, Buffer.concat(encoded));
}
