// The live scene factory (SPEC-003 D-17). SPEC-014's real scenes take over
// from the placeholders one by one; `flight` and `surface` stay placeholders
// until SPEC-013 and SPEC-012 land theirs.
import type { SceneFactory } from '@/core/StateMachine';
import { CreationScene } from '@/scenes/CreationScene';
import { MenuScene } from '@/scenes/MenuScene';
import { PLACEHOLDER_SCENES } from '@/scenes/Placeholders';

export const GAME_SCENES: SceneFactory = {
  ...PLACEHOLDER_SCENES,
  menu: (services) => new MenuScene(services),
  creation: (services) => new CreationScene(services),
};
