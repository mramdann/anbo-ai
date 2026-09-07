(() => {
    const logs = [];
    window.__anboLogs = logs;
    let queued = false;
    const sync = () => {
        queued = false;
        try {
            document.documentElement?.setAttribute('data-anbo-console-logs', JSON.stringify(logs));
        } catch (_) {}
    };
    if (!document.documentElement) document.addEventListener('DOMContentLoaded', sync, { once: true });
    const safeString = value => {
        try {
            if (value === null || typeof value !== 'object') return String(value).slice(0, 2000);
            if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`.slice(0, 2000);
            const result = Object.create(null);
            let count = 0;
            for (const key in value) {
                if (count++ >= 20) break;
                if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                const item = value[key];
                result[key.slice(0, 100)] = item !== null && typeof item === 'object'
                    ? Object.prototype.toString.call(item) : String(item).slice(0, 500);
            }
            return JSON.stringify(result).slice(0, 2000);
        } catch (_) { return '[unserializable]'; }
    };
    const record = (level, message) => {
        try {
            logs.push({ level, msg: String(message).slice(0, 4000), ts: Date.now() });
            if (logs.length > 50) logs.shift();
            if (!queued) {
                queued = true;
                queueMicrotask(sync);
            }
        } catch (_) {}
    };
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'assert']) {
        const original = console[level];
        if (typeof original !== 'function') continue;
        console[level] = function(...args) {
            if (level !== 'assert' || !args[0]) {
                const values = level === 'assert' ? args.slice(1, 21) : args.slice(0, 20);
                record(level, (level === 'assert' ? 'Assertion failed: ' : '') + values.map(safeString).join(' '));
            }
            return Reflect.apply(original, this, args);
        };
    }
    window.addEventListener('error', event => {
        const message = safeString(event.message || 'runtime error');
        const location = event.filename ? ` at ${safeString(event.filename)}:${Number(event.lineno) || 0}:${Number(event.colno) || 0}` : '';
        record('error', `${message.startsWith('Uncaught') ? '' : 'Uncaught '}${message}${location}`);
    });
    window.addEventListener('unhandledrejection', event => {
        record('error', `Unhandled promise rejection: ${safeString(event.reason)}`);
    });
    sync();
})();
