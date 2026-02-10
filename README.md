# m3u Player

A desktop IPTV player built with [Tauri 2](https://v2.tauri.app/) + vanilla HTML/CSS/JS. Add M3U playlist sources, browse channels, and play live HLS & MPEG-TS streams — all through a local Rust proxy that handles CORS, redirects, and manifest rewriting.

## 📥 Download

Get the latest installers for **Windows, macOS, and Linux** on the **[Releases](https://github.com/kolns/m3u-player/releases)** page.

- **Windows**: `.msi` or `.exe`
- **macOS**: `.dmg` (Intel & Apple Silicon)
- **Linux**: `.deb` or `.AppImage`

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Desktop shell** | Tauri 2 (Rust) | Window management, IPC, filesystem, bundling |
| **HTTP proxy** | Axum + reqwest | Local proxy for CORS bypass, HLS manifest URL rewriting |
| **Frontend** | Vanilla JS (ES modules) | App controller, DOM rendering, drag-to-reorder |
| **Playback** | HLS.js, mpegts.js | Adaptive HLS streaming, raw MPEG-TS fallback |
| **Styling** | Vanilla CSS | Dark theme, CSS custom properties, glassmorphism |
| **Font** | Inter (Google Fonts) | Clean, modern UI typography |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tauri Webview                                          │
│                                                         │
│  index.html ─► main.js (app controller)                 │
│                  ├── store.js   (config persistence)    │
│                  ├── player.js  (HLS/TS playback)       │
│                  └── m3u-parser.js (playlist parsing)   │
│                                                         │
│  All stream URLs routed through ───┐                    │
│                                    ▼                    │
│  ┌──────────────────────────────────────┐               │
│  │  Rust Proxy (Axum on 127.0.0.1:*)    │               │
│  │  • Follows redirects                 │               │
│  │  • Rewrites HLS manifest URLs        │               │
│  │  • Adds CORS headers                 │               │
│  │  • Streams TS data passthrough       │               │
│  └──────────────────────────────────────┘               │
│                                                         │
│  Tauri IPC commands:                                    │
│    fetch_url      → fetch M3U playlists                 │
│    get_proxy_port → discover proxy port                 │
│    read_config    → load config.json from app data dir  │
│    write_config   → save config.json to app data dir    │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
tv/
├── src/                        # Frontend (served directly, no bundler)
│   ├── index.html              # App shell: titlebar, player, footer, drawer
│   ├── styles.css              # Design system with CSS custom properties
│   ├── main.js                 # App controller: drawer, channels, sources, drag-reorder
│   ├── player.js               # HLS/TS playback with auto-recovery
│   ├── m3u-parser.js           # M3U parser (quote-aware attribute handling)
│   ├── store.js                # Config persistence via Tauri IPC
│   ├── hls.min.js              # HLS.js library (vendored)
│   └── mpegts.min.js           # mpegts.js library (vendored)
│
├── src-tauri/                  # Rust backend
│   ├── src/lib.rs              # Proxy server, Tauri commands, manifest rewriting
│   ├── tauri.conf.json         # App config (identifier: com.m3u.player)
│   ├── Cargo.toml              # Rust dependencies
│   └── icons/                  # App icons for all platforms
│
└── package.json                # Node config (Tauri CLI dev dependency)
```

## Application Flow

### 1. Startup
- `lib.rs` boots an Axum HTTP proxy on a random port (`127.0.0.1:*`)
- Frontend loads, calls `get_proxy_port` via IPC to discover the proxy
- `store.js` loads `config.json` from the OS app data directory
- If no sources exist, the drawer opens to the Sources tab

### 2. Adding a Source
- User enters a name and M3U playlist URL on the **Sources** tab
- URL is saved to config; the source appears as a card with Browse/Edit/Delete actions
- Each source gets an auto-assigned color from an 8-color palette

### 3. Browsing & Adding Channels  
- Clicking **Browse** fetches the M3U playlist via `fetch_url` (Rust-side HTTP, no CORS)
- `m3u-parser.js` parses `#EXTINF` lines with quote-aware comma handling
- Channels are shown with checkboxes; toggling adds/removes from **My Channels**
- **Add All** bulk-adds all channels

### 4. Playing a Channel
- Clicking a channel card in **My Channels** calls `playChannel()` in `player.js`
- The stream URL is wrapped through the local proxy: `http://127.0.0.1:{port}/proxy?url={encoded}`
- `detectStreamType()` inspects the URL to choose the playback strategy:
  - **HLS** (`.m3u8`) → HLS.js with auto-recovery on network/media errors
  - **MPEG-TS** (`.mpg`, `format=ts`) → Tries converting to HLS first (works with Channels DVR), falls back to mpegts.js
  - **Unknown** → Tries HLS.js first (proxy follows redirects to actual manifests), then native `<video>`

### 5. Proxy Manifest Rewriting
When the proxy detects an HLS manifest response (by URL extension or `Content-Type`):
1. Buffers the manifest body
2. Uses the **final URL after redirects** as the base for resolving relative URLs
3. Rewrites every URL line and `URI=` attribute to route through the proxy
4. Returns the rewritten manifest with CORS headers

Non-manifest responses (TS segments, media) are **streamed directly** without buffering.

## Getting Started

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org/) (18+)
- Linux: GStreamer plugins for native video support
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```

### Development
```bash
# Install Tauri CLI
npm install

# Run in dev mode (hot-reloads frontend, auto-rebuilds Rust)
npx tauri dev
```

### Production Build
```bash
npx tauri build
```
The bundled app will be in `src-tauri/target/release/bundle/`.

## Key Design Decisions

- **No bundler** — Frontend is served directly from `src/`. No Vite, no Webpack, no build step for JS/CSS. This keeps the project simple and the dev loop instant.
- **Vendored player libs** — `hls.min.js` and `mpegts.min.js` are checked in rather than installed via npm. This avoids a complex build pipeline for two stable, rarely-updated libraries.
- **Local proxy** — Instead of fighting CORS in the webview, all external requests route through a Rust proxy on localhost. This also enables manifest rewriting for HLS streams behind redirects.
- **Debounced persistence** — `saveConfig()` uses a 300ms debounce timer so bulk operations (like "Add All" on 500 channels) result in a single disk write.
- **CSS-only design system** — All theming uses CSS custom properties defined at `:root`. No CSS framework, no preprocessor. Edit `styles.css` directly.

## Recommended IDE Setup

- **[Antigravity](https://antigravity.dev/)** — AI-native editor with built-in Tauri and Rust support. Open the project folder and run `npx tauri dev` from the integrated terminal.

## License

MIT
