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

// State
let proxyPort = 0;
let activeChannelUrl = null;
let browsingSource = null;
let browsedChannels = [];

// DOM References (assigned in init)
let videoPlayer, playerOverlay, nowPlayingDot, nowPlayingName, stopBtn;
let channelsBtn, sourcesBtn, channelDrawer, settingsDrawer, drawerBackdrop;
let tabChannels, tabSources, tabBrowse, channelGrid, noChannels;
let sourceNameInput, sourceUrlInput, addSourceBtn, sourceError, sourceList, noSources;
let browseHeader, browseBack, browseSourceName, browseCount, browseAddAll, browseGrid, browseLoading;

// ── Initialization ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize DOM references
  videoPlayer = document.getElementById('video-player');
  playerOverlay = document.getElementById('player-overlay');
  nowPlayingDot = document.getElementById('now-playing-dot');
  nowPlayingName = document.getElementById('now-playing-name');
  stopBtn = document.getElementById('stop-btn');
  channelsBtn = document.getElementById('channels-btn');
  sourcesBtn = document.getElementById('sources-btn');
  channelDrawer = document.getElementById('channel-drawer');
  settingsDrawer = document.getElementById('settings-drawer');
  drawerBackdrop = document.getElementById('drawer-backdrop');

  tabChannels = document.getElementById('tab-channels');
  tabSources = document.getElementById('tab-sources');
  tabBrowse = document.getElementById('tab-browse');

  channelGrid = document.getElementById('channel-grid');
  noChannels = document.getElementById('no-channels');

  sourceNameInput = document.getElementById('source-name');
  sourceUrlInput = document.getElementById('source-url');
  addSourceBtn = document.getElementById('add-source-btn');
  sourceError = document.getElementById('source-error');
  sourceList = document.getElementById('source-list');
  noSources = document.getElementById('no-sources');

  browseHeader = document.getElementById('browse-header');
  browseBack = document.getElementById('browse-back');
  browseSourceName = document.getElementById('browse-source-name');
  browseCount = document.getElementById('browse-count');
  browseAddAll = document.getElementById('browse-add-all');
  browseGrid = document.getElementById('browse-grid');
  browseLoading = document.getElementById('browse-loading');

  initPlayer(videoPlayer);

  // Window controls
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  document.getElementById('titlebar-minimize').addEventListener('click', () => appWindow.minimize());
  document.getElementById('titlebar-maximize').addEventListener('click', () => appWindow.toggleMaximize());
  document.getElementById('titlebar-close').addEventListener('click', () => appWindow.close());

  // Credits Modal
  const creditsStar = document.getElementById('credits-star');
  const creditsModal = document.getElementById('credits-modal');
  const creditsClose = document.getElementById('credits-close');

  creditsStar.addEventListener('click', (e) => {
    e.stopPropagation();
    creditsModal.classList.remove('hidden');
    requestAnimationFrame(() => creditsModal.classList.add('visible'));
  });

  creditsClose.addEventListener('click', () => {
    creditsModal.classList.remove('visible');
    setTimeout(() => creditsModal.classList.add('hidden'), 300);
  });

  creditsModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    creditsModal.classList.remove('visible');
    setTimeout(() => creditsModal.classList.add('hidden'), 300);
  });

  // Open credit links in system browser via Tauri opener
  creditsModal.querySelectorAll('a[href]').forEach((link) => {
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
    toggleDrawer(settingsDrawer, sourcesBtn);
  }

  // Event listeners
  channelsBtn.addEventListener('click', () => {
    switchTab('channels');
    toggleDrawer(channelDrawer, channelsBtn);
  });
  sourcesBtn.addEventListener('click', () => {
    switchTab('sources');
    toggleDrawer(settingsDrawer, sourcesBtn);
  });

  drawerBackdrop.addEventListener('click', closeAllDrawers);

  // Close buttons in drawers
  document.querySelectorAll('.drawer-close').forEach(btn => {
    btn.addEventListener('click', closeAllDrawers);
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
    if (e.key === 'Escape') {
      closeAllDrawers();
      const creditsModal = document.getElementById('credits-modal');
      creditsModal.classList.remove('visible');
      setTimeout(() => creditsModal.classList.add('hidden'), 300);
    }
  });
  // Drag-to-reorder grid listeners
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
});

// ── Drawer ──────────────────────────────────────────────────
function toggleDrawer(drawer, button) {
  const isOpen = drawer.classList.contains('drawer-open');

  if (isOpen) {
    closeAllDrawers();
  } else {
    closeAllDrawers(); // Close any other drawer first
    drawer.classList.add('drawer-open');
    button.classList.add('active');
    drawerBackdrop.classList.remove('hidden');
    requestAnimationFrame(() => drawerBackdrop.classList.add('visible'));
  }
}

function closeAllDrawers() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('drawer-open'));
  document.querySelectorAll('#footer-center button').forEach(b => b.classList.remove('active'));

  drawerBackdrop.classList.remove('visible');
  setTimeout(() => {
    const anyOpen = document.querySelector('.drawer.drawer-open');
    if (!anyOpen) {
      drawerBackdrop.classList.add('hidden');
    }
  }, 350);
}

function switchTab(tab) {
  // tab-channels is now in a separate drawer, so we only hide it if we are switching
  // to another tab within THAT drawer (which there aren't any yet, but for consistency)
  if (tab === 'channels') {
    tabChannels.classList.remove('hidden');
  }

  // Settings drawer tabs
  if (tab === 'sources' || tab === 'browse') {
    tabSources.classList.toggle('hidden', tab !== 'sources');
    tabBrowse.classList.toggle('hidden', tab !== 'browse');
  }

  // Browse header visibility in settings drawer
  if (browseHeader) {
    browseHeader.classList.toggle('hidden', tab !== 'browse');
    document.querySelector('#settings-drawer .drawer-header h3').classList.toggle('hidden', tab === 'browse');
  }
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
  closeAllDrawers();
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
