/**
 * HLS & MPEG-TS Video Player Module
 * Uses HLS.js for .m3u8 streams and auto-converts TS streams to HLS where
 * possible (e.g. Channels DVR). Falls back to mpegts.js for raw TS streams.
 * Streams are routed through the local Rust proxy so there are no CORS issues.
 */

/** @type {Hls|null} */
let hlsInstance = null;

/** @type {any} mpegts.js player instance */
let mpegtsPlayer = null;

/** @type {HTMLVideoElement} */
let videoEl = null;

/**
 * Initialize the player module with a video element.
 * @param {HTMLVideoElement} element
 */
export function initPlayer(element) {
    videoEl = element;
}

/**
 * Destroy any active player instances and reset the video element.
 */
function destroyPlayers() {
    if (hlsInstance) {
        // Remove auto-resume listener
        if (hlsInstance._pauseHandler && hlsInstance._videoEl) {
            hlsInstance._videoEl.removeEventListener('pause', hlsInstance._pauseHandler);
        }
        hlsInstance.destroy();
        hlsInstance = null;
    }
    if (mpegtsPlayer) {
        try {
            mpegtsPlayer.pause();
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
        } catch { /* ignore */ }
        mpegtsPlayer = null;
    }
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
}
/**
 * Stop any active playback and cleanup.
 */
export function stopPlayer() {
    destroyPlayers();
}

/**
 * Try to convert a TS stream URL to HLS format.
 * Works for Channels DVR and similar servers that support both formats.
 * Returns null if no conversion is possible.
 *
 * Channels DVR pattern:
 *   TS:  /devices/ANY/channels/9001/stream.mpg?collection=2&format=ts&codec=copy
 *   HLS: /devices/ANY/channels/9001/hls/master.m3u8?collection=2
 *
 * @param {string} url
 * @returns {string|null}
 */
function tryConvertToHLS(url) {
    try {
        const u = new URL(url);

        // Channels DVR: /channels/{id}/stream.mpg → /channels/{id}/hls/master.m3u8
        if (u.pathname.includes('/channels/') && u.pathname.endsWith('/stream.mpg')) {
            u.pathname = u.pathname.replace('/stream.mpg', '/hls/master.m3u8');
            u.searchParams.delete('format');
            u.searchParams.delete('codec');
            return u.toString();
        }

        // Generic: URL has format=ts param — try changing to format=hls
        const format = u.searchParams.get('format');
        if (format === 'ts') {
            u.searchParams.set('format', 'hls');
            return u.toString();
        }
    } catch { /* malformed URL */ }

    return null;
}

/**
 * Detect stream type from URL.
 * @param {string} url
 * @returns {'hls'|'ts'|'other'}
 */
function detectStreamType(url) {
    try {
        const u = new URL(url);
        const path = u.pathname.toLowerCase();
        const params = u.searchParams;

        // Explicit HLS
        if (path.endsWith('.m3u8')) return 'hls';

        // Explicit TS file
        if (path.endsWith('.ts')) return 'ts';

        // Channels DVR & similar: stream.mpg?format=ts
        if (params.get('format') === 'ts') return 'ts';

        // Common IPTV patterns: .mpg streams are typically TS
        if (path.endsWith('.mpg')) return 'ts';

        // Live stream paths without clear extension
        if (path.includes('/stream') || path.includes('/live/')) return 'ts';
    } catch {
        // Fallback for malformed URLs
        const lower = url.toLowerCase();
        if (lower.includes('.m3u8')) return 'hls';
        if (lower.includes('.ts') || lower.includes('format=ts')) return 'ts';
    }
    return 'other';
}

/**
 * Build a proxied URL from an original URL.
 * @param {string} originalUrl
 * @param {number} proxyPort - extracted from the current proxy URL
 * @returns {string}
 */
