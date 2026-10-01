// The compare line, with its arrows (SPEC-042 §4.8). `compareDeltas` judges
// each part of SPEC-039's `gearCompare`; this draws them: a better part as
// `↑` in `--good`, a worse one as `↓` in `--hp`, and a part with no direction
// (the cooldown model) plain — joined by ` · `, exactly the text
// `gearCompareText` prints. The arrow shows benefit, not the number's
// direction: a lower heat per shot is `↑`. `▲` stays the warning glyph.
//
// One renderer for the three places a compare line shows: the gear card, the
// inventory action bar and the shop's gear rows.
import type { ItemId } from '@/data/index';
import { compareDeltas } from '@/systems/UiHelpers';
import { el } from '@/ui/dom';

/** The line's nodes, ready to append; empty when the two compare as nothing. */
export function compareNodes(worn: ItemId, candidate: ItemId): Node[] {
  const out: Node[] = [];
  for (const part of compareDeltas(worn, candidate)) {
    if (out.length > 0) out.push(document.createTextNode(' · '));
    if (part.better > 0) out.push(el('span', 'compare-up', `↑ ${part.text}`));
    else if (part.better < 0) out.push(el('span', 'compare-down', `↓ ${part.text}`));
    else out.push(el('span', 'compare-plain', part.text));
  }
  return out;
}
