/**
 * m3u Player — Main Application Controller
 * Multi-source M3U channel management with persistent config.
 */
import { fetchAndParseM3U } from './m3u-parser.js';
import { initPlayer, playChannel, stopPlayer } from './player.js';
import {
  loadConfig, getSources, addSource, removeSource, updateSource,
  getMyChannels, addChannel, removeChannelByUrl, hasChannel,
  reorderChannels, getSourceColor,
} from './store.js';

// DOM references
const videoPlayer = document.getElementById('video-player');
const playerOverlay = document.getElementById('player-overlay');
const nowPlayingDot = document.getElementById('now-playing-dot');
const nowPlayingName = document.getElementById('now-playing-name');
const stopBtn = document.getElementById('stop-btn');
const channelsBtn = document.getElementById('channels-btn');
const channelDrawer = document.getElementById('channel-drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');

// Drawer tabs
const tabButtons = document.querySelectorAll('.drawer-tab');
const tabChannels = document.getElementById('tab-channels');
const tabSources = document.getElementById('tab-sources');
const tabBrowse = document.getElementById('tab-browse');

// My Channels
const channelGrid = document.getElementById('channel-grid');
const noChannels = document.getElementById('no-channels');

// Sources
const sourceNameInput = document.getElementById('source-name');
const sourceUrlInput = document.getElementById('source-url');
const addSourceBtn = document.getElementById('add-source-btn');
const sourceError = document.getElementById('source-error');
const sourceList = document.getElementById('source-list');
const noSources = document.getElementById('no-sources');

// Browse
const browseBack = document.getElementById('browse-back');
const browseSourceName = document.getElementById('browse-source-name');
const browseCount = document.getElementById('browse-count');
const browseAddAll = document.getElementById('browse-add-all');
const browseGrid = document.getElementById('browse-grid');
const browseLoading = document.getElementById('browse-loading');

/** Proxy port from Rust backend */
let proxyPort = 0;

/** Currently active channel URL */
let activeChannelUrl = null;

/** Source being browsed */
let browsingSource = null;

/** Channels fetched from the source being browsed */
let browsedChannels = [];

// ── Initialization ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initPlayer(videoPlayer);

  // Window controls
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  document.getElementById('titlebar-minimize').addEventListener('click', () => appWindow.minimize());
  document.getElementById('titlebar-maximize').addEventListener('click', () => appWindow.toggleMaximize());
  document.getElementById('titlebar-close').addEventListener('click', () => appWindow.close());

  // Credits Easter egg
  const creditsStar = document.getElementById('credits-star');
  const creditsPopover = document.getElementById('credits-popover');
  creditsStar.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = creditsPopover.classList.contains('visible');
    creditsPopover.classList.toggle('visible', !isOpen);
    creditsPopover.classList.toggle('hidden', isOpen);
    creditsStar.classList.toggle('active', !isOpen);
  });
  document.addEventListener('click', () => {
    creditsPopover.classList.remove('visible');
    creditsPopover.classList.add('hidden');
    creditsStar.classList.remove('active');
  });
  creditsPopover.addEventListener('click', (e) => e.stopPropagation());

  // Open credit links in system browser via Tauri opener
  creditsPopover.querySelectorAll('a[href]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.__TAURI__.opener.openUrl(link.href);
    });
  });

  // Get proxy port
  proxyPort = await window.__TAURI__.core.invoke('get_proxy_port');

  // Load config
  await loadConfig();

  // Stop button
  stopBtn.addEventListener('click', stopChannel);

  // Render initial state
  renderMyChannels();
  renderSources();

  // If no sources yet, open drawer to Sources tab
  if (getSources().length === 0) {
    openDrawer();
    switchTab('sources');
  }

  // Event listeners
  channelsBtn.addEventListener('click', () => {
    openDrawer();
    switchTab('channels');
  });
  drawerBackdrop.addEventListener('click', closeDrawer);
  document.getElementById('drawer-handle').addEventListener('click', closeDrawer);

  // Tabs
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Add source
  addSourceBtn.addEventListener('click', onAddSource);
  sourceUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onAddSource(); }
  });

  // Browse back
  browseBack.addEventListener('click', () => switchTab('sources'));

  // Browse add all
  browseAddAll.addEventListener('click', onAddAll);

  // Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && channelDrawer.classList.contains('drawer-open')) {
      closeDrawer();
    }
  });
});

// ── Drawer ──────────────────────────────────────────────────
function openDrawer() {
  channelDrawer.classList.add('drawer-open');
  drawerBackdrop.classList.remove('hidden');
  requestAnimationFrame(() => drawerBackdrop.classList.add('visible'));
}

function closeDrawer() {
  channelDrawer.classList.remove('drawer-open');
  drawerBackdrop.classList.remove('visible');
  setTimeout(() => {
    if (!channelDrawer.classList.contains('drawer-open')) {
      drawerBackdrop.classList.add('hidden');
    }
  }, 350);
}

