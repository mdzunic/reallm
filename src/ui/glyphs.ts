// The shared currency glyphs (SPEC-031 §3). They started life inside `ui/Hud.ts`;
// the wallet strip needs the same four, so they live in one place the HUD and
// the wallet both read — a retint or a glyph swap touches one table.
import type { ResourceId } from '@/data/index';

export const RESOURCE_GLYPHS: Readonly<Record<ResourceId, string>> = {
  oil: '🛢',
  wheat: '🌾',
  water: '💧',
  lithium: '⚡',
};

export const TOKEN_GLYPH = '◈';
