// Station crafting (SPEC-009 §4.12, PLAN §4). Recipes turn a field resource
// into a consumable; nothing here is buyable with tokens, which is what keeps
// wheat and water worth carrying home. SPEC-029 §4.3 adds the three explosives,
// all fed by oil — a second use for fuel, per PLAN's resource-sink rule.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ResourceId } from '@/data/ids';
import type { ItemId } from '@/data/items';

export interface RecipeDef<Id extends string = string> {
  readonly id: Id;
  readonly output: ItemId;
  readonly qty: number;
  readonly cost: Partial<Record<ResourceId, number>>;
}

export const RECIPES = {
  wheat_ration: { id: 'wheat_ration', output: 'wheat_ration', qty: 1, cost: { wheat: 10 } },
  medkit: { id: 'medkit', output: 'medkit', qty: 1, cost: { wheat: 10, water: 10 } },
  coolant_pack: { id: 'coolant_pack', output: 'coolant_pack', qty: 1, cost: { water: 15 } },
  frag_grenade: { id: 'frag_grenade', output: 'frag_grenade', qty: 1, cost: { oil: 10, water: 5 } },
  landmine: { id: 'landmine', output: 'landmine', qty: 1, cost: { oil: 20 } },
  demo_charge: { id: 'demo_charge', output: 'demo_charge', qty: 1, cost: { oil: 15, lithium: 10 } },
} as const satisfies Record<string, RecipeDef>;

export type RecipeId = keyof typeof RECIPES;
export type Recipe = RecipeDef<RecipeId>;
