/**
 * M3U Playlist Parser
 * Fetches and parses an M3U/M3U8 playlist URL, returning an array of channels.
 */

/**
 * @typedef {Object} Channel
 * @property {string} name - Channel display name
 * @property {string} url - Stream URL (HLS or MP4)
 * @property {string} [logo] - Optional channel logo URL
 * @property {string} [group] - Optional group/category
 */

/**
 * Parse an M3U playlist string into an array of Channel objects.
 * @param {string} content - Raw M3U file content
 * @param {string} [baseUrl] - Base URL to resolve relative paths against
 * @returns {Channel[]}
 */
export function parseM3U(content, baseUrl = '') {
  const lines = content.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      current = parseExtInf(line);
    } else if (line && !line.startsWith('#') && current) {
      current.url = resolveUrl(line, baseUrl);
      channels.push(current);
      current = null;
    } else if (line && !line.startsWith('#') && !current) {
      // URL line without preceding #EXTINF — use URL as name
      const resolvedUrl = resolveUrl(line, baseUrl);
      channels.push({
        name: extractNameFromUrl(resolvedUrl),
        url: resolvedUrl,
      });
    }
  }

  return channels;
}

/**
 * Resolve a relative URL against a base URL.
 * @param {string} url
 * @param {string} base
 * @returns {string}
 */
function resolveUrl(url, base) {
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * Parse an #EXTINF line to extract metadata.
 * Handles formats like:
 *   #EXTINF:-1 tvg-logo="url" group-title="group",Channel Name
 *   #EXTINF:-1,Channel Name
 * @param {string} line
 * @returns {Partial<Channel>}
 */
function parseExtInf(line) {
  const channel = { name: 'Unknown' };

  // Find the display name — it's after the LAST comma that's not inside quotes.
  // We need to skip commas within quoted attribute values like tvc-guide-description="..., ..."
  let nameCommaIdx = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) {
      nameCommaIdx = i;
    }
  }

  if (nameCommaIdx !== -1) {
    channel.name = line.substring(nameCommaIdx + 1).trim() || 'Unknown';
  }

  // Extract tvg-logo
  const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
  if (logoMatch && logoMatch[1]) {
    channel.logo = logoMatch[1];
  }

  // Extract group-title
  const groupMatch = line.match(/group-title="([^"]*)"/i);
  if (groupMatch && groupMatch[1]) {
    channel.group = groupMatch[1];
  }

  return channel;
}

/**
 * Extract a readable name from a URL (fallback when no #EXTINF).
 * @param {string} url
 * @returns {string}
 */
function extractNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop();
    return filename ? decodeURIComponent(filename.replace(/\.[^.]+$/, '')) : url;
  } catch {
    return url;
  }
}

/**
 * Fetch and parse an M3U playlist from a URL.
 * Uses Tauri's Rust backend to fetch, bypassing browser CORS restrictions.
 * @param {string} url - The M3U playlist URL
 * @returns {Promise<Channel[]>}
 * @throws {Error} if fetch fails or content is invalid
 */
export async function fetchAndParseM3U(url) {
  let result;
  try {
    // Use Tauri IPC to fetch from the Rust backend (no CORS issues)
    // Backend now returns { body: string, final_url: string }
    result = await window.__TAURI__.core.invoke('fetch_url', { url });
  } catch (err) {
    throw new Error(typeof err === 'string' ? err : `Failed to fetch playlist: ${err.message || err}`);
  }

  const channels = parseM3U(result.body, result.final_url);

  if (channels.length === 0) {
    throw new Error('No channels found in playlist. Make sure the URL points to a valid M3U file.');
  }

  return channels;
}
