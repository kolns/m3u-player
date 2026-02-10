/**
 * Store — Config persistence via Tauri filesystem API.
 * Reads/writes config.json to the app data directory.
 */

const { invoke } = window.__TAURI__.core;

/** Default empty config */
const DEFAULT_CONFIG = { sources: [], channels: [] };

/** In-memory config cache */
let config = { ...DEFAULT_CONFIG };

/** Cached sorted channel list (invalidated on mutation) */
let _sortedCache = null;

/** Generate a short random ID */
function uid() {
    return Math.random().toString(36).slice(2, 10);
}

// ── Load / Save ─────────────────────────────────────────────

/** Load config from disk. Call once on startup. */
export async function loadConfig() {
    try {
        const raw = await invoke('read_config');
        const parsed = JSON.parse(raw);
        config = {
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            channels: Array.isArray(parsed.channels) ? parsed.channels : [],
        };
    } catch {
        config = { ...DEFAULT_CONFIG };
    }
    _sortedCache = null;
    return config;
}

/**
 * Persist current config to disk (debounced).
 * Rapid mutations (e.g. "Add All" on 500 channels) batch into one write.
 */
let _saveTimer = null;
function saveConfig() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        invoke('write_config', { data: JSON.stringify(config, null, 2) });
    }, 300);
}

/** Invalidate the sorted channel cache (call after any channel mutation). */
function invalidateCache() {
    _sortedCache = null;
}

// ── Sources ─────────────────────────────────────────────────

export function getSources() {
    return config.sources;
}

export function addSource(name, url) {
    const source = { id: uid(), name, url };
    config.sources.push(source);
    saveConfig();
    return source;
}

// ── Source Colors ───────────────────────────────────────────

/** Vibrant palette for source identification */
const SOURCE_COLORS = [
    '#6366f1', // indigo
    '#f59e0b', // amber
    '#10b981', // emerald
    '#ef4444', // red
    '#8b5cf6', // violet
    '#06b6d4', // cyan
    '#f97316', // orange
    '#ec4899', // pink
];

/** Get the auto-assigned color for a source by its ID. */
export function getSourceColor(sourceId) {
    const idx = config.sources.findIndex((s) => s.id === sourceId);
    if (idx < 0) return SOURCE_COLORS[0];
    return SOURCE_COLORS[idx % SOURCE_COLORS.length];
}

export function updateSource(id, name, url) {
    const src = config.sources.find((s) => s.id === id);
    if (src) {
        src.name = name;
        src.url = url;
        saveConfig();
    }
}

export function removeSource(id) {
    config.sources = config.sources.filter((s) => s.id !== id);
    config.channels = config.channels.filter((c) => c.sourceId !== id);
    invalidateCache();
    saveConfig();
}

// ── Channels ────────────────────────────────────────────────

/** Get saved channels sorted by order (cached until next mutation). */
export function getMyChannels() {
    if (!_sortedCache) {
        _sortedCache = [...config.channels].sort((a, b) => a.order - b.order);
    }
    return _sortedCache;
}

/** Check if a channel URL is already saved. */
export function hasChannel(url) {
    return config.channels.some((c) => c.url === url);
}

/** Add a channel from a source. */
export function addChannel(sourceId, channel) {
    if (hasChannel(channel.url)) return;
    const maxOrder = config.channels.reduce((max, c) => Math.max(max, c.order), -1);
    config.channels.push({
        id: uid(),
        sourceId,
        name: channel.name,
        url: channel.url,
        order: maxOrder + 1,
    });
    invalidateCache();
    saveConfig();
}

/** Remove a channel by its stream URL. */
export function removeChannelByUrl(url) {
    config.channels = config.channels.filter((c) => c.url !== url);
    invalidateCache();
    getMyChannels().forEach((c, i) => { c.order = i; });
    saveConfig();
}

/** Reorder channels by providing an array of channel IDs in the new order. */
export function reorderChannels(orderedIds) {
    orderedIds.forEach((id, i) => {
        const ch = config.channels.find((c) => c.id === id);
        if (ch) ch.order = i;
    });
    invalidateCache();
    saveConfig();
}
