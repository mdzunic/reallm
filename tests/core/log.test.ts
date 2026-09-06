// core/Log (SPEC-001 §9): four levels with a tag, `debug` only in development.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, setLogSink, type LogSink } from '@/core/Log';

function recorder(): { sink: LogSink; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const sink: LogSink = {
    debug: (...a: unknown[]) => void calls.push(['debug', a]),
    info: (...a: unknown[]) => void calls.push(['info', a]),
    warn: (...a: unknown[]) => void calls.push(['warn', a]),
    error: (...a: unknown[]) => void calls.push(['error', a]),
  };
  return { sink, calls };
}

describe('log', () => {
  afterEach(() => {
    setLogSink(console);
    vi.unstubAllEnvs();
  });

  it('prefixes every line with its tag and forwards the arguments', () => {
    const { sink, calls } = recorder();
    setLogSink(sink);
    log.info('boot', 'ready', 42);
    log.warn('save', 'slot full');
    log.error('rng', new Error('bad seed'));
    expect(calls.map(([level]) => level)).toEqual(['info', 'warn', 'error']);
    expect(calls[0]?.[1]).toEqual(['[boot]', 'ready', 42]);
    expect(calls[1]?.[1]).toEqual(['[save]', 'slot full']);
  });

  it('debug writes in development and is silent in production', () => {
    const { sink, calls } = recorder();
    setLogSink(sink);
    vi.stubEnv('DEV', true);
    log.debug('loop', 'tick');
    expect(calls).toEqual([['debug', ['[loop]', 'tick']]]);
    vi.stubEnv('DEV', false);
    log.debug('loop', 'tick');
    expect(calls).toHaveLength(1);
  });

  it('setLogSink returns the previous sink so a test can restore it', () => {
    const { sink } = recorder();
    const previous = setLogSink(sink);
    expect(previous).toBe(console);
    expect(setLogSink(console)).toBe(sink);
  });
});
