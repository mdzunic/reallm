// The entity → mesh view of the flight scene (SPEC-013 §4.9). Read-only over
// the flight system's state, which arrives each frame as a structural
// `FlightFrame` — `views/` may not import `systems/` (SPEC-001 §4), so the
// shapes are declared here and `systems/Flight.ts`'s pools satisfy them.
//
// Instancing per §4.9: asteroids are instanced meshes (one per rock shape) with
// per-instance scale/rotation/tint, fighters and interceptors one instanced
// mesh each, player shots instanced capsules, enemy shots instanced spheres,
// explosions one pooled particle cloud, the planet one sphere, and the cockpit
// a static frame glued to the camera. The camera lags the ship at 10/s and
// rolls with the bank (reduce-motion: roll capped at 8°, no shake).
//
// Everything starts as primitives, which need no download, and `useArt()`
// swaps in the art the scene loads for the trip (PLAN R8, SPEC-020 §4.8): the
// sky window, the planet's maps with an atmosphere and a cloud layer, the
// baked asteroid, fighter, interceptor and cockpit models, and sprite textures
// for the stars and the explosions.
import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng } from '@/core/Rng';
import type { EnemyDef, PlanetDef } from '@/data/index';
import { buildEnvironment, skyParamsFor } from '@/views/Environment';
import { particleSprite } from '@/views/ProceduralTextures';

// ------------------------------------------------------- the per-frame slice

export interface FrameShip {
  x: number;
  y: number;
  vy: number;
  /** Degrees (SPEC-013 §4.2). */
  bank: number;
  alive: boolean;
}

export interface FrameHazard {
  kind: 'asteroid' | 'fighter' | 'interceptor' | 'enemy_shot';
  x: number;
  y: number;
  depth: number;
  radius: number;
  /** Depth per second — the ghost taps of §4.3 read it off enemy shots. */
  vDepth?: number;
  def?: EnemyDef;
}

export interface FrameShot {
  x: number;
  y: number;
  depth: number;
  /** Depth per second — what the ghost taps of §4.3 are offset along. */
  vDepth: number;
}

export interface FrameBurst {
  x: number;
  y: number;
  depth: number;
  size: number;
}

export interface FlightFrame {
  ship: FrameShip;
  hazards: Pool<FrameHazard>;
  shots: Pool<FrameShot>;
  /** Drained here: the view spawns particles for each and clears the pool. */
  bursts: Pool<FrameBurst>;
  progress: number;
  stormActive: boolean;
  throttleLive: number;
  time: number;
}

// ------------------------------------------------------------------ the art

export interface PlanetMaps {
  readonly map: THREE.Texture;
  readonly normalMap?: THREE.Texture | null;
  readonly emissiveMap?: THREE.Texture | null;
}

/** The trip's art (PLAN R8), handed over once loaded; every field may be missing. */
export interface FlightArt {
  /** The forward sky window of `SKY_WINDOW`. */
  readonly sky?: THREE.Texture | null;
  readonly planet?: PlanetMaps | null;
  /** Grey = cover, used as the cloud layer's alpha map. */
  readonly clouds?: THREE.Texture | null;
  /** One mesh per rock shape, mean radius 1. */
  readonly asteroid?: THREE.Object3D | null;
  readonly fighter?: THREE.Object3D | null;
  readonly interceptor?: THREE.Object3D | null;
  /** Camera space: the pilot looks along −Z. */
  readonly cockpit?: THREE.Object3D | null;
  /** Soft sprite for the explosion particles. */
  readonly ember?: THREE.Texture | null;
  /** Glow sprite for the streaming stars. */
  readonly flare?: THREE.Texture | null;
}

/**
 * The sky window `scripts/assets/blender/flight.py` renders, as SphereGeometry
 * arguments: φ π…2π, θ π/8…7π/8 — ±90° × ±67.5° around −Z, which covers every
 * direction the flight camera can face (roll, pitch and the landing dive).
 */
export const SKY_WINDOW = {
  phiStart: Math.PI,
  phiLength: Math.PI,
  thetaStart: Math.PI / 8,
  thetaLength: (3 * Math.PI) / 4,
} as const;

// ------------------------------------------------------------------ tunables

const STARFIELD_DEPTH = 400;
const STAR_SPREAD_X = 70;
const STAR_SPREAD_Y = 45;
/** Base planet radius; §4.1's 0.2 → 6 scale rides on top of it. */
const PLANET_RADIUS = 30;
const PLANET_Z = -320;
const SKY_RADIUS = 500;
const ATMOSPHERE_SCALE = 1.06;
const CLOUD_SCALE = 1.015;
const CAMERA_LERP_PER_S = 10;
const CAMERA_Z = 2.5;
/** Reduce-motion caps the roll here (§4.9). */
const REDUCED_ROLL_DEG = 8;
const MAX_SHIPS = 40;
const MAX_SHOTS = 64;
const PARTICLE_LIFE = 0.7;
/** Where the key light comes from (the atmosphere brightens on that side). */
const KEY_DIRECTION = new THREE.Vector3(3, 5, 4).normalize();

// ---------------------------------------------- SPEC-020 §4.3: the trip's fx

