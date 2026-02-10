# AI Agent Context

> This file provides context for AI coding agents working on this project.
> Read this before making any changes.

## What This App Is

An IPTV desktop player (Tauri 2 + vanilla JS). Users add M3U playlist sources, browse channels, and play HLS/MPEG-TS live streams. A local Rust proxy handles CORS, redirects, and HLS manifest rewriting.

## File Map

| File | Role | When to edit |
|------|------|--------------|
| `src/main.js` | App controller — drawer, tabs, channel/source rendering, drag-reorder | UI behavior, new tabs/views, event handling |
| `src/player.js` | Playback engine — HLS.js, mpegts.js, stream detection, auto-recovery | Playback bugs, new stream formats, player features |
| `src/m3u-parser.js` | M3U parser — `#EXTINF` attribute extraction, quote-aware commas | Parsing bugs, new M3U attributes |
| `src/store.js` | Config persistence — sources, channels, colors, debounced disk writes | Data model changes, new settings |
| `src/styles.css` | Full design system — CSS custom properties, dark theme | Styling, layout, animations |
| `src/index.html` | App shell — titlebar, player, footer, drawer structure | New HTML elements, structural changes |
| `src-tauri/src/lib.rs` | Rust backend — Axum proxy, Tauri IPC commands, manifest rewriting | Proxy behavior, new IPC commands, backend logic |
| `src-tauri/tauri.conf.json` | Tauri config — window settings, capabilities, bundling | Window behavior, permissions, app metadata |

## How the Pieces Connect

1. **`main.js`** imports from `store.js` (data), `player.js` (playback), and `m3u-parser.js` (parsing)
2. **`store.js`** calls Tauri IPC (`read_config`, `write_config`) — all saves are debounced 300ms
3. **`player.js`** receives already-proxied URLs from `main.js` via `toProxyUrl()`
4. **`lib.rs`** runs an Axum server on `127.0.0.1:{random_port}` — the frontend discovers the port via `get_proxy_port` IPC
5. **No bundler** — `src/` is served directly. JS uses ES module `import/export`. No build step for frontend.

## Data Model

Config is stored as JSON in the OS app data directory (`~/.local/share/com.m3u.player/config.json` on Linux):

```json
{
  "sources": [
    { "id": "abc123", "name": "My IPTV", "url": "http://example.com/playlist.m3u" }
  ],
  "channels": [
    { "id": "xyz789", "sourceId": "abc123", "name": "Channel 1", "url": "http://...", "order": 0 }
  ]
}
```

## Common Tasks

### Adding a new Tauri IPC command
1. Add the `#[tauri::command]` function in `lib.rs`
2. Register it in the `invoke_handler` macro at the bottom of `lib.rs`
3. Call it from JS: `await window.__TAURI__.core.invoke('command_name', { arg1, arg2 })`

### Adding a new UI feature
1. Add HTML structure in `index.html` (if new elements needed)
2. Add CSS in `styles.css` — use existing CSS custom properties from `:root`
3. Add behavior in `main.js` — get DOM refs at the top, wire events in `DOMContentLoaded`

### Adding a new data field
1. Update `addChannel()` or `addSource()` in `store.js`
2. Existing saved configs will keep working — missing fields default to `undefined`

### Modifying the proxy
- Manifest detection is in `proxy_handler` in `lib.rs`
- URL rewriting logic is in `rewrite_manifest()`
- The proxy uses `reqwest` with redirect following enabled by default
- Always use `resp.url()` (final URL after redirects) as the base for resolving relative URLs

## Style Conventions

- **JS**: 2-space indent, single quotes, ES modules, no semicolons optional (project uses them)
- **Rust**: Standard `rustfmt` defaults
- **CSS**: Use existing CSS custom properties (`--bg-primary`, `--text-primary`, `--accent`, etc.)
- **Comments**: Section headers use `// ── Section Name ──────` format in JS
- **Functions**: JSDoc on all exports; internal functions get a one-line `/** comment */`

## Things to Watch Out For

- **CORS**: All external URLs must go through the proxy. Never fetch external URLs directly from the webview.
- **M3U parsing**: Some playlists have commas inside quoted attribute values (e.g. `tvc-guide-description="..."`). The parser uses quote-aware comma scanning, not simple `indexOf(',')`.
- **Content-Type case**: Servers return mixed-case content types (e.g. `application/x-mpegURL`). Always lowercase before checking.
- **Redirect chains**: Stream URLs may redirect multiple times (e.g. Tubi: local server → CDN). The proxy follows redirects and uses the final URL for manifest rewriting.
- **Save debouncing**: `saveConfig()` has a 300ms debounce. Don't rely on data being on disk immediately — it's always current in memory.
- **No framework**: This is vanilla JS with direct DOM manipulation. No React, no Vue, no state management library. The in-memory `config` object in `store.js` is the single source of truth. Orginal Dev wanted extereme simplicity and no specific architectural patterns. 

## Running the App

```bash
npm install        # Install Tauri CLI
npx tauri dev      # Dev mode (hot-reloads frontend, rebuilds Rust on changes)
npx tauri build    # Production bundle
```
