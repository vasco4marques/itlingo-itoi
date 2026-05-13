import { Logger, LogLevel, LOG_LEVEL_ORDER } from '../common/logger';

function resolveLevel(): LogLevel {
    const envLevel = (process.env.LOG_LEVEL || '').toLowerCase() as LogLevel;
    const valid: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
    if (valid.includes(envLevel)) {
        return envLevel;
    }
    return process.env.ITOI_PROD === 'DEV' ? 'debug' : 'info';
}

function shouldPretty(): boolean {
    if (process.env.LOG_PRETTY !== undefined) {
        return process.env.LOG_PRETTY === 'true' || process.env.LOG_PRETTY === '1';
    }
    return process.env.ITOI_PROD === 'DEV';
}

const currentLevel: LogLevel = resolveLevel();
const pretty: boolean = shouldPretty();

const COLOR: Record<LogLevel, string> = {
    trace: '\x1b[90m',
    debug: '\x1b[36m',
    info: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    fatal: '\x1b[35m',
    silent: '',
};
const RESET = '\x1b[0m';

function enabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

function formatPretty(level: LogLevel, namespace: string, msg: string, fields?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const color = COLOR[level] || '';
    const head = `${color}[${ts}] [${level.toUpperCase()}] [${namespace}]${RESET}`;
    if (fields && Object.keys(fields).length > 0) {
        let extras: string;
        try {
            extras = JSON.stringify(fields);
        } catch {
            extras = String(fields);
        }
        return `${head} ${msg} ${extras}`;
    }
    return `${head} ${msg}`;
}

function formatJson(level: LogLevel, namespace: string, msg: string, fields?: Record<string, unknown>): string {
    const entry: Record<string, unknown> = {
        time: new Date().toISOString(),
        level,
        ns: namespace,
        msg,
    };
    if (fields) {
        for (const [k, v] of Object.entries(fields)) {
            if (!(k in entry)) entry[k] = v;
        }
    }
    try {
        return JSON.stringify(entry);
    } catch {
        return JSON.stringify({ time: entry.time, level, ns: namespace, msg, fieldsError: 'unserializable' });
    }
}

function emit(level: LogLevel, namespace: string, msg: string, fields?: Record<string, unknown>): void {
    if (!enabled(level)) return;
    const line = pretty
        ? formatPretty(level, namespace, msg, fields)
        : formatJson(level, namespace, msg, fields);
    const stream = level === 'error' || level === 'fatal' || level === 'warn'
        ? process.stderr
        : process.stdout;
    stream.write(line + '\n');
}

class NodeLogger implements Logger {
    constructor(private readonly namespace: string, private readonly bindings: Record<string, unknown> = {}) {}

    private merge(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
        if (!fields && Object.keys(this.bindings).length === 0) return undefined;
        return { ...this.bindings, ...(fields || {}) };
    }

    trace(msg: string, fields?: Record<string, unknown>): void { emit('trace', this.namespace, msg, this.merge(fields)); }
    debug(msg: string, fields?: Record<string, unknown>): void { emit('debug', this.namespace, msg, this.merge(fields)); }
    info(msg: string, fields?: Record<string, unknown>): void { emit('info', this.namespace, msg, this.merge(fields)); }
    warn(msg: string, fields?: Record<string, unknown>): void { emit('warn', this.namespace, msg, this.merge(fields)); }
    error(msg: string, fields?: Record<string, unknown>): void { emit('error', this.namespace, msg, this.merge(fields)); }
    fatal(msg: string, fields?: Record<string, unknown>): void { emit('fatal', this.namespace, msg, this.merge(fields)); }
    child(bindings: Record<string, unknown>): Logger {
        return new NodeLogger(this.namespace, { ...this.bindings, ...bindings });
    }
}

export function createLogger(namespace: string): Logger {
    return new NodeLogger(namespace);
}

export function redactDbUrl(url: string | undefined): string {
    if (!url) return '<unset>';
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        if (u.username) u.username = u.username.replace(/.(?=.{0,0}$)/g, '*');
        return u.toString();
    } catch {
        return '<unparseable>';
    }
}
