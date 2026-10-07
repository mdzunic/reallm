// SPEC-068 §4.7, §4.8 — the hazards' shapes and their view: every shape
// within its triangle cap, a shaft only where something falls, a glow on
// every hazard; the view draws only what is near and in frame, hides a part
// with nothing to draw, and paints its warnings in caution, never the rim.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Rng } from '@/core/Rng';
import { EventBus, type GameEvents } from '@/core/Events';
import { HAZARDS, type HazardId } from '@/data/hazards';
import type { HazardEntity } from '@/entities/Hazard';
import { Hazards, type HazardSpot } from '@/systems/Hazards';
import { hazardGeometry, hazardTriangles, HAZARD_TRIANGLE_CAP } from '@/views/HazardMeshes';
import { HAZARD_CAUTION, HAZARD_CAUTION_OVERRIDES, HAZARD_DRAW_RADIUS, HazardView } from '@/views/HazardView';
import { HOSTILE_RIM, HOSTILE_RIM_COLOUR_BLIND } from '@/views/ProceduralMeshes';
import { deltaE76 } from '../fixtures/colourVision';

const flat = (): number => 0;
const IDS = Object.keys(HAZARDS) as HazardId[];

function spot(id: HazardId, x: number, z: number): HazardSpot {
  return { id, x, z, yaw: 0, scale: 1, arena: false };
}

function hazards(spots: readonly HazardSpot[]): Hazards {
  return new Hazards(spots, new EventBus<GameEvents>({ dev: false }), new Rng(3));
}

describe('hazardGeometry (§4.8)', () => {
  it('keeps every hazard within the triangle cap, with a glow, and a shaft exactly for the topplers', () => {
    for (const id of IDS) {
      const def = HAZARDS[id];
      const g = hazardGeometry(def);
      expect(hazardTriangles(g), id).toBeLessThanOrEqual(HAZARD_TRIANGLE_CAP);
      expect((g.glow.getAttribute('position') as THREE.BufferAttribute).count, id).toBeGreaterThan(0);
      expect(g.shaft !== null, id).toBe(def.archetype === 'topple');
      if (g.shaft !== null) {
        // The shaft stands on its stump and its foot is at its origin.
        expect(g.shaftBase, id).toBeGreaterThan(0);
        g.shaft.computeBoundingBox();
        expect((g.shaft.boundingBox as THREE.Box3).min.y, id).toBeGreaterThanOrEqual(-0.3);
      }
      for (const part of [g.body, g.shaft, g.glow]) {
        if (part === null) continue;
        expect(part.getAttribute('color'), id).toBeDefined();
        expect(part.getAttribute('normal'), id).toBeDefined();
      }
    }
  });
});

describe('HazardView (§4.7)', () => {
  it('draws nothing beyond the draw radius and hides every empty part', () => {
    const root = new THREE.Group();
    const list = hazards([spot('fuel_drum', 200, 0), spot('balanced_rock', 210, 0)]);
    const view = new HazardView(root, list.list, 'cinder4', flat);
    view.sync(list.warnings, 0, 0, 0, null, false);
    expect(view.drawCalls).toBe(0);
    view.dispose();
    expect(root.children).toHaveLength(0);
  });

  it('draws a near helper’s body, glow and contact shadow, and a toppler’s shaft', () => {
    const root = new THREE.Group();
    const list = hazards([spot('fuel_drum', 5, 0), spot('balanced_rock', -5, 0), spot('scav_mine', 0, 8)]);
    const view = new HazardView(root, list.list, 'cinder4', flat);
    view.sync(list.warnings, 0, 0, 0, null, false);
    const visible = new Set<string>();
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) visible.add(o.name);
    });
    expect(visible).toEqual(
      new Set([
        'hazard-fuel_drum',
        'hazard-fuel_drum-glow',
        'hazard-balanced_rock',
        'hazard-balanced_rock-shaft',
        'hazard-balanced_rock-glow',
        'hazard-scav_mine',
        'hazard-scav_mine-glow',
        'hazard-contact',
      ]),
    );
    expect(view.drawCalls).toBe(visible.size);
    view.dispose();
  });

  it('culls against the camera frustum', () => {
    const root = new THREE.Group();
    const list = hazards([spot('fuel_drum', 10, 0)]);
    const view = new HazardView(root, list.list, 'cinder4', flat);
    const camera = new THREE.PerspectiveCamera(40, 1.6, 0.1, 200);
    camera.position.set(0, 20, 20);
    camera.lookAt(0, 0, -40);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    // Looking the other way: the drum at +x, +z behind the camera is out of frame.
    const behind = hazards([spot('fuel_drum', 0, 40)]);
    const hidden = new HazardView(new THREE.Group(), behind.list, 'cinder4', flat);
    hidden.sync(behind.warnings, 0, 0, 30, frustum, false);
    expect(hidden.drawCalls).toBe(0);
    view.sync(list.warnings, 0, 0, 0, null, false);
    expect(view.drawCalls).toBeGreaterThan(0);
    view.dispose();
    hidden.dispose();
  });

  it('stops drawing a spent volatile, and a fallen shaft once it has sunk', () => {
    const root = new THREE.Group();
    const list = hazards([spot('fuel_drum', 3, 0), spot('balanced_rock', -3, 0)]);
    const view = new HazardView(root, list.list, 'cinder4', flat);
    const [drum, rock] = list.list as [HazardEntity, HazardEntity];
    drum.state = 'spent';
    rock.state = 'spent';
    rock.burstAt = 0;
    view.sync(list.warnings, 5, 0, 0, null, false);
    const visible: string[] = [];
    root.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.visible) visible.push(o.name);
    });
    expect(visible.sort()).toEqual(['hazard-balanced_rock', 'hazard-contact']);
    view.dispose();
  });

  it('wears caution — every planet’s, far from the hostile rim on both presets — within a draw radius of a handful', () => {
    for (const colour of [HAZARD_CAUTION, ...Object.values(HAZARD_CAUTION_OVERRIDES)]) {
      expect(deltaE76(colour as string, HOSTILE_RIM), colour).toBeGreaterThan(25);
      expect(deltaE76(colour as string, HOSTILE_RIM_COLOUR_BLIND), colour).toBeGreaterThan(25);
    }
    expect(HAZARD_DRAW_RADIUS).toBeLessThanOrEqual(50);
  });
});