function switchTab(tab) {
  // Update tab buttons
  tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));

  // Show/hide tab content
  tabChannels.classList.toggle('hidden', tab !== 'channels');
  tabSources.classList.toggle('hidden', tab !== 'sources');
  tabBrowse.classList.toggle('hidden', tab !== 'browse');

  // Show/hide tab bar when in browse mode
  document.getElementById('drawer-tabs').classList.toggle('hidden', tab === 'browse');
}

// ── My Channels ─────────────────────────────────────────────
function renderMyChannels() {
  const channels = getMyChannels();
  channelGrid.innerHTML = '';

  noChannels.classList.toggle('hidden', channels.length > 0);

  channels.forEach((channel) => {
    const btn = document.createElement('button');
    btn.className = 'channel-btn';
    if (channel.url === activeChannelUrl) btn.classList.add('active');
    btn.title = channel.name;
    btn.dataset.id = channel.id;
    btn.draggable = true;

    // Source color accent
    const sourceColor = getSourceColor(channel.sourceId);
    btn.style.setProperty('--source-color', sourceColor);

    // Drag handle (6-dot grip)
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'drag-handle-dot';
      handle.appendChild(dot);
    }

    // Channel info
    const info = document.createElement('div');
    info.className = 'channel-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'channel-name';
    nameEl.textContent = channel.name;
    info.appendChild(nameEl);

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'channel-remove';
    removeBtn.title = 'Remove channel';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeChannelByUrl(channel.url);
      renderMyChannels();
    });

    btn.appendChild(handle);
    btn.appendChild(info);
    btn.appendChild(removeBtn);

    btn.addEventListener('click', () => selectChannel(channel));

    // Drag-to-reorder: only dragstart/dragend on individual buttons
    btn.addEventListener('dragstart', onDragStart);
    btn.addEventListener('dragend', onDragEnd);

    channelGrid.appendChild(btn);
  });
}

function selectChannel(channel) {
  activeChannelUrl = channel.url;

  // Update UI
  document.querySelectorAll('.channel-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.id === channel.id);
  });

  nowPlayingDot.classList.remove('hidden');
  nowPlayingName.textContent = channel.name;
  nowPlayingName.style.color = 'var(--text-primary)';
  playerOverlay.classList.remove('visible');

  document.body.classList.add('is-playing');
  stopBtn.classList.remove('hidden');
  playChannel(toProxyUrl(channel.url));
  closeDrawer();
}

/** Stop current channel and reset UI */
function stopChannel() {
  stopPlayer();
  activeChannelUrl = null;

  // Update UI
  document.body.classList.remove('is-playing');
  stopBtn.classList.add('hidden');
  nowPlayingDot.classList.add('hidden');
  nowPlayingName.textContent = 'No channel selected';
  nowPlayingName.style.color = '';
  playerOverlay.classList.add('visible');

  // remove active class from all channel buttons
  document.querySelectorAll('.channel-btn').forEach((btn) => {
    btn.classList.remove('active');
  });
}

// ── Drag-to-Reorder ─────────────────────────────────────────
let draggedId = null;

function onDragStart(e) {
  draggedId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Required for WebKitGTK — drop event won't fire without setData()
  e.dataTransfer.setData('text/plain', draggedId);
}

/** Find the channel button closest to the cursor position (2D distance). */
function getClosestButton(x, y) {
  const buttons = [...channelGrid.querySelectorAll('.channel-btn')];
  let closest = null;
  let closestDist = Infinity;

  for (const btn of buttons) {
    const rect = btn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
    if (dist < closestDist) {
      closestDist = dist;
      closest = btn;
    }
  }
  return closest;
}

// Grid-level dragover: allow drop anywhere and highlight nearest button
channelGrid.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Highlight the closest button as the drop target
  channelGrid.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  const target = getClosestButton(e.clientX, e.clientY);
  if (target && target.dataset.id !== draggedId) {
    target.classList.add('drag-over');
  }
});

channelGrid.addEventListener('dragleave', (e) => {
  // Only clear highlights when leaving the grid entirely
  if (!channelGrid.contains(e.relatedTarget)) {
    channelGrid.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  }
});

// Grid-level drop: compute insertion from closest button
channelGrid.addEventListener('drop', (e) => {
  e.preventDefault();
  channelGrid.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));

  const target = getClosestButton(e.clientX, e.clientY);
  if (!draggedId || !target || target.dataset.id === draggedId) return;

  const buttons = [...channelGrid.querySelectorAll('.channel-btn')];
  const ids = buttons.map((b) => b.dataset.id);
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(target.dataset.id);

  if (fromIdx === -1 || toIdx === -1) return;

  // Remove from old position, then adjust insertion index:
  // dragging downward shifts elements left by one after the removal.
  ids.splice(fromIdx, 1);
  const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  ids.splice(insertIdx, 0, draggedId);

  reorderChannels(ids);
  renderMyChannels();
});

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  channelGrid.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  draggedId = null;
}