function buildProxyUrl(originalUrl, proxyPort) {
    return `http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Play a channel's stream URL (should already be a proxied URL).
 * Auto-detects HLS vs MPEG-TS vs native based on the URL.
 * For TS streams, attempts to convert to HLS first for best compatibility.
 * @param {string} url - The stream URL (proxied through localhost)
 */
export function playChannel(url) {
    if (!videoEl) {
        console.error('Player not initialized. Call initPlayer() first.');
        return;
    }

    destroyPlayers();

    // Extract the original URL and proxy port from the proxy URL
    let originalUrl = url;
    let proxyPort = 0;
    try {
        const u = new URL(url);
        const decoded = u.searchParams.get('url');
        if (decoded) {
            originalUrl = decoded;
            proxyPort = parseInt(u.port, 10);
        }
    } catch { /* use url as-is */ }

    const streamType = detectStreamType(originalUrl);

    if (streamType === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
        playHLS(url);
    } else if (streamType === 'ts') {
        // Try to convert TS URL to HLS for maximum compatibility
        const hlsUrl = tryConvertToHLS(originalUrl);
        if (hlsUrl && typeof Hls !== 'undefined' && Hls.isSupported() && proxyPort) {
            console.log('Converting TS stream to HLS:', originalUrl, '->', hlsUrl);
            playHLS(buildProxyUrl(hlsUrl, proxyPort));
        } else if (typeof mpegts !== 'undefined' && mpegts.isSupported()) {
            // Fallback to mpegts.js for raw TS that can't be converted
            playMpegTS(url);
        } else {
            // Last resort: try native playback
            videoEl.src = url;
            videoEl.play().catch(() => { });
        }
    } else if (streamType === 'hls' && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari/WebKit native HLS
        videoEl.src = url;
        videoEl.addEventListener('loadedmetadata', () => {
            videoEl.play().catch(() => { });
        }, { once: true });
    } else {
        // Unknown type — try HLS.js first (proxy follows redirects, so
        // the URL may resolve to an HLS manifest), fall back to native
        if (typeof Hls !== 'undefined' && Hls.isSupported()) {
            playHLS(url);
        } else {
            videoEl.src = url;
            videoEl.play().catch(() => { });
        }
    }
}

/**
 * Play HLS stream using HLS.js
 */
function playHLS(url) {
    hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1,
    });

    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoEl);

    // Auto-resume: if the video pauses unexpectedly while HLS is active, retry
    const onPause = () => {
        if (hlsInstance && !videoEl.ended) {
            setTimeout(() => {
                if (videoEl.paused && hlsInstance) {
                    videoEl.play().catch(() => { });
                }
            }, 500);
        }
    };

    // Keep retrying play until it sticks
    const tryPlay = () => {
        videoEl.play().catch(() => {
            // If play fails, retry after a short delay
            if (hlsInstance) {
                setTimeout(tryPlay, 1000);
            }
        });
    };

    videoEl.addEventListener('pause', onPause);

    // Store cleanup ref so destroyPlayers can remove the listener
    hlsInstance._pauseHandler = onPause;
    hlsInstance._videoEl = videoEl;

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlay();
    });

    // Also try playing when first fragment is buffered (data is actually ready)
    hlsInstance.on(Hls.Events.FRAG_BUFFERED, () => {
        if (videoEl.paused) {
            videoEl.play().catch(() => { });
        }
    });

    hlsInstance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    console.warn('HLS network error, attempting recovery...');
                    hlsInstance.startLoad();
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.warn('HLS media error, attempting recovery...');
                    hlsInstance.recoverMediaError();
                    break;
                default:
                    console.error('Fatal HLS error:', data);
                    videoEl.removeEventListener('pause', onPause);
                    hlsInstance.destroy();
                    hlsInstance = null;
                    break;
            }
        }
    });
}

/**
 * Play MPEG-TS stream using mpegts.js (fallback for raw TS streams)
 */
function playMpegTS(url) {
    mpegtsPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: url,
    }, {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 128 * 1024,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 5,
        liveBufferLatencyMinRemain: 1,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15,
    });

    mpegtsPlayer.attachMediaElement(videoEl);
    mpegtsPlayer.load();

    setTimeout(() => {
        videoEl.play().catch(() => { });
    }, 300);

    mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
        console.error('mpegts.js error:', type, detail, info);
        if (type === mpegts.ErrorTypes.NETWORK_ERROR
            || type === mpegts.ErrorTypes.MEDIA_ERROR) {
            console.warn('mpegts.js cleanup after error');
            try {
                mpegtsPlayer.pause();
                mpegtsPlayer.unload();
            } catch { /* ignore */ }
        }
    });
}
