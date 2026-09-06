// Logging (SPEC-001 §9). `debug` exists only in development: the check is on
// `import.meta.env.DEV`, which Vite replaces with a literal in production
// builds, so the call and its arguments are dropped by the minifier.
//
// Player-facing conditions are never logged as errors — they are typed results
// the UI turns into toasts. `error` is for programming errors, which throw.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The four console methods the log writes to; swapped in tests. */
export type LogSink = Pick<Console, LogLevel>;

let sink: LogSink = console;

/** Route log output elsewhere (tests). Returns the previous sink. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

const isDev = (): boolean => import.meta.env.DEV;

export const log = {
  debug(tag: string, ...args: unknown[]): void {
    if (isDev()) sink.debug(`[${tag}]`, ...args);
  },
  info(tag: string, ...args: unknown[]): void {
    sink.info(`[${tag}]`, ...args);
  },
  warn(tag: string, ...args: unknown[]): void {
    sink.warn(`[${tag}]`, ...args);
  },
  error(tag: string, ...args: unknown[]): void {
    sink.error(`[${tag}]`, ...args);
  },
} as const;