/**
 * How far behind each class's origin its exhaust sits, in model metres — the
 * fighter's nozzle disc bakes at Blender (0, 1.28, 0) and the interceptor's
 * tail lamp at (0, 2.08, 0.21) (`scripts/assets/blender/ships.py`), and the
 * Blender → glTF map (x, y, z) → (x, z, −y) puts both on −Z, opposite the nose
 * (+Z, §4.8). The glow rides one offset further out, times the instance scale.
 */
const GLOW_OFFSET: Readonly<Record<'fighter' | 'interceptor', number>> = { fighter: 1.3, interceptor: 2.1 };
const GLOW_SIZE = 0.6;
const GLOW_COLOR = 0x9fe3ff;

/**
 * §4.3: the shot head and its two ghosts — the depth lag each is drawn at and
 * the colour gain it carries. The head's × 2.5 is what pushes the bolt past
 * SPEC-017's bloom threshold; the ghosts trail it at × 1.2 and × 0.6.
 *
 * The offsets are the criterion's own arithmetic, `p + v · lag`, against the
 * shot's signed `vDepth` — so the ghosts sit further along the bolt's own
 * direction of travel than the head does.
 */
const SHOT_TAPS: ReadonlyArray<{ readonly lag: number; readonly gain: number }> = [
  { lag: 0, gain: 2.5 },
  { lag: 0.02, gain: 1.2 },
  { lag: 0.04, gain: 0.6 },
];

/** §4.3: the explosion flash, SPEC-019 §4.4 `death`'s four sprites at × 3. */
const FLASH_SPRITES = 4;
const FLASH_GAIN = 3;
const FLASH_LIFE = 0.12;
/** Four concurrent explosions' worth of flash, the same headroom SPEC-019 keeps. */
const FLASH_CAPACITY = FLASH_SPRITES * 4;
const PARTICLE_SIZE = 0.9;
const FLASH_SIZE = PARTICLE_SIZE * 1.4;

/** §4.3: the sun sits past the planet's far shoulder, so the flare reads. */
const SUN_POSITION = new THREE.Vector3(-70, 34, -440);
/** 20-f: the flare fades away over the landing's last 30 %. */
const FLARE_FADE_FROM = 0.7;

/** 20-g: how fast the sky window reaches full storm tint (per second). */
const STORM_TINT_PER_S = 2;

/** Cloud tint, cover and drift per biome (initial tuning). */
const CLOUDS: Readonly<Record<PlanetDef['biome'], { readonly tint: string; readonly opacity: number }>> = {
  desert: { tint: '#e2bc8a', opacity: 0.4 },
  ice: { tint: '#ffffff', opacity: 0.55 },
  jungle: { tint: '#ffffff', opacity: 0.85 },
  volcanic: { tint: '#5e5048', opacity: 0.55 },
  hive: { tint: '#8a6aa0', opacity: 0.35 },
  temperate: { tint: '#ffffff', opacity: 0.8 },
};
const CLOUD_SPIN = 0.012;
/** SPEC-020 20-b: reduce motion keeps the clouds nearly still. */
const REDUCED_CLOUD_SPIN = 0.004;

const DEG = Math.PI / 180;

/** SPEC-017 §4.4: image-based lighting is a fill in space, not the key. */
const FLIGHT_ENVIRONMENT_INTENSITY = 0.5;

function frac(x: number): number {
  return x - Math.floor(x);
}

interface ViewOptions {
  planet: PlanetDef;
  quality: QualitySettings;
  reduceMotion: boolean;
  /** Star positions and texture noise only — never simulation state. */
  rng: Rng;
}

/** An 8×8 tinted noise texture from the planet's palette — no asset behind it. */
function biomeTexture(planet: PlanetDef, rng: Rng): THREE.DataTexture {
  const size = 16;
  const ground = new THREE.Color(planet.surface.palette.ground);
  const accent = new THREE.Color(planet.surface.palette.accent);
  const data = new Uint8Array(size * size * 4);
  const mixed = new THREE.Color();
  for (let i = 0; i < size * size; i++) {
    mixed.copy(ground).lerp(accent, rng.next() * 0.6);
    data[i * 4] = Math.round(mixed.r * 255);
    data[i * 4 + 1] = Math.round(mixed.g * 255);
    data[i * 4 + 2] = Math.round(mixed.b * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

const MODEL_ATTRIBUTES = new Set(['position', 'normal', 'uv']);

/**
 * Each mesh of a loaded model as (geometry, material), its transform applied
 * and only position / normal / uv kept. The geometries are new and belong to
 * the caller; the materials stay the model's own (shared with the asset cache).
 */
export function modelParts(root: THREE.Object3D): Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> {
  root.updateMatrixWorld(true);
  const parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) {
      if (!MODEL_ATTRIBUTES.has(name)) geometry.deleteAttribute(name);
    }
    geometry.clearGroups();
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (material !== undefined) parts.push({ geometry, material });
  });
  return parts;
}

/** A model as one geometry with a group per material — what one InstancedMesh draws. */
export function mergeModel(root: THREE.Object3D): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } | null {
  const parts = modelParts(root);
  if (parts.length === 0) return null;
  const geometry = mergeGeometries(
    parts.map((part) => part.geometry),
    true,
  ) as THREE.BufferGeometry | null;
  for (const part of parts) part.geometry.dispose();
  if (geometry === null) return null;
  return { geometry, materials: parts.map((part) => part.material) };
}

/**
 * The atmosphere shell (SPEC-020 §4.2): an additive fresnel halo that peaks
 * just outside the planet's limb, fades to nothing at the shell's own edge,
 * and is brighter on the lit side.
 */
