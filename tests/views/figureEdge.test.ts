// SPEC-075 §4.1 (PLAN R32) — the figure edge: a band along every fighter's
// silhouette, dark on a light ground and pale on a dark one, so the player
// and a pack stand off the planet in a greyscale capture. The tone is a
// property of the palette, the band a chunk in three programs; both are
// read here in node.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { ENEMIES, PLANETS } from '@/data/index';
import type { PlanetId } from '@/data/ids';
import {
  clearFigureEdges,
  EDGE_DARK,
  edgeTone,
  figureEdgeChunk,
  HOSTILE_EDGE_PALE,
  HOSTILE_EDGE_UNIFORM,
  PLAYER_EDGE_PALE,
  PLAYER_EDGE_UNIFORM,
  relativeLuminance,
  setFigureEdges,
} from '@/views/FigureEdge';
import { makeEnemy } from '@/entities/Enemy';
import { EnemyMeshes } from '@/views/ProceduralMeshes';

/** WCAG contrast between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the figure edge (SPEC-075 §4.1)', () => {
  it('is dark on sand, snow and lawn, and pale on moss, basalt and chitin', () => {
    const tones = Object.fromEntries(Object.values(PLANETS).map((planet) => [planet.id, edgeTone(planet.surface.palette.ground)]));
    expect(tones).toEqual({
      cinder4: 'dark',
      vetra: 'dark',
      thessaly: 'pale',
      ferrum: 'pale',
      hive: 'pale',
      eden: 'dark',
    } satisfies Record<PlanetId, 'dark' | 'pale'>);
  });

  it('stands off every planet’s ground by 4.5 : 1 or better, the player’s edge and the enemies’ alike', () => {
    for (const planet of Object.values(PLANETS)) {
      const ground = planet.surface.palette.ground;
      const dark = edgeTone(ground) === 'dark';
      for (const edge of dark ? [EDGE_DARK] : [PLAYER_EDGE_PALE, HOSTILE_EDGE_PALE]) {
        expect(contrast(edge, ground), `${edge} on ${planet.id}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('writes both shared uniforms in place, and clears them below ground', () => {
    const player = PLAYER_EDGE_UNIFORM.value;
    const hostile = HOSTILE_EDGE_UNIFORM.value;
    try {
      expect(setFigureEdges(PLANETS.cinder4.surface.palette.ground)).toBe('dark');
      const dark = new THREE.Color(EDGE_DARK);
      expect(player.x).toBeCloseTo(dark.r, 6);
      expect(hostile.z).toBeCloseTo(dark.b, 6);
      expect(player.w).toBeGreaterThan(0);
      expect(setFigureEdges(PLANETS.ferrum.surface.palette.ground)).toBe('pale');
      expect(player.x).toBeCloseTo(new THREE.Color(PLAYER_EDGE_PALE).r, 6);
      expect(hostile.x).toBeCloseTo(new THREE.Color(HOSTILE_EDGE_PALE).r, 6);
      clearFigureEdges();
      expect(player.w).toBe(0);
      expect(hostile.w).toBe(0);
      // Copied into, never replaced: every patched material holds these objects.
      expect(PLAYER_EDGE_UNIFORM.value).toBe(player);
      expect(HOSTILE_EDGE_UNIFORM.value).toBe(hostile);
    } finally {
      setFigureEdges(PLANETS.cinder4.surface.palette.ground);
    }
  });

  it('mixes the band into the lit colour just before three writes it', () => {
    const chunk = figureEdgeChunk('uPlayerEdge', 'opacity');
    expect(chunk).toContain('outgoingLight = mix( outgoingLight, uPlayerEdge.rgb, figureEdge * uPlayerEdge.a * opacity );');
    expect(chunk.trimEnd().endsWith('#include <opaque_fragment>')).toBe(true);
  });

  it('rides every enemy material, on the shared uniform, round the hostile rim, in one program', () => {
    const root = new THREE.Group();
    const meshes = new EnemyMeshes(root);
    const pool = new Pool(makeEnemy);
    const skitter = pool.alloc();
    Object.assign(skitter, { def: ENEMIES.dust_skitter, id: 1, state: 'chase', elite: false, hitFlash: 0, invulnerable: false, facing: 0, x: 5, z: -3 });
    meshes.sync(pool, 0);
    const part = root.getObjectsByProperty('isInstancedMesh', true)[0] as THREE.InstancedMesh;
    const material = part.material as THREE.MeshStandardMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <emissivemap_fragment>\n#include <opaque_fragment>\n',
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
    expect(shader.uniforms['uHostileEdge']).toBe(HOSTILE_EDGE_UNIFORM);
    const rimAt = shader.fragmentShader.indexOf('hostileRim');
    const edgeAt = shader.fragmentShader.indexOf('figureEdge');
    expect(rimAt).toBeGreaterThan(0);
    // The hue band first, the edge round it, then three's write.
    expect(edgeAt).toBeGreaterThan(rimAt);
    expect(shader.fragmentShader.indexOf('#include <opaque_fragment>')).toBeGreaterThan(edgeAt);
    // A flashing body dims its edge with its rim, so the white flash still leads.
    expect(shader.fragmentShader).toContain('min( vInstanceEmissive.w, 1.0 )');
    expect(material.customProgramCacheKey()).toBe('enemy/4');
    meshes.dispose();
  });
});
