// SPEC-035 §4.11, §6.1 — the Opus probe. Howler 2.2.4 asks whether the browser
// plays `audio/webm; codecs="vorbis"`; every bank this game ships is Opus in
// WebM, so a browser that answers "no" to Vorbis and "yes" to Opus was hearing
// nothing at all (there is no `.mp3` set yet).
//
// The test runs in node, where Howler's own `_setupCodecs` finds no `Audio`
// constructor and leaves `_codecs` empty — which is exactly the state the
// override has to survive: it replaces the `codecs` *function*, never the table.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Howl, Howler } from 'howler';
import { OPUS_PROBE_TYPE, installOpusCodecProbe } from '@/core/Audio';

/** A detached `<audio>` that answers `answer` to our probe and `''` to the rest. */
function stubAudioElement(answer: string): { createElement: ReturnType<typeof vi.fn> } {
  const canPlayType = vi.fn((type: string) => (type === OPUS_PROBE_TYPE ? answer : ''));
  const createElement = vi.fn(() => ({ canPlayType }));
  vi.stubGlobal('document', { createElement });
  return { createElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Opus probe (SPEC-035 §4.11)', () => {
  it('asks for the codec the banks are written in', () => {
    expect(OPUS_PROBE_TYPE).toBe('audio/webm; codecs="opus"');
  });

  it('answers webm from the probe and asks it only once', () => {
    const { createElement } = stubAudioElement('probably');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(true);
    expect(Howler.codecs('webm')).toBe(true);
    expect(createElement).toHaveBeenCalledTimes(1);
    expect(createElement).toHaveBeenCalledWith('audio');
  });

  it("follows the probe's answer when the browser says no", () => {
    stubAudioElement('');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(false);
  });

  it('survives the codec setup Howler runs inside its first Howl', () => {
    stubAudioElement('maybe');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(true);
    // Howler's `_setup` → `_setupCodecs` rewrites `Howler._codecs` here; a
    // written flag would be lost, the replaced function is not.
    new Howl({ src: ['assets/audio/sfx/surface.webm'], preload: false });
    (Howler as unknown as { _codecs: Record<string, boolean> })._codecs = {};
    expect(Howler.codecs('webm')).toBe(true);
  });

  it('passes every other extension to Howler and never wraps itself twice', () => {
    stubAudioElement('probably');
    installOpusCodecProbe();
    (Howler as unknown as { _codecs: Record<string, boolean> })._codecs = { mp3: true, ogg: false };
    expect(Howler.codecs('mp3')).toBe(true);
    expect(Howler.codecs('ogg')).toBe(false);
    // A second install re-arms the probe against Howler's original, so the
    // delegation stays one call deep however many times `Audio` is built.
    const { createElement } = stubAudioElement('probably');
    installOpusCodecProbe();
    expect(Howler.codecs('mp3')).toBe(true);
    expect(Howler.codecs('webm')).toBe(true);
    expect(createElement).toHaveBeenCalledTimes(1);
  });
});