function atmosphereMaterial(color: THREE.Color, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uLight: { value: KEY_DIRECTION.clone() },
      uEdge: { value: Math.sqrt(1 - 1 / (ATMOSPHERE_SCALE * ATMOSPHERE_SCALE)) },
      uStrength: { value: strength },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uLight;
      uniform float uEdge;
      uniform float uStrength;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vNormal);
        float d = max(dot(n, normalize(vView)), 0.0);
        float halo = pow(1.0 - d, 3.0) * smoothstep(0.0, uEdge, d);
        vec3 l = normalize((viewMatrix * vec4(uLight, 0.0)).xyz);
        float lit = 0.2 + 0.8 * smoothstep(-0.35, 0.6, dot(n, l));
        gl_FragColor = vec4(uColor * halo * lit * uStrength, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * The lens flare's two elements (§4.3): a 64² four-armed star and a 32² ring.
 * Built here rather than downloaded — the flare is the only thing that wants
 * them, and a `DataTexture` costs no request and no decode.
 */
function flareTexture(size: number, kind: 'flare' | 'ring'): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const r = Math.hypot(dx, dy);
      let alpha: number;
      if (kind === 'flare') {
        // A hot core with four soft arms along the axes.
        const core = Math.max(0, 1 - r * 2.6);
        const arms = Math.max(0, 1 - Math.abs(dy) * 14) + Math.max(0, 1 - Math.abs(dx) * 14);
        alpha = Math.min(1, core * core * 1.6 + arms * Math.max(0, 1 - r) * 0.35);
      } else {
        // A thin halo: bright on the circle at r = 0.72, nothing elsewhere.
        alpha = Math.exp(-((r - 0.72) * (r - 0.72)) / 0.006) * (1 - Math.max(0, r - 1));
      }
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class FlightView {
  readonly #scene: THREE.Scene;
  readonly #camera: THREE.PerspectiveCamera;
  readonly #reduceMotion: boolean;
  readonly #planetDef: PlanetDef;
  readonly #rockTint: THREE.Color;

  readonly #stars: THREE.Points;
  readonly #starPositions: THREE.BufferAttribute;
  #asteroids: THREE.InstancedMesh[];
  readonly #asteroidCounts: number[] = [];
  #rocksTextured = false;
  readonly #fighters: THREE.InstancedMesh;
  readonly #interceptors: THREE.InstancedMesh;
  /** §4.3: one additive quad per ship, at its nozzle plane. */
  readonly #glows: THREE.InstancedMesh;
  readonly #shots: THREE.InstancedMesh;
  readonly #enemyShots: THREE.InstancedMesh;
  readonly #planet: THREE.Mesh;
  #clouds: THREE.Mesh | null = null;
  #sky: THREE.Mesh | null = null;
  #skyMaterial: THREE.MeshBasicMaterial | null = null;
  #dressed = false;
  readonly #cockpit: THREE.Group;
  /** §4.3: the explosion pool — instanced sprite quads, not points. */
  readonly #particles: THREE.InstancedMesh;
  readonly #particleData: Float32Array; // vx, vy, vz, life per particle
  readonly #particlePositions: Float32Array;
  readonly #maxParticles: number;
  #nextParticle = 0;
  readonly #flash: THREE.InstancedMesh;
  readonly #flashData: Float32Array; // vx, vy, vz, life per sprite
  readonly #flashPositions = new Float32Array(FLASH_CAPACITY * 3);
  #nextFlash = 0;

  /** 20-g: 0 → white sky window, 1 → fully tinted toward the planet's accent. */
  #stormTint = 0;
  readonly #accent: THREE.Color;
  #flare: Lensflare | null = null;
  readonly #flareElements: LensflareElement[] = [];
  readonly #flareColors: THREE.Color[] = [];

  readonly #environment: THREE.DataTexture | null = null;
  readonly #fogDensity: number;
  #shake = 0;
  #landing = 0;

  readonly #matrix = new THREE.Matrix4();
  readonly #position = new THREE.Vector3();
  readonly #quaternion = new THREE.Quaternion();
  readonly #euler = new THREE.Euler();
  readonly #scale = new THREE.Vector3();
  readonly #color = new THREE.Color();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: ViewOptions) {
    this.#scene = scene;
    this.#camera = camera;
    this.#reduceMotion = options.reduceMotion;
    const { planet, quality, rng } = options;
    this.#planetDef = planet;
    this.#rockTint = new THREE.Color(planet.surface.palette.ground);
    this.#accent = new THREE.Color(planet.surface.palette.accent);

    // Space wears a near-black cast of the planet's sky; fog carries its tint
    // (§4.9) and the storm triples the density (§4.5).
    const sky = new THREE.Color(planet.surface.palette.sky).multiplyScalar(0.12);
    scene.background = sky;
    this.#fogDensity = 0.0035;
    scene.fog = new THREE.FogExp2(new THREE.Color(planet.surface.palette.fog).multiplyScalar(0.25), this.#fogDensity);

    // The scene lights itself (it skips the UI scenes' flat ambient). SPEC-017
    // §4.5 replaces the flat ambient with a hemisphere wearing the destination's
    // sky, so space gets a direction; the environment map below carries the
    // speculars a warm key and a blue rim cannot.
    scene.add(new THREE.HemisphereLight(sky, 0x101418, 0.4));
    // PLAN §9 scopes image-based lighting to `medium` and `high`; `low` flies
    // on the key, the rim and the hemisphere alone.
    if (quality.ibl) {
      this.#environment = buildEnvironment(skyParamsFor(planet.surface.palette));
      scene.environment = this.#environment;
      scene.environmentIntensity = FLIGHT_ENVIRONMENT_INTENSITY;
    }
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.copy(KEY_DIRECTION).multiplyScalar(10);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7f9fff, 0.8);
    rim.position.set(-4, 2, -6);
    scene.add(rim);

    // §4.3 / 20-a: the sun past the planet's far shoulder wears a two-element
    // lens flare — but only where the post chain's bloom is there to make it
    // read; on `low` it would be a hard disc pasted over the sky.
    if (quality.post !== 'off') {
      const sun = new THREE.DirectionalLight(0xfff4e2, 0.35);
      sun.position.copy(SUN_POSITION);
      const flare = new Lensflare();
      const elements = [
        new LensflareElement(flareTexture(64, 'flare'), 260, 0, new THREE.Color(0xfff0d8)),
        new LensflareElement(flareTexture(32, 'ring'), 70, 0.62, new THREE.Color(0x7fb4ff)),
      ];
      for (const element of elements) {
        flare.addElement(element);
        this.#flareElements.push(element);
        this.#flareColors.push(element.color.clone());
      }
      sun.add(flare);
      this.#flare = flare;
      scene.add(sun);
    }

    // Starfield: `Points` with per-frame z streaming and wrap (§4.9).
    const starCount = quality.starfieldPoints;
    const starData = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starData[i * 3] = rng.float(-STAR_SPREAD_X, STAR_SPREAD_X);
      starData[i * 3 + 1] = rng.float(-STAR_SPREAD_Y, STAR_SPREAD_Y);
      starData[i * 3 + 2] = rng.float(-STARFIELD_DEPTH, 5);
    }
    const starGeometry = new THREE.BufferGeometry();
    this.#starPositions = new THREE.BufferAttribute(starData, 3);
    starGeometry.setAttribute('position', this.#starPositions);
    this.#stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({ color: 0xdfe8f3, size: 0.5, sizeAttenuation: true, fog: false }),
    );
    this.#stars.frustumCulled = false;
    scene.add(this.#stars);

    // Asteroids: instanced, per-instance scale/rotation/tint (§4.9); one rock
    // shape until `useArt` brings the baked ones.
    this.#asteroids = [
      this.#rockMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 }), quality.asteroidCap),
    ];

    // Enemy ships: two instanced silhouettes, tinted from their defs (§4.9).
    const fighterGeometry = new THREE.ConeGeometry(1, 2.6, 4);
    fighterGeometry.rotateX(-Math.PI / 2); // nose toward the ship
    fighterGeometry.scale(1.6, 0.5, 1);
    this.#fighters = this.#shipMesh(fighterGeometry, '#8a7f6a');
    const interceptorGeometry = new THREE.OctahedronGeometry(1, 0);
    interceptorGeometry.scale(0.8, 0.8, 1.8);
    this.#interceptors = this.#shipMesh(interceptorGeometry, '#9a8ad0');

    // §4.3: the engine glows — one instanced additive quad, an instance behind
    // every fighter and interceptor on screen.
    //
    // `depthTest: false` is deliberate and is what makes the criterion's sprite
    // something the player can actually see. Hazards fly *at* the camera
    // (SPEC-013 §4.3: they are drawn at (x, y, −depth) and their noses face
    // +Z), so a ship's exhaust is always on the far side of its own hull: a
    // 0.6 m quad at the nozzle plane sits inside the silhouette of a 3.2 m
    // fighter at every bearing the rail lets the player reach, and a
    // depth-tested quad there is never rasterised at all. Drawn through the
    // hull it reads as the exhaust glow spilling around it, which is the thing
    // the criterion asks for. It is additive and does not write depth, so it
    // tints what it crosses rather than hiding it.
    this.#glows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(GLOW_SIZE, GLOW_SIZE),
      new THREE.MeshBasicMaterial({
        color: GLOW_COLOR,
        map: particleSprite('dot'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
      MAX_SHIPS * 2,
    );
    this.#glows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#glows.frustumCulled = false;
    this.#glows.count = 0;
    scene.add(this.#glows);

    // Shots: instanced capsules for ours, instanced spheres for theirs (§4.9),
    // each carrying §4.3's head and two ghosts — hence the × 3 capacity and the
    // per-instance colour gain.
    const capsule = new THREE.CapsuleGeometry(0.07, 1.6, 3, 6);
    capsule.rotateX(Math.PI / 2); // along depth
    this.#shots = this.#shotMesh(capsule, 0x9fe3ff);
    this.#enemyShots = this.#shotMesh(new THREE.SphereGeometry(0.4, 8, 6), 0xff7a5a);

    // The destination: one sphere, procedural biome texture, scale by §4.1.
    this.#planet = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_RADIUS, 28, 20),
      new THREE.MeshStandardMaterial({ map: biomeTexture(planet, rng.fork('biome')), roughness: 1 }),
    );
    this.#planet.position.set(0, 0, PLANET_Z);
    scene.add(this.#planet);

    // Explosions (§4.3): a pooled instanced sprite quad — capacity
    // `quality.maxParticles` — plus SPEC-019 §4.4 `death`'s four-sprite flash
    // at × 3 brightness on its own mesh. A burst wakes a slice of both.
    this.#maxParticles = quality.maxParticles;
    this.#particleData = new Float32Array(this.#maxParticles * 4);
    this.#particlePositions = new Float32Array(this.#maxParticles * 3);
    this.#particles = this.#spriteMesh(0xffb066, PARTICLE_SIZE, this.#maxParticles);
    this.#flashData = new Float32Array(FLASH_CAPACITY * 4);
    this.#flash = this.#spriteMesh(0xffffff, FLASH_SIZE, FLASH_CAPACITY);

    // Cockpit: a static procedural frame — struts and a canopy edge — that
    // rides the camera (§4.9). HUD elements stay DOM.
    this.#cockpit = new THREE.Group();
    const frame = new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 0.9, metalness: 0.3 });
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.06), frame);
    left.position.set(-0.85, 0, -1.1);
    left.rotation.z = 0.35;
    const right = left.clone();
    right.position.x = 0.85;
    right.rotation.z = -0.35;
    const console = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.34, 0.3), frame);
    console.position.set(0, -0.72, -1.1);
    const canopy = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.045, 6, 24, Math.PI), frame);
    canopy.position.set(0, -0.25, -1.15);
    this.#cockpit.add(left, right, console, canopy);
    camera.add(this.#cockpit);
    // The camera renders as part of the scene graph only if it is in it.
    scene.add(camera);
  }

  #rockMesh(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.#scene.add(mesh);
    this.#asteroidCounts.push(0);
    return mesh;
  }

  /** §4.3: a shot mesh sized for the head plus its two ghosts, colour per instance. */
  #shotMesh(geometry: THREE.BufferGeometry, tint: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      geometry,
      // Additive so the ghosts read as light, not as three solid copies.
      new THREE.MeshBasicMaterial({ color: tint, fog: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      MAX_SHOTS * SHOT_TAPS.length,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    // Instance colours exist from the start, so the buffer never grows mid-trip.
    mesh.setColorAt(0, this.#color.setScalar(1));
    this.#scene.add(mesh);
    return mesh;
  }

  /** §4.3: an additive sprite-quad pool — the explosion particles and the flash. */
  #spriteMesh(tint: number, size: number, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        color: tint,
        map: particleSprite('ember'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
      capacity,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.setColorAt(0, this.#color.setScalar(1));
    this.#scene.add(mesh);
    return mesh;
  }

  #shipMesh(geometry: THREE.BufferGeometry, tint: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(tint), roughness: 0.6, metalness: 0.4 }),
      MAX_SHIPS,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.#scene.add(mesh);
    return mesh;
  }

  /** A hit landed: kick the cockpit (reduce-motion: the HUD vignette is all). */
  kick(strength = 1): void {
    if (this.#reduceMotion) return;
    this.#shake = Math.min(1.5, this.#shake + 0.4 * strength);
  }

  /** Landing cutscene progress 0..1: pitch down, planet fills the view (§4.1). */
  setLanding(progress: number): void {
    this.#landing = Math.min(1, Math.max(0, progress));
  }

  /**
   * Swap the primitives for the trip's art (PLAN R8). Called once, when the
   * scene's loads settle; anything missing keeps its primitive.
   */
  useArt(art: FlightArt): void {
    if (this.#dressed) return;
    this.#dressed = true;
    if (art.sky) this.#useSky(art.sky);
    if (art.planet) this.#usePlanet(art.planet, art.clouds ?? null);
    if (art.asteroid) this.#useRocks(art.asteroid);
    if (art.fighter) this.#useShip(this.#fighters, art.fighter);
    if (art.interceptor) this.#useShip(this.#interceptors, art.interceptor);
    if (art.cockpit) this.#useCockpit(art.cockpit);
    if (art.ember) {
      // The baked ember replaces the procedural one on both explosion meshes.
      for (const mesh of [this.#particles, this.#flash]) {
        (mesh.material as THREE.MeshBasicMaterial).map = art.ember;
        (mesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
      }
    }
    if (art.flare) glowPoints(this.#stars.material as THREE.PointsMaterial, art.flare, 1.1);
  }

  update(frame: FlightFrame, dt: number): void {
    this.#updateCamera(frame, dt);
    this.#updateStars(frame, dt);
    this.#updateHazards(frame);
    this.#updateShots(frame);
    this.#updateParticles(frame, dt);
    this.#updatePlanet(frame);
    this.#updateSky(frame, dt);
    const fog = this.#scene.fog as THREE.FogExp2;
    fog.density = this.#fogDensity * (frame.stormActive ? 3 : 1); // §4.5
  }

  /** 20-g: how far the sky window has shifted toward the accent, 0…1. */
  get stormTint(): number {
    return this.#stormTint;
  }

  dispose(): void {
    this.#camera.remove(this.#cockpit);
    disposeObject3D(this.#cockpit);
    // D-10: clear the reference, then free the texture — three drops the PMREM
    // it derived from it on the dispose event.
    this.#scene.environment = null;
    this.#environment?.dispose();
    this.#scene.fog = null;
    this.#scene.background = null;
  }

  // ------------------------------------------------------------------- the art

  #useSky(texture: THREE.Texture): void {
    const { phiStart, phiLength, thetaStart, thetaLength } = SKY_WINDOW;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      depthTest: false,
    });
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 48, 32, phiStart, phiLength, thetaStart, thetaLength),
      material,
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    dome.position.copy(this.#camera.position);
    this.#sky = dome;
    this.#skyMaterial = material;
    this.#applyStormTint();
    this.#scene.add(dome);
  }

  #usePlanet(maps: PlanetMaps, clouds: THREE.Texture | null): void {
    const planet = this.#planet;
    const primitive = planet.material as THREE.MeshStandardMaterial;
    primitive.map?.dispose();
    primitive.dispose();
    planet.geometry.dispose();
    planet.geometry = new THREE.SphereGeometry(PLANET_RADIUS, 64, 40);
    const glow = maps.emissiveMap ?? null;
    planet.material = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap ?? null,
      emissiveMap: glow,
      emissive: glow === null ? 0x000000 : 0xffffff,
      emissiveIntensity: 1.3,
      roughness: 0.92,
      metalness: 0,
      fog: false,
    });
    // The rim wears the sky's hue, lifted so even the Hive's dusk glows.
    const hsl = { h: 0, s: 0, l: 0 };
    const rim = new THREE.Color(this.#planetDef.surface.palette.sky);
    rim.getHSL(hsl);
    rim.setHSL(hsl.h, Math.min(1, hsl.s * 1.15), Math.max(0.55, hsl.l));
    planet.add(new THREE.Mesh(new THREE.SphereGeometry(PLANET_RADIUS * ATMOSPHERE_SCALE, 48, 32), atmosphereMaterial(rim, 3.0)));
    if (clouds !== null) {
      const look = CLOUDS[this.#planetDef.biome];
      const layer = new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_RADIUS * CLOUD_SCALE, 64, 40),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(look.tint),
          alphaMap: clouds,
          transparent: true,
          opacity: look.opacity,
          depthWrite: false,
          roughness: 1,
          metalness: 0,
          fog: false,
        }),
      );
      this.#clouds = layer;
      planet.add(layer);
    }
  }

  #useRocks(model: THREE.Object3D): void {
    const parts = modelParts(model);
    if (parts.length === 0) return;
    const capacity = (this.#asteroids[0] as THREE.InstancedMesh).instanceMatrix.count;
    for (const mesh of this.#asteroids) {
      this.#scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.#asteroids = [];
    this.#asteroidCounts.length = 0;
    for (const part of parts) this.#asteroids.push(this.#rockMesh(part.geometry, part.material, capacity));
    this.#rocksTextured = true;
  }

  #useShip(mesh: THREE.InstancedMesh, model: THREE.Object3D): void {
    const merged = mergeModel(model);
    if (merged === null) return;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh.geometry = merged.geometry;
    mesh.material = merged.materials;
  }

  #useCockpit(model: THREE.Object3D): void {
    for (const child of [...this.#cockpit.children]) {
      this.#cockpit.remove(child);
      disposeObject3D(child);
    }
    this.#cockpit.add(model);
  }

  // ---------------------------------------------------------------- internals

  #updateCamera(frame: FlightFrame, dt: number): void {
    const camera = this.#camera;
    const chase = Math.min(1, CAMERA_LERP_PER_S * dt);
    camera.position.x += (frame.ship.x - camera.position.x) * chase;
    camera.position.y += (frame.ship.y - camera.position.y) * chase;
    camera.position.z = CAMERA_Z;
    let roll = -frame.ship.bank * DEG; // bank right → horizon rolls left
    if (this.#reduceMotion) roll = Math.max(-REDUCED_ROLL_DEG * DEG, Math.min(REDUCED_ROLL_DEG * DEG, roll));
    let pitch = (frame.ship.vy / 14) * 15 * DEG;
    pitch += this.#landing * -24 * DEG; // the cutscene noses down (§4.1)
    if (this.#shake > 0) {
      this.#shake = Math.max(0, this.#shake - 3 * dt);
      pitch += Math.sin(frame.time * 43) * 0.012 * this.#shake;
      roll += Math.sin(frame.time * 61) * 0.012 * this.#shake;
    }
    this.#euler.set(pitch, 0, roll, 'ZYX');
    camera.quaternion.setFromEuler(this.#euler);
  }

  #updateStars(frame: FlightFrame, dt: number): void {
    const positions = this.#starPositions.array as Float32Array;
    const advance = 60 * frame.throttleLive * dt;
    for (let i = 0; i < positions.length; i += 3) {
      let z = (positions[i + 2] as number) + advance;
      if (z > 5) z -= STARFIELD_DEPTH;
      positions[i + 2] = z;
    }
    this.#starPositions.needsUpdate = true;
    // Parallax by ship offset (§4.9): the field slides against the steer.
    this.#stars.position.x = -frame.ship.x * 0.35;
    this.#stars.position.y = -frame.ship.y * 0.35;
  }

  #updateHazards(frame: FlightFrame): void {
    const rocks = this.#asteroids;
    const counts = this.#asteroidCounts;
    for (let v = 0; v < counts.length; v++) counts[v] = 0;
    let fighters = 0;
    let interceptors = 0;
    let enemyShots = 0;
    let glows = 0;
    const time = frame.time;
    for (let i = 0; i < frame.hazards.size; i++) {
      const hazard = frame.hazards.at(i);
      this.#position.set(hazard.x, hazard.y, -hazard.depth);
      switch (hazard.kind) {
        case 'asteroid': {
          // Each rock keeps its shape, stretch and tint: all keyed to its radius.
          const r = hazard.radius;
          const variant = rocks.length > 1 ? Math.floor(frac(r * 7.31) * rocks.length) : 0;
          const mesh = rocks[variant] as THREE.InstancedMesh;
          const slot = counts[variant] as number;
          if (slot >= mesh.instanceMatrix.count) break;
          // Slow tumble (§4.3, visual): phase keyed to the rock's own radius.
          this.#euler.set(time * 0.4 + r * 7, time * 0.3 + r * 3, 0, 'XYZ');
          this.#quaternion.setFromEuler(this.#euler);
          this.#scale.set(r * (0.85 + 0.3 * frac(r * 13.7)), r * (0.85 + 0.3 * frac(r * 5.3)), r);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          mesh.setMatrixAt(slot, this.#matrix);
          // Tint varies with size so the field reads as rubble, not clones.
          if (this.#rocksTextured) this.#color.setHSL(0.08, 0.1, 0.72 + frac(r) * 0.2).lerp(this.#rockTint, 0.25);
          else this.#color.setHSL(0.08, 0.15, 0.28 + frac(r) * 0.2);
          mesh.setColorAt(slot, this.#color);
          counts[variant] = slot + 1;
          break;
        }
        case 'fighter': {
          if (fighters >= MAX_SHIPS) break;
          this.#euler.set(0, 0, Math.sin(time * 2 + hazard.x) * 0.4, 'XYZ');
          this.#quaternion.setFromEuler(this.#euler);
          const scale = hazard.def?.look.scale ?? 1.2;
          this.#scale.setScalar(scale);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#fighters.setMatrixAt(fighters, this.#matrix);
          fighters++;
          glows = this.#writeGlow(glows, GLOW_OFFSET.fighter * scale);
          break;
        }
        case 'interceptor': {
          if (interceptors >= MAX_SHIPS) break;
          this.#quaternion.identity();
          const scale = hazard.def?.look.scale ?? 1.4;
          this.#scale.setScalar(scale);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#interceptors.setMatrixAt(interceptors, this.#matrix);
          interceptors++;
          glows = this.#writeGlow(glows, GLOW_OFFSET.interceptor * scale);
          break;
        }
        case 'enemy_shot': {
          enemyShots = this.#writeShot(this.#enemyShots, enemyShots, hazard.x, hazard.y, hazard.depth, hazard.vDepth ?? 0);
          break;
        }
      }
    }
    for (let v = 0; v < rocks.length; v++) this.#writeCount(rocks[v] as THREE.InstancedMesh, counts[v] as number, true);
    this.#writeCount(this.#fighters, fighters, false);
    this.#writeCount(this.#interceptors, interceptors, false);
    this.#writeCount(this.#glows, glows, false);
    this.#writeCount(this.#enemyShots, enemyShots, true);
  }

  /**
   * §4.3: one engine glow, `offset` metres behind the hazard `#position` holds
   * — down −Z, the nozzle side, since the model's nose is +Z. Returns the next
   * free slot; the scratch vector is put back the way it was found.
   */
  #writeGlow(slot: number, offset: number): number {
    if (slot >= this.#glows.instanceMatrix.count) return slot;
    this.#position.z -= offset;
    this.#quaternion.identity();
    this.#scale.setScalar(1); // §4.3 pins the quad at 0.6 m, whatever the ship's size
    this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
    this.#glows.setMatrixAt(slot, this.#matrix);
    this.#position.z += offset;
    return slot + 1;
  }

  #writeCount(mesh: THREE.InstancedMesh, count: number, colored: boolean): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (colored && mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  #updateShots(frame: FlightFrame): void {
    let count = 0;
    for (let i = 0; i < frame.shots.size; i++) {
      const shot = frame.shots.at(i);
      count = this.#writeShot(this.#shots, count, shot.x, shot.y, shot.depth, shot.vDepth);
    }
    this.#writeCount(this.#shots, count, true);
  }

  /**
   * §4.3: one bolt as three instances — the bright head and the two ghosts at
   * `p + v · lag` in depth, dimmer by their own gain. Returns the next free
   * slot, or `slot` untouched when the mesh is full.
   */
  #writeShot(mesh: THREE.InstancedMesh, slot: number, x: number, y: number, depth: number, vDepth: number): number {
    if (slot + SHOT_TAPS.length > mesh.instanceMatrix.count) return slot;
    this.#quaternion.identity();
    this.#scale.setScalar(1);
    let at = slot;
    for (let t = 0; t < SHOT_TAPS.length; t++) {
      const tap = SHOT_TAPS[t] as { lag: number; gain: number };
      this.#position.set(x, y, -(depth + vDepth * tap.lag));
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      mesh.setMatrixAt(at, this.#matrix);
      mesh.setColorAt(at, this.#color.setScalar(tap.gain));
      at++;
    }
    return at;
  }

  #updateParticles(frame: FlightFrame, dt: number): void {
    // Wake a slice of both pools per burst, then integrate the live ones.
    for (let b = 0; b < frame.bursts.size; b++) {
      const burst = frame.bursts.at(b);
      const spawn = Math.min(24, Math.round(6 + burst.size * 5));
      for (let n = 0; n < spawn; n++) {
        const index = this.#nextParticle;
        this.#nextParticle = (this.#nextParticle + 1) % this.#maxParticles;
        const angle = (n / spawn) * Math.PI * 2;
        this.#wake(this.#particleData, this.#particlePositions, index, burst, Math.cos(angle) * (4 + burst.size), Math.sin(angle) * (4 + burst.size), Math.sin(n * 2.7) * 4, PARTICLE_LIFE);
      }
      // §4.3: the four-sprite flash, a shorter burst at × 3 brightness.
      for (let n = 0; n < FLASH_SPRITES; n++) {
        const index = this.#nextFlash;
        this.#nextFlash = (this.#nextFlash + 1) % FLASH_CAPACITY;
        const angle = (n / FLASH_SPRITES) * Math.PI * 2 + 0.4;
        this.#wake(this.#flashData, this.#flashPositions, index, burst, Math.cos(angle) * 2, Math.sin(angle) * 2, 0, FLASH_LIFE);
      }
    }
    frame.bursts.clear();
    this.#drawPool(this.#particles, this.#particleData, this.#particlePositions, this.#maxParticles, PARTICLE_LIFE, 1, dt);
    this.#drawPool(this.#flash, this.#flashData, this.#flashPositions, FLASH_CAPACITY, FLASH_LIFE, FLASH_GAIN, dt);
  }

  /** One pool slot reset to a burst's origin and velocity (no allocation). */
  #wake(data: Float32Array, positions: Float32Array, index: number, burst: FrameBurst, vx: number, vy: number, vz: number, life: number): void {
    data[index * 4] = vx;
    data[index * 4 + 1] = vy;
    data[index * 4 + 2] = vz;
    data[index * 4 + 3] = life;
    positions[index * 3] = burst.x;
    positions[index * 3 + 1] = burst.y;
    positions[index * 3 + 2] = -burst.depth;
  }

  /**
   * Integrate a sprite pool and write the live slots into the front of its
   * instance buffer: the draw count is what is alive, and a slot that expired
   * simply stops being written (§4.3's replacement for the parked points).
   */
  #drawPool(mesh: THREE.InstancedMesh, data: Float32Array, positions: Float32Array, capacity: number, life: number, gain: number, dt: number): void {
    let drawn = 0;
    this.#quaternion.identity();
    for (let i = 0; i < capacity; i++) {
      const left = data[i * 4 + 3] as number;
      if (left <= 0) continue;
      const next = left - dt;
      data[i * 4 + 3] = next;
      if (next <= 0) continue;
      positions[i * 3] = (positions[i * 3] as number) + (data[i * 4] as number) * dt;
      positions[i * 3 + 1] = (positions[i * 3 + 1] as number) + (data[i * 4 + 1] as number) * dt;
      positions[i * 3 + 2] = (positions[i * 3 + 2] as number) + (data[i * 4 + 2] as number) * dt;
      const fade = next / life;
      this.#position.set(positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number);
      this.#scale.setScalar(0.4 + fade * 0.6);
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      mesh.setMatrixAt(drawn, this.#matrix);
      mesh.setColorAt(drawn, this.#color.setScalar(fade * gain));
      drawn++;
    }
    this.#writeCount(mesh, drawn, true);
  }

  /** 20-g: the sky window drifts toward the planet's accent while a storm blows. */
  #updateSky(frame: FlightFrame, dt: number): void {
    this.#sky?.position.copy(this.#camera.position);
    const target = frame.stormActive ? 1 : 0;
    const step = STORM_TINT_PER_S * dt;
    this.#stormTint = this.#stormTint < target ? Math.min(target, this.#stormTint + step) : Math.max(target, this.#stormTint - step);
    this.#applyStormTint();
    // 20-f: the flare goes out with the sky as the landing dive begins.
    if (this.#flare !== null) {
      const fade = 1 - Math.min(1, Math.max(0, (this.#landing - FLARE_FADE_FROM) / (1 - FLARE_FADE_FROM)));
      for (let i = 0; i < this.#flareElements.length; i++) {
        const element = this.#flareElements[i] as LensflareElement;
        element.color.copy(this.#flareColors[i] as THREE.Color).multiplyScalar(fade);
      }
    }
  }

  #applyStormTint(): void {
    this.#skyMaterial?.color.set(0xffffff).lerp(this.#accent, this.#stormTint);
  }

  #updatePlanet(frame: FlightFrame): void {
    // §4.1: scale = lerp(0.2, 6, progress²); the landing pushes past it as the
    // planet fills the view.
    const eased = frame.progress * frame.progress;
    const scale = (0.2 + (6 - 0.2) * eased) * (1 + this.#landing * 1.6);
    this.#planet.scale.setScalar(scale);
    this.#planet.rotation.y = frame.time * 0.02;
    this.#planet.position.y = -this.#landing * 30; // it rises as the nose dips
    if (this.#clouds !== null) {
      this.#clouds.rotation.y = frame.time * (this.#reduceMotion ? REDUCED_CLOUD_SPIN : CLOUD_SPIN);
    }
  }
}

/** Soft additive sprites instead of square points. */
function glowPoints(material: THREE.PointsMaterial, sprite: THREE.Texture, grow: number): void {
  material.map = sprite;
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.size *= grow;
  material.needsUpdate = true;
}