// ── Sources ─────────────────────────────────────────────────
function renderSources() {
  const sources = getSources();
  sourceList.innerHTML = '';
  noSources.classList.toggle('hidden', sources.length > 0);

  sources.forEach((source) => {
    const card = document.createElement('div');
    card.className = 'source-card';

    // Source color
    const sourceColor = getSourceColor(source.id);
    card.style.setProperty('--source-color', sourceColor);

    const icon = document.createElement('div');
    icon.className = 'source-icon';
    icon.textContent = '📡';
    icon.style.background = `linear-gradient(135deg, ${sourceColor}22, ${sourceColor}33)`;

    const info = document.createElement('div');
    info.className = 'source-info';

    const name = document.createElement('div');
    name.className = 'source-name';
    name.textContent = source.name;

    const url = document.createElement('div');
    url.className = 'source-url';
    url.textContent = source.url;

    info.appendChild(name);
    info.appendChild(url);

    const actions = document.createElement('div');
    actions.className = 'source-actions';

    const browseBtn = document.createElement('button');
    browseBtn.className = 'source-action-btn browse';
    browseBtn.textContent = 'Browse';
    browseBtn.addEventListener('click', () => browseSource(source));

    const editBtn = document.createElement('button');
    editBtn.className = 'source-action-btn edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      // Switch card to edit mode
      name.innerHTML = '';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'source-edit-input';
      nameInput.value = source.name;
      name.appendChild(nameInput);

      url.innerHTML = '';
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'source-edit-input';
      urlInput.value = source.url;
      url.appendChild(urlInput);

      // Swap buttons
      actions.innerHTML = '';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'source-action-btn browse';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => {
        const newName = nameInput.value.trim();
        const newUrl = urlInput.value.trim();
        if (newName && newUrl) {
          updateSource(source.id, newName, newUrl);
          renderSources();
        }
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'source-action-btn delete';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => renderSources());

      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      nameInput.focus();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'source-action-btn delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      removeSource(source.id);
      renderSources();
      renderMyChannels();
    });

    actions.appendChild(browseBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(actions);
    sourceList.appendChild(card);
  });
}

function onAddSource() {
  const name = sourceNameInput.value.trim();
  const url = sourceUrlInput.value.trim();

  sourceError.classList.add('hidden');

  if (!name) {
    sourceError.textContent = 'Please enter a source name';
    sourceError.classList.remove('hidden');
    return;
  }
  if (!url) {
    sourceError.textContent = 'Please enter an M3U playlist URL';
    sourceError.classList.remove('hidden');
    return;
  }

  addSource(name, url);
  sourceNameInput.value = '';
  sourceUrlInput.value = '';
  renderSources();
}

// ── Browse Source ───────────────────────────────────────────
async function browseSource(source) {
  browsingSource = source;
  browseSourceName.textContent = source.name;
  browseCount.textContent = '';
  browseGrid.innerHTML = '';
  browseLoading.classList.remove('hidden');
  browsedChannels = [];

  switchTab('browse');

  try {
    browsedChannels = await fetchAndParseM3U(source.url);
    browseCount.textContent = `${browsedChannels.length} channels`;
    renderBrowseGrid();
  } catch (err) {
    browseGrid.innerHTML = `<p class="empty-state">Failed to load: ${err.message}</p>`;
  } finally {
    browseLoading.classList.add('hidden');
  }
}

function renderBrowseGrid() {
  browseGrid.innerHTML = '';

  browsedChannels.forEach((channel) => {
    const item = document.createElement('div');
    item.className = 'browse-item';
    if (hasChannel(channel.url)) item.classList.add('added');

    // Checkbox toggle
    const toggle = document.createElement('button');
    toggle.className = 'browse-toggle';
    toggle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBrowseChannel(channel, item);
    });

    // Channel info
    const info = document.createElement('div');
    info.className = 'channel-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'channel-name';
    nameEl.textContent = channel.name;
    info.appendChild(nameEl);

    item.appendChild(toggle);
    item.appendChild(info);

    item.addEventListener('click', () => toggleBrowseChannel(channel, item));
    browseGrid.appendChild(item);
  });
}

function toggleBrowseChannel(channel, item) {
  if (hasChannel(channel.url)) {
    removeChannelByUrl(channel.url);
    item.classList.remove('added');
  } else {
    addChannel(browsingSource.id, channel);
    item.classList.add('added');
  }
  renderMyChannels();
}

function onAddAll() {
  if (!browsingSource) return;
  browsedChannels.forEach((channel) => {
    if (!hasChannel(channel.url)) {
      addChannel(browsingSource.id, channel);
    }
  });
  renderBrowseGrid();
  renderMyChannels();
}

// ── Helpers ─────────────────────────────────────────────────
/** Wrap a stream URL through the local Rust proxy to avoid CORS issues. */
function toProxyUrl(originalUrl) {
  if (!proxyPort) return originalUrl;
  return `http://127.0.0.1:${proxyPort}/proxy?url=${encodeURIComponent(originalUrl)}`;
}
