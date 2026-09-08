// The live scene factory (SPEC-003 D-17). SPEC-014's real scenes took over
// from the placeholders, SPEC-013 landed flight; `surface` stays a
// placeholder until SPEC-012 lands the real one.
import type { SceneFactory } from '@/core/StateMachine';
import { CreationScene } from '@/scenes/CreationScene';
import { FlightScene } from '@/scenes/Flight';
import { MenuScene } from '@/scenes/MenuScene';
import { PLACEHOLDER_SCENES } from '@/scenes/Placeholders';
import { StarmapScene } from '@/scenes/StarmapScene';
import { StationScene } from '@/scenes/StationScene';

export const GAME_SCENES: SceneFactory = {
  ...PLACEHOLDER_SCENES,
  menu: (services) => new MenuScene(services),
  creation: (services) => new CreationScene(services),
  station: (services) => new StationScene(services),
  starmap: (services) => new StarmapScene(services),
  flight: (services) => new FlightScene(services),
};
