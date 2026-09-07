// Page lifecycle (SPEC-002 §6.1). The document and the window are injected, so
// hidden tabs, focus loss and page dismissal are all just method calls here.
import { afterEach, describe, expect, it } from 'vitest';
import { PageLifecycle, type LifecycleTarget } from '@/core/Lifecycle';
import { setLogSink, type LogSink } from '@/core/Log';

class FakeTarget implements LifecycleTarget {
  readonly handlers = new Map<string, Set<() => void>>();

  addEventListener(type: string, handler: () => void): void {
    const set = this.handlers.get(type) ?? new Set<() => void>();
    set.add(handler);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, handler: () => void): void {
    this.handlers.get(type)?.delete(handler);
  }

  fire(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler();
  }

  get listeners(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

class FakeDoc extends FakeTarget {
  hidden = false;
}

interface Harness {
  lifecycle: PageLifecycle;
  doc: FakeDoc;
  win: FakeTarget;
  trace: string[];
  errors: string[];
}

function harness(): Harness {
  const doc = new FakeDoc();
  const win = new FakeTarget();
  const errors: string[] = [];
  const sink: LogSink = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => void errors.push(args.map((arg) => String(arg)).join(' ')),
  };
  setLogSink(sink);
  return { lifecycle: new PageLifecycle({ doc, win }), doc, win, trace: [], errors };
}

afterEach(() => {
  setLogSink(console);
});

describe('PageLifecycle', () => {
  it('fans each event out to every registered hook, in registration order', () => {
    const h = harness();
    h.lifecycle.add({
      onHidden: () => h.trace.push('a:hidden'),
      onVisible: () => h.trace.push('a:visible'),
      onBlur: () => h.trace.push('a:blur'),
      onPageHide: () => h.trace.push('a:pagehide'),
    });
    h.lifecycle.add({
      onHidden: () => h.trace.push('b:hidden'),
      onVisible: () => h.trace.push('b:visible'),
      onBlur: () => h.trace.push('b:blur'),
      onPageHide: () => h.trace.push('b:pagehide'),
    });

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    h.doc.hidden = false;
    h.doc.fire('visibilitychange');
    h.win.fire('blur');
    h.win.fire('pagehide');

    expect(h.trace).toEqual([
      'a:hidden',
      'b:hidden',
      'a:visible',
      'b:visible',
      'a:blur',
      'b:blur',
      'a:pagehide',
      'b:pagehide',
    ]);
  });

  it('never subscribes to beforeunload (§4.4)', () => {
    const h = harness();
    expect([...h.doc.handlers.keys()]).toEqual(['visibilitychange']);
    expect([...h.win.handlers.keys()]).toEqual(['blur', 'pagehide']);
  });

  it('catches a throwing hook, logs it, and still runs the rest (AC-44)', () => {
    const h = harness();
    h.lifecycle.add({ onHidden: () => h.trace.push('first') });
    h.lifecycle.add({
      onHidden: () => {
        throw new Error('a broken hook');
      },
    });
    h.lifecycle.add({ onHidden: () => h.trace.push('third') });

    h.doc.hidden = true;
    expect(() => h.doc.fire('visibilitychange')).not.toThrow();
    expect(h.trace).toEqual(['first', 'third']);
    expect(h.errors.join('\n')).toContain('a broken hook');
  });

  it('unsubscribes only its own hooks (AC-44)', () => {
    const h = harness();
    const release = h.lifecycle.add({ onBlur: () => h.trace.push('leaving') });
    h.lifecycle.add({ onBlur: () => h.trace.push('staying') });

    h.win.fire('blur');
    expect(h.trace).toEqual(['leaving', 'staying']);

    release();
    h.trace.length = 0;
    h.win.fire('blur');
    expect(h.trace).toEqual(['staying']);

    // A second call is harmless.
    expect(() => release()).not.toThrow();
  });

  it('removes every listener on dispose (AC-58)', () => {
    const h = harness();
    h.lifecycle.add({ onHidden: () => h.trace.push('hidden'), onBlur: () => h.trace.push('blur') });
    expect(h.doc.listeners + h.win.listeners).toBe(3);

    h.lifecycle.dispose();
    expect(h.doc.listeners + h.win.listeners).toBe(0);

    h.doc.hidden = true;
    h.doc.fire('visibilitychange');
    h.win.fire('blur');
    expect(h.trace).toEqual([]);
  });
});
