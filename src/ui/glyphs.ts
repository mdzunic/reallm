// The shared currency glyphs (SPEC-031 §3). They started life inside `ui/Hud.ts`;
// the wallet strip needs the same four, so they live in one place the HUD and
// the wallet both read — a retint or a glyph swap touches one table.
//
// SPEC-045 §4.6: the tokens glyph is the glossary's `GLYPHS.tokens`
// (`data/glossary.ts`), which `systems/` prints as well; only the resources'
// pictures live here.
import type { ResourceId } from '@/data/index';

export const RESOURCE_GLYPHS: Readonly<Record<ResourceId, string>> = {
  oil: '🛢',
  wheat: '🌾',
  water: '💧',
  lithium: '⚡',
};
