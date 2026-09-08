// The entity → mesh view of the flight scene (SPEC-013 §4.9). Read-only over
// the flight system's state, which arrives each frame as a structural
// `FlightFrame` — `views/` may not import `systems/` (SPEC-001 §4), so the
// shapes are declared here and `systems/Flight.ts`'s pools satisfy them.
//
// Instancing per §4.9: asteroids are one InstancedMesh (icosahedron with
// per-instance scale/rotation/tint), fighters and interceptors one instanced
// mesh each (procedural silhouettes — enemies are never asset packs,
// CLAUDE.md), player shots instanced capsules, enemy shots instanced spheres,
// explosions one pooled particle cloud, the planet one sphere wearing a
// procedural biome texture, and the cockpit a static frame glued to the
// camera. The camera lags the ship at 10/s and rolls with the bank
// (reduce-motion: roll capped at 8°, no shake).
import * as THREE from 'three';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng } from '@/core/Rng';
import type { EnemyDef, PlanetDef } from '@/data/index';

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

// ------------------------------------------------------------------ tunables

const STARFIELD_DEPTH = 400;
const STAR_SPREAD_X = 70;
const STAR_SPREAD_Y = 45;
/** Base planet radius; §4.1's 0.2 → 6 scale rides on top of it. */
const PLANET_RADIUS = 30;
const PLANET_Z = -320;
const CAMERA_LERP_PER_S = 10;
const CAMERA_Z = 2.5;
/** Reduce-motion caps the roll here (§4.9). */
const REDUCED_ROLL_DEG = 8;
const MAX_SHIPS = 40;
const MAX_SHOTS = 64;
const PARTICLE_LIFE = 0.7;

const DEG = Math.PI / 180;

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

export class FlightView {
  readonly #scene: THREE.Scene;
  readonly #camera: THREE.PerspectiveCamera;
  readonly #reduceMotion: boolean;

  readonly #stars: THREE.Points;
  readonly #starPositions: THREE.BufferAttribute;
  readonly #asteroids: THREE.InstancedMesh;
  readonly #fighters: THREE.InstancedMesh;
  readonly #interceptors: THREE.InstancedMesh;
  readonly #shots: THREE.InstancedMesh;
  readonly #enemyShots: THREE.InstancedMesh;
  readonly #planet: THREE.Mesh;
  readonly #cockpit: THREE.Group;
  readonly #particles: THREE.Points;
  readonly #particleData: Float32Array; // vx, vy, vz, life per particle
  readonly #particlePositions: THREE.BufferAttribute;
  readonly #maxParticles: number;
  #nextParticle = 0;

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

    // Space wears a near-black cast of the planet's sky; fog carries its tint
    // (§4.9) and the storm triples the density (§4.5).
    const sky = new THREE.Color(planet.surface.palette.sky).multiplyScalar(0.12);
    scene.background = sky;
    this.#fogDensity = 0.0035;
    scene.fog = new THREE.FogExp2(new THREE.Color(planet.surface.palette.fog).multiplyScalar(0.25), this.#fogDensity);

    scene.add(new THREE.AmbientLight(0x8899aa, 1.2));
    const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
    key.position.set(3, 5, 4);
    scene.add(key);

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

    // Asteroids: one InstancedMesh, per-instance scale/rotation/tint (§4.9).
    this.#asteroids = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.05 }),
      quality.asteroidCap,
    );
    this.#asteroids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#asteroids.frustumCulled = false;
    scene.add(this.#asteroids);

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

  update(frame: FlightFrame, dt: number): void {
    this.#updateCamera(frame, dt);
    this.#updateStars(frame, dt);
    this.#updateHazards(frame);
    this.#updateShots(frame);
    this.#updateParticles(frame, dt);
    this.#updatePlanet(frame);
    const fog = this.#scene.fog as THREE.FogExp2;
    fog.density = this.#fogDensity * (frame.stormActive ? 3 : 1); // §4.5
  }

  dispose(): void {
    this.#camera.remove(this.#cockpit);
    disposeObject3D(this.#cockpit);
    this.#scene.fog = null;
    this.#scene.background = null;
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
    let asteroids = 0;
    let fighters = 0;
    let interceptors = 0;
    let enemyShots = 0;
    const time = frame.time;
    for (let i = 0; i < frame.hazards.size; i++) {
      const hazard = frame.hazards.at(i);
      this.#position.set(hazard.x, hazard.y, -hazard.depth);
      switch (hazard.kind) {
        case 'asteroid': {
          if (asteroids >= this.#asteroids.count) break;
          // Slow tumble (§4.3, visual): phase keyed to the rock's own radius.
          this.#euler.set(time * 0.4 + hazard.radius * 7, time * 0.3 + hazard.radius * 3, 0, 'XYZ');
          this.#quaternion.setFromEuler(this.#euler);
          this.#scale.setScalar(hazard.radius);
          this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
          this.#asteroids.setMatrixAt(asteroids, this.#matrix);
          // Tint varies with size so the field reads as rubble, not clones.
          this.#color.setHSL(0.08, 0.15, 0.28 + (hazard.radius % 1) * 0.2);
          this.#asteroids.setColorAt(asteroids, this.#color);
          asteroids++;
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
    this.#writeCount(this.#asteroids, asteroids, true);
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
  }
}
