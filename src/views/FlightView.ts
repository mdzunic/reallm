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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng } from '@/core/Rng';
import type { EnemyDef, PlanetDef } from '@/data/index';
import { buildEnvironment, skyParamsFor } from '@/views/Environment';

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
  def?: EnemyDef;
}

export interface FrameShot {
  x: number;
  y: number;
  depth: number;
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
  readonly #shots: THREE.InstancedMesh;
  readonly #enemyShots: THREE.InstancedMesh;
  readonly #planet: THREE.Mesh;
  #clouds: THREE.Mesh | null = null;
  #sky: THREE.Mesh | null = null;
  #dressed = false;
  readonly #cockpit: THREE.Group;
  readonly #particles: THREE.Points;
  readonly #particleData: Float32Array; // vx, vy, vz, life per particle
  readonly #particlePositions: THREE.BufferAttribute;
  readonly #maxParticles: number;
  #nextParticle = 0;

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

    // Shots: instanced capsules for ours, instanced spheres for theirs (§4.9).
    const capsule = new THREE.CapsuleGeometry(0.07, 1.6, 3, 6);
    capsule.rotateX(Math.PI / 2); // along depth
    this.#shots = new THREE.InstancedMesh(
      capsule,
      new THREE.MeshBasicMaterial({ color: 0x9fe3ff, fog: false }),
      MAX_SHOTS,
    );
    this.#shots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#shots.frustumCulled = false;
    scene.add(this.#shots);
    this.#enemyShots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.4, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff7a5a, fog: false }),
      MAX_SHOTS,
    );
    this.#enemyShots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#enemyShots.frustumCulled = false;
    scene.add(this.#enemyShots);

    // The destination: one sphere, procedural biome texture, scale by §4.1.
    this.#planet = new THREE.Mesh(
      new THREE.SphereGeometry(PLANET_RADIUS, 28, 20),
      new THREE.MeshStandardMaterial({ map: biomeTexture(planet, rng.fork('biome')), roughness: 1 }),
    );
    this.#planet.position.set(0, 0, PLANET_Z);
    scene.add(this.#planet);

    // Explosions: one pooled particle cloud; a burst wakes a slice of it (§4.9).
    this.#maxParticles = quality.maxParticles;
    const particlePositions = new Float32Array(this.#maxParticles * 3);
    particlePositions.fill(10_000); // parked far out of view
    this.#particleData = new Float32Array(this.#maxParticles * 4);
    const particleGeometry = new THREE.BufferGeometry();
    this.#particlePositions = new THREE.BufferAttribute(particlePositions, 3);
    particleGeometry.setAttribute('position', this.#particlePositions);
    this.#particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({ color: 0xffb066, size: 0.6, sizeAttenuation: true, transparent: true, opacity: 0.9, fog: false }),
    );
    this.#particles.frustumCulled = false;
    scene.add(this.#particles);

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
    if (art.ember) glowPoints(this.#particles.material as THREE.PointsMaterial, art.ember, 1.6);
    if (art.flare) glowPoints(this.#stars.material as THREE.PointsMaterial, art.flare, 1.1);
  }

  update(frame: FlightFrame, dt: number): void {
    this.#updateCamera(frame, dt);
    this.#updateStars(frame, dt);
    this.#updateHazards(frame);
    this.#updateShots(frame);
    this.#updateParticles(frame, dt);
    this.#updatePlanet(frame);
    this.#sky?.position.copy(this.#camera.position);
    const fog = this.#scene.fog as THREE.FogExp2;
    fog.density = this.#fogDensity * (frame.stormActive ? 3 : 1); // §4.5
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
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 48, 32, phiStart, phiLength, thetaStart, thetaLength),
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false }),
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    dome.position.copy(this.#camera.position);
    this.#sky = dome;
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
          this.#scale.setScalar(hazard.def?.look.scale ?? 1.2);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#fighters.setMatrixAt(fighters, this.#matrix);
          fighters++;
          break;
        }
        case 'interceptor': {
          if (interceptors >= MAX_SHIPS) break;
          this.#quaternion.identity();
          this.#scale.setScalar(hazard.def?.look.scale ?? 1.4);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#interceptors.setMatrixAt(interceptors, this.#matrix);
          interceptors++;
          break;
        }
        case 'enemy_shot': {
          if (enemyShots >= MAX_SHOTS) break;
          this.#quaternion.identity();
          this.#scale.setScalar(1);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#enemyShots.setMatrixAt(enemyShots, this.#matrix);
          enemyShots++;
          break;
        }
      }
    }
    for (let v = 0; v < rocks.length; v++) this.#writeCount(rocks[v] as THREE.InstancedMesh, counts[v] as number, true);
    this.#writeCount(this.#fighters, fighters, false);
    this.#writeCount(this.#interceptors, interceptors, false);
    this.#writeCount(this.#enemyShots, enemyShots, false);
  }

  #writeCount(mesh: THREE.InstancedMesh, count: number, colored: boolean): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (colored && mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  }

  #updateShots(frame: FlightFrame): void {
    let count = 0;
    this.#quaternion.identity();
    this.#scale.setScalar(1);
    for (let i = 0; i < frame.shots.size && count < MAX_SHOTS; i++) {
      const shot = frame.shots.at(i);
      this.#position.set(shot.x, shot.y, -shot.depth);
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      this.#shots.setMatrixAt(count, this.#matrix);
      count++;
    }
    this.#shots.count = count;
    this.#shots.instanceMatrix.needsUpdate = true;
  }

  #updateParticles(frame: FlightFrame, dt: number): void {
    // Wake a slice of the pool per burst, then integrate the live ones.
    for (let b = 0; b < frame.bursts.size; b++) {
      const burst = frame.bursts.at(b);
      const spawn = Math.min(24, Math.round(6 + burst.size * 5));
      for (let n = 0; n < spawn; n++) {
        const index = this.#nextParticle;
        this.#nextParticle = (this.#nextParticle + 1) % this.#maxParticles;
        const angle = (n / spawn) * Math.PI * 2;
        const lift = Math.sin(n * 2.7) * 4;
        this.#particleData[index * 4] = Math.cos(angle) * (4 + burst.size);
        this.#particleData[index * 4 + 1] = Math.sin(angle) * (4 + burst.size);
        this.#particleData[index * 4 + 2] = lift;
        this.#particleData[index * 4 + 3] = PARTICLE_LIFE;
        const positions = this.#particlePositions.array as Float32Array;
        positions[index * 3] = burst.x;
        positions[index * 3 + 1] = burst.y;
        positions[index * 3 + 2] = -burst.depth;
      }
    }
    frame.bursts.clear();
    const positions = this.#particlePositions.array as Float32Array;
    for (let i = 0; i < this.#maxParticles; i++) {
      const life = this.#particleData[i * 4 + 3] as number;
      if (life <= 0) continue;
      const left = life - dt;
      this.#particleData[i * 4 + 3] = left;
      if (left <= 0) {
        positions[i * 3] = 10_000;
        continue;
      }
      positions[i * 3] = (positions[i * 3] as number) + (this.#particleData[i * 4] as number) * dt;
      positions[i * 3 + 1] = (positions[i * 3 + 1] as number) + (this.#particleData[i * 4 + 1] as number) * dt;
      positions[i * 3 + 2] = (positions[i * 3 + 2] as number) + (this.#particleData[i * 4 + 2] as number) * dt;
    }
    this.#particlePositions.needsUpdate = true;
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
