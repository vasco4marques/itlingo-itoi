import { Logger, LogLevel, LOG_LEVEL_ORDER } from '../common/logger';

function resolveLevel(): LogLevel {
    let stored: string | null = null;
    try {
        stored = typeof window !== 'undefined' ? window.localStorage.getItem('LOG_LEVEL') : null;
    } catch {
        stored = null;
    }
    const valid: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
    if (stored && valid.includes(stored.toLowerCase() as LogLevel)) {
        return stored.toLowerCase() as LogLevel;
    }
    return 'info';
}

let currentLevel: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
    try {
        window.localStorage.setItem('LOG_LEVEL', level);
    } catch {
        // ignore
    }
}

function enabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

function prefix(level: LogLevel, namespace: string): string {
    const ts = new Date().toISOString();
    return `[${ts}] [${level.toUpperCase()}] [${namespace}]`;
}

class ConsoleLogger implements Logger {
    constructor(private readonly namespace: string, private readonly bindings: Record<string, unknown> = {}) {}

    private emit(
        level: LogLevel,
        consoleFn: (...args: unknown[]) => void,
        msg: string,
        fields?: Record<string, unknown>,
    ): void {
        if (!enabled(level)) return;
        const merged = { ...this.bindings, ...(fields || {}) };
        if (Object.keys(merged).length > 0) {
            consoleFn(prefix(level, this.namespace), msg, merged);
        } else {
            consoleFn(prefix(level, this.namespace), msg);
        }
    }

    trace(msg: string, fields?: Record<string, unknown>): void {
        this.emit('trace', console.debug.bind(console), msg, fields);
    }
    debug(msg: string, fields?: Record<string, unknown>): void {
        this.emit('debug', console.debug.bind(console), msg, fields);
    }
    info(msg: string, fields?: Record<string, unknown>): void {
        this.emit('info', console.info.bind(console), msg, fields);
    }
    warn(msg: string, fields?: Record<string, unknown>): void {
        this.emit('warn', console.warn.bind(console), msg, fields);
    }
    error(msg: string, fields?: Record<string, unknown>): void {
        this.emit('error', console.error.bind(console), msg, fields);
    }
    fatal(msg: string, fields?: Record<string, unknown>): void {
        this.emit('fatal', console.error.bind(console), msg, fields);
    }
    child(bindings: Record<string, unknown>): Logger {
        return new ConsoleLogger(this.namespace, { ...this.bindings, ...bindings });
    }
}

export function createLogger(namespace: string): Logger {
    return new ConsoleLogger(namespace);
}
