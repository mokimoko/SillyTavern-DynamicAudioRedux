/*
 * src/audioModal.js — unified tabbed audio modal.
 *
 * The single user-facing UI for the extension: a tabbed modal with a live
 * now-playing strip across the top and four tabs (Playback, Library,
 * Playlists, Preferences).
 *
 * Now-playing strip:
 *   - Title/progress/time driven by the <audio> element + playbackState
 *   - Transport buttons wired to player.js functions
 *   - Reacts to audioEvents 'nowPlayingChanged'
 *   - Click-to-seek on the progress bar
 *   - Play/pause icon auto-syncs via audio 'play'/'pause' events
 *
 * Playback tab:
 *   - Mode select (instrumental/songs/playlist) + reselect-on-change
 *   - Auto-switch on emotion toggle
 *   - Include global toggle (rebinds to mode-specific setting; disabled in playlist mode)
 *   - Shuffle, cooldown, emotion-filter (populated from EMOTION_TAGS)
 *
 * Library tab:
 *   - Search input (filename + tags)
 *   - Filter row: source group (all/global/character, radio) + status group (instrumental/tagged/untagged, toggleable)
 *   - Scan + Auto-Tag buttons
 *   - Track row rendering with equalizer animation on currently-playing row
 *   - Reacts to 'tracksScanned', 'trackListChanged', 'nowPlayingChanged'
 *   - Tab meta "X tracks · Y tagged" updates live
 *   - Edit button opens the trackList.js track editor modal
 *
 * Mount strategy: lazy. DOM built on first openAudioModal(), cached for
 * re-opens. Mounted on document.body. Esc / backdrop / close button close.
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import {
    debugLog,
    playbackState,
    trackLibrary,
    audioEvents,
    EMOTION_TAGS,
    isQueueActive,
} from './state.js';
import {
    onPreviousTrack,
    onSkipTrack,
    playTrack,
    selectTrack,
    formatTime,
    filterTracksByTags,
    addToQueue,
    removeFromQueue,
    clearQueue,
    playQueueTrack,
} from './player.js';
import { scanTracks, saveMetadata } from './scanner.js';
import { openTrackEditor, migrateMetadata } from './trackList.js';
import {
    updateMiniplayerVisibility,
    updateMiniplayerPosition,
    updateMiniplayerContent,
} from './miniplayer.js';
import {
    createSmartPlaylist,
    createManualPlaylist,
    editPlaylist,
    updatePlaylistDropdown,
} from './playlists.js';
import { darToast, darConfirm, showVolumePopup, hideVolumePopup } from './ui.js';
import { openAutoTagModal, autoTagSingle } from './autoTag.js';
import { openFolderImportModal } from './folderImport.js';
import { openFolderUploadModal, openBgmUploadModal, isAudioUploadAvailable, isBgmUploadAvailable } from './folderUpload.js';
import { openPlaylistFromChatModal } from './playlistFromChat.js';
import { makeModalDraggable } from './draggableModal.js';

const MODAL_ID = 'dar-audio-modal-backdrop';
const VALID_TABS = ['nowplaying', 'playback', 'library', 'playlists', 'preferences'];
const DEFAULT_TAB = 'nowplaying';

let modalRoot = null;      // the .dar-modal-backdrop element (full overlay)
let modalShell = null;     // the inner .dar-modal element
let draggableModal = null;
let activeTab = DEFAULT_TAB;

function buildModal() {
    const html = `
        <div class="dar-modal-backdrop" id="${MODAL_ID}" style="display: none;">
            <div class="dar-modal" role="dialog" aria-modal="true" aria-label="Dynamic Audio">
                <!-- Now-playing strip (placeholder content; wired in a later step) -->
                <div class="dar-now-playing">
                    <div class="dar-np-info">
                        <div class="dar-np-title" data-dar="np-title">No track playing</div>
                        <div class="dar-np-scrubber">
                            <span data-dar="np-time-current">0:00</span>
                            <div class="dar-np-progress" data-dar="np-progress">
                                <div class="dar-np-progress-fill" data-dar="np-progress-fill"></div>
                            </div>
                            <span data-dar="np-time-total">0:00</span>
                        </div>
                    </div>
                    <div class="dar-np-controls">
                        <button class="dar-icon-btn" data-dar="np-prev"      title="Previous"  type="button"><i class="fa-solid fa-backward-step"></i></button>
                        <button class="dar-icon-btn" data-dar="np-playpause" title="Play/Pause" type="button"><i class="fa-solid fa-play"></i></button>
                        <button class="dar-icon-btn" data-dar="np-skip"      title="Skip"      type="button"><i class="fa-solid fa-forward-step"></i></button>
                        <button class="dar-icon-btn" data-dar="np-loop"      title="Loop"      type="button"><i class="fa-solid fa-repeat"></i></button>
                        <button class="dar-icon-btn" data-dar="np-volume"    title="Mute/Unmute" type="button"><i class="fa-solid fa-volume-high"></i></button>
                    </div>
                    <button class="dar-icon-btn dar-modal-close" data-dar="modal-close" title="Close" type="button"><i class="fa-solid fa-xmark"></i></button>
                </div>

                <!-- Tabs -->
                <div class="dar-tabs">
                    <button class="dar-tab" data-tab="nowplaying"  type="button">Now Playing</button>
                    <button class="dar-tab" data-tab="playback"    type="button">Playback</button>
                    <button class="dar-tab" data-tab="library"     type="button">Library</button>
                    <button class="dar-tab" data-tab="playlists"   type="button">Playlists</button>
                    <button class="dar-tab" data-tab="preferences" type="button">Preferences</button>
                    <div class="dar-tabs-spacer"></div>
                    <div class="dar-tab-meta" data-dar="tab-meta">— tracks</div>
                </div>

                <!-- Tab content (placeholders; populated in later steps) -->
                <div class="dar-tab-content">
                    <div class="dar-tab-panel" data-panel="nowplaying">
                        <div class="dar-npt-header" data-dar="npt-header"></div>
                        <div class="dar-npt-list" data-dar="npt-list"></div>
                    </div>
                    <div class="dar-tab-panel" data-panel="playback">
                        <div class="dar-section">
                            <div class="dar-section-title">Mode</div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Playback Mode</div>
                                    <div class="dar-field-hint">How tracks are selected and played</div>
                                </div>
                                <select class="dar-select-field" data-dar="pb-mode">
                                    <option value="instrumental">Instrumental</option>
                                    <option value="songs">Songs</option>
                                    <option value="playlist">Playlist</option>
                                </select>
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Auto-switch on emotion</div>
                                    <div class="dar-field-hint">Change track when chat emotion shifts</div>
                                </div>
                                <div class="dar-toggle" data-dar="pb-emotion-detection" role="switch" tabindex="0"></div>
                            </div>
                            <div class="dar-field" data-dar="pb-include-global-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Include global tracks</div>
                                    <div class="dar-field-hint" data-dar="pb-include-global-hint">Mix global with character-specific</div>
                                </div>
                                <div class="dar-toggle" data-dar="pb-include-global" role="switch" tabindex="0"></div>
                            </div>
                        </div>

                        <div class="dar-section">
                            <div class="dar-section-title">Behavior</div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Shuffle</div>
                                    <div class="dar-field-hint">Randomize track order</div>
                                </div>
                                <div class="dar-toggle" data-dar="pb-shuffle" role="switch" tabindex="0"></div>
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Cooldown</div>
                                    <div class="dar-field-hint">Min seconds before auto-switching again</div>
                                </div>
                                <input class="dar-number-field" type="number" min="0" max="3600" data-dar="pb-cooldown">
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Emotion filter</div>
                                    <div class="dar-field-hint">Restrict songs mode to one emotion</div>
                                </div>
                                <select class="dar-select-field" data-dar="pb-emotion-filter">
                                    <option value="all">All Emotions</option>
                                    <!-- emotion options inserted at build time from EMOTION_TAGS -->
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="dar-tab-panel" data-panel="library">
                        <div class="dar-lib-toolbar">
                            <div class="dar-search">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="text" data-dar="lib-search" placeholder="Search tracks by name or tag...">
                            </div>
                            <button class="dar-text-btn" data-dar="lib-scan" type="button"><i class="fa-solid fa-arrows-rotate"></i> Scan</button>
                            <button class="dar-text-btn" data-dar="lib-bgm-upload" type="button" hidden><i class="fa-solid fa-upload"></i> Upload</button>
                            <button class="dar-text-btn" data-dar="lib-autotag" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Tag</button>
                            <button class="dar-text-btn" data-dar="lib-add-folder" type="button"><i class="fa-solid fa-folder-plus"></i> Add Folder</button>
                            <button class="dar-text-btn" data-dar="lib-upload" type="button" hidden><i class="fa-solid fa-upload"></i> Upload to Folder</button>
                        </div>
                        <div class="dar-filter-row" data-dar="lib-filters">
                            <button class="dar-filter active" data-source="all"     type="button">All</button>
                            <button class="dar-filter"        data-source="global"  type="button">Global</button>
                            <button class="dar-filter"        data-source="character" type="button">Character</button>
                            <button class="dar-filter"        data-source="imported"  type="button">Imported</button>
                            <div class="dar-filter-divider"></div>
                            <button class="dar-filter" data-status="instrumental" type="button">Instrumental</button>
                            <button class="dar-filter" data-status="tagged"       type="button">Tagged</button>
                            <button class="dar-filter" data-status="untagged"     type="button">Untagged</button>
                        </div>
                        <div class="dar-bulk-bar" data-dar="lib-bulk-bar" hidden>
                            <span class="dar-bulk-count" data-dar="lib-bulk-count">0 selected</span>
                            <button class="dar-bulk-btn" data-dar="lib-bulk-selectall" type="button"><i class="fa-solid fa-list-check"></i> Select visible</button>
                            <button class="dar-bulk-btn" data-dar="lib-bulk-tag" type="button"><i class="fa-solid fa-tags"></i> Add tags</button>
                            <button class="dar-bulk-btn" data-dar="lib-bulk-queue" type="button"><i class="fa-solid fa-play"></i> Queue</button>
                            <button class="dar-bulk-btn dar-bulk-btn--ghost" data-dar="lib-bulk-clear" type="button"><i class="fa-solid fa-xmark"></i> Clear</button>
                        </div>
                        <div class="dar-track-list" data-dar="lib-list">
                            <!-- rendered by renderLibrary() -->
                        </div>
                    </div>
                    <div class="dar-tab-panel" data-panel="playlists">
                        <div class="dar-lib-toolbar">
                            <div class="dar-search">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="text" data-dar="pl-search" placeholder="Search playlists...">
                            </div>
                            <button class="dar-text-btn" data-dar="pl-new-smart" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> New Smart</button>
                            <button class="dar-text-btn" data-dar="pl-new-manual" type="button"><i class="fa-solid fa-list"></i> New Manual</button>
                            <button class="dar-text-btn" data-dar="pl-from-chat" type="button"><i class="fa-solid fa-wand-magic-sparkles"></i> From Chat</button>
                        </div>
                        <div class="dar-playlist-grid" data-dar="pl-grid">
                            <!-- rendered by renderPlaylists() -->
                        </div>
                    </div>
                    <div class="dar-tab-panel" data-panel="preferences">
                        <div class="dar-section">
                            <div class="dar-section-title">Miniplayer</div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Enable Miniplayer</div>
                                    <div class="dar-field-hint">Show the floating player widget</div>
                                </div>
                                <div class="dar-toggle" data-dar="prefs-mp-enabled" role="switch" tabindex="0"></div>
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Reset position</div>
                                    <div class="dar-field-hint">Move miniplayer back to default location</div>
                                </div>
                                <button class="dar-text-btn" data-dar="prefs-mp-reset" type="button"><i class="fa-solid fa-arrow-rotate-left"></i> Reset</button>
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Snap to edges</div>
                                    <div class="dar-field-hint">Magnetic snap when dragging near edges</div>
                                </div>
                                <div class="dar-toggle" data-dar="prefs-mp-snap" role="switch" tabindex="0"></div>
                            </div>
                        </div>

                        <div class="dar-section">
                            <div class="dar-section-title">Advanced</div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Debug mode</div>
                                    <div class="dar-field-hint">Verbose logging in browser console</div>
                                </div>
                                <div class="dar-toggle" data-dar="prefs-debug" role="switch" tabindex="0"></div>
                            </div>
                            <div class="dar-field">
                                <div class="dar-field-label">
                                    <div class="dar-field-name">Migrate metadata</div>
                                    <div class="dar-field-hint">Rebuild metadata index after file renames</div>
                                </div>
                                <button class="dar-text-btn" data-dar="prefs-migrate" type="button"><i class="fa-solid fa-database"></i> Run</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Mount on body and cache references
    const $root = $(html);
    $('body').append($root);
    modalRoot = $root[0];
    modalShell = modalRoot.querySelector('.dar-modal');
    draggableModal = makeModalDraggable(modalShell, modalShell.querySelector('.dar-now-playing'), {
        prefix: 'dar-modal',
        draggingClass: 'dar-modal-dragging',
        ignoreSelector: '.dar-np-progress',
    });

    // Default active tab
    switchTab(DEFAULT_TAB);

    // Tab switching (event-delegated on the backdrop for resilience)
    $root.on('click', '.dar-tab', (e) => {
        const tab = e.currentTarget.dataset.tab;
        if (tab) switchTab(tab);
    });

    // Close button
    $root.find('[data-dar="modal-close"]').on('click', closeAudioModal);

    // Backdrop click closes (but not clicks inside the modal shell)
    $root.on('click', (e) => {
        if (e.target === modalRoot) closeAudioModal();
    });

    // Esc key closes when visible. Registered once, persists for the
    // session; cheap because it short-circuits when the modal is hidden.
    $(document).on('keydown.dar-audio-modal', (e) => {
        if (e.key === 'Escape' && modalRoot && modalRoot.style.display !== 'none') {
            closeAudioModal();
        }
    });

    debugLog('Audio modal built and attached to body');

    // Wire each section to live data + events
    wireNowPlaying();
    wireNowPlayingTab();
    wirePlaybackTab();
    wireLibraryTab();
    wirePlaylistsTab();
    wirePreferencesTab();
}

// ----------------------------------------------------------------------
// Now-Playing Strip
// ----------------------------------------------------------------------

// Cached DOM refs (set once in wireNowPlaying, used by update helpers)
let $npTitle = null;
let $npTimeCurrent = null;
let $npTimeTotal = null;
let $npProgressFill = null;
let $npProgress = null;
let $npPlayPauseIcon = null;
let $npLoopBtn = null;
let $npVolumeBtn = null;
let $npVolumeIcon = null;

/**
 * Wire the now-playing strip: transport buttons, progress scrubber,
 * audio element listeners, and audioEvents subscription.
 * Called once at the end of buildModal().
 */
function wireNowPlaying() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);

    // Cache element refs
    $npTitle        = q('np-title');
    $npTimeCurrent  = q('np-time-current');
    $npTimeTotal    = q('np-time-total');
    $npProgressFill = q('np-progress-fill');
    $npProgress     = q('np-progress');
    $npPlayPauseIcon = q('np-playpause')?.querySelector('i');
    $npLoopBtn      = q('np-loop');
    $npVolumeBtn    = q('np-volume');
    $npVolumeIcon   = $npVolumeBtn?.querySelector('i');

    // ---- Transport buttons ----
    $(q('np-prev')).on('click', () => {
        onPreviousTrack();
    });

    $(q('np-playpause')).on('click', () => {
        const audio = $('#audio_bgm')[0];
        if (!audio) return;
        if (!playbackState.currentTrack) {
            // Nothing loaded — pick a track and play it
            const track = selectTrack();
            if (track) playTrack(track);
            return;
        }
        if (audio.paused) {
            audio.play().catch(() => {});
        } else {
            audio.pause();
        }
    });

    $(q('np-skip')).on('click', () => {
        onSkipTrack();
    });

    $(q('np-loop')).on('click', () => {
        extension_settings.audio.loop_single = !extension_settings.audio.loop_single;
        const audio = $('#audio_bgm')[0];
        if (audio) audio.loop = extension_settings.audio.loop_single;
        syncLoopButton();
        saveSettingsDebounced();
        debugLog(`Loop toggled: ${extension_settings.audio.loop_single}`);
    });

    $(q('np-volume')).on('click', () => {
        const muted = !extension_settings.audio.bgm_muted;
        extension_settings.audio.bgm_muted = muted;
        const audioEl = $('#audio_bgm')[0];
        if (audioEl) audioEl.muted = muted;
        syncVolumeIcon();
        // Keep miniplayer in sync too
        updateMiniplayerContent();
        saveSettingsDebounced();
    });

    // Volume popup on hover (vertical slider below the button — the strip
    // is at the top of the modal so we force downward placement).
    const volumeBtn = q('np-volume');
    if (volumeBtn) {
        volumeBtn.addEventListener('mouseenter', () => {
            showVolumePopup(volumeBtn, {
                value: extension_settings.audio.bgm_volume ?? 50,
                onChange: onModalVolumeSliderChange,
                preferBelow: true,
            });
        });
        volumeBtn.addEventListener('mouseleave', () => {
            hideVolumePopup();
        });
    }

    // ---- Audio element listeners ----
    const audio = $('#audio_bgm')[0];
    if (audio) {
        // Progress + time updates (~4×/sec via timeupdate, browser-native)
        audio.addEventListener('timeupdate', onTimeUpdate);
        // Sync play/pause icon whenever playback state changes
        audio.addEventListener('play',  syncPlayPauseIcon);
        audio.addEventListener('pause', syncPlayPauseIcon);
        // When a track ends naturally (non-loop), auto-advance
        // (This mirrors existing behavior but ensures the modal strip updates)
        audio.addEventListener('ended', () => {
            syncPlayPauseIcon();
        });
        // Sync volume icon when muted state changes (e.g. from miniplayer)
        audio.addEventListener('volumechange', syncVolumeIcon);
    }

    // ---- Click-to-seek on progress bar ----
    if ($npProgress) {
        $npProgress.addEventListener('click', (e) => {
            const audio = $('#audio_bgm')[0];
            if (!audio || !audio.duration) return;
            const rect = $npProgress.getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            audio.currentTime = pct * audio.duration;
        });
    }

    // ---- Event bus: react to track changes ----
    audioEvents.addEventListener('nowPlayingChanged', () => {
        refreshNowPlaying();
    });

    // Initial sync (in case a track is already playing when modal first opens)
    refreshNowPlaying();
    syncPlayPauseIcon();
    syncLoopButton();
    syncVolumeIcon();
}

/**
 * Refresh the title display from current playbackState.
 */
function refreshNowPlaying() {
    if (!$npTitle) return;

    if (!playbackState.currentTrack) {
        $npTitle.textContent = 'No track playing';
        return;
    }
    const meta = trackLibrary.metadata[playbackState.currentTrack] || {};
    const filename = playbackState.currentTrack.split('/').pop()
        .replace(/\.[^.]+$/, '');  // strip extension for display
    $npTitle.textContent = meta.title || decodeURIComponent(filename);
}

/**
 * Called on audio timeupdate — drives progress fill + time labels.
 */
function onTimeUpdate() {
    const audio = $('#audio_bgm')[0];
    if (!audio || !audio.duration || !isFinite(audio.duration)) return;

    const pct = (audio.currentTime / audio.duration) * 100;
    if ($npProgressFill) $npProgressFill.style.width = `${pct}%`;
    if ($npTimeCurrent)  $npTimeCurrent.textContent = formatTime(audio.currentTime);
    if ($npTimeTotal)    $npTimeTotal.textContent = formatTime(audio.duration);
}

/**
 * Swap the play/pause button icon to match audio state.
 */
function syncPlayPauseIcon() {
    if (!$npPlayPauseIcon) return;
    const audio = $('#audio_bgm')[0];
    const paused = !audio || audio.paused;
    $npPlayPauseIcon.className = paused
        ? 'fa-solid fa-play'
        : 'fa-solid fa-pause';
}

/**
 * Highlight the loop button when loop_single is active.
 */
function syncLoopButton() {
    if (!$npLoopBtn) return;
    $npLoopBtn.classList.toggle('active', !!extension_settings.audio.loop_single);
}

/**
 * Sync the volume/mute button icon to match current mute + volume state.
 * Mirrors the icon logic in miniplayer.js applyVolumeIcon().
 */
function syncVolumeIcon() {
    if (!$npVolumeIcon) return;
    const volume = extension_settings.audio.bgm_volume;
    let icon;
    if (extension_settings.audio.bgm_muted || volume === 0) {
        icon = 'fa-volume-mute';
    } else if (volume < 50) {
        icon = 'fa-volume-low';
    } else {
        icon = 'fa-volume-high';
    }
    $npVolumeIcon.classList.remove('fa-volume-high', 'fa-volume-low', 'fa-volume-mute');
    $npVolumeIcon.classList.add(icon);
    // Toggle active class so the button highlights when muted (visual cue)
    if ($npVolumeBtn) $npVolumeBtn.classList.toggle('active', !!extension_settings.audio.bgm_muted);
}

/**
 * Callback for the shared volume popup slider (modal side). Updates the
 * volume setting + audio element, auto-unmutes on non-zero drag, syncs
 * icons in both the modal and the miniplayer, and saves.
 */
function onModalVolumeSliderChange(vol) {
    extension_settings.audio.bgm_volume = vol;

    const audioEl = $('#audio_bgm')[0];
    if (audioEl) {
        audioEl.volume = vol / 100;
        // Auto-unmute when the user actively raises volume from the slider
        if (vol > 0 && extension_settings.audio.bgm_muted) {
            extension_settings.audio.bgm_muted = false;
            audioEl.muted = false;
        }
    }

    syncVolumeIcon();
    updateMiniplayerContent();
    saveSettingsDebounced();
}

// ----------------------------------------------------------------------
// Now Playing Tab
// ----------------------------------------------------------------------

let $nptHeader = null;
let $nptList = null;

/**
 * Wire the Now Playing tab — header actions, track row click handlers,
 * and reactive re-render on queue/playback/mode changes.
 * Called once at the end of buildModal().
 */
function wireNowPlayingTab() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);
    $nptHeader = q('npt-header');
    $nptList   = q('npt-list');

    // Header actions (clear queue button — rendered dynamically)
    $nptHeader.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-dar="npt-clear-queue"]');
        if (btn) {
            clearQueue();
            renderNowPlaying();
        }
    });

    // Track list — delegated handler for row clicks + remove button
    $nptList.addEventListener('click', (e) => {
        const row = e.target.closest('.dar-npt-row');
        if (!row) return;
        const index = parseInt(row.dataset.index, 10);
        const path = row.dataset.path;

        // Remove button (queue mode only)
        const removeBtn = e.target.closest('[data-action="npt-remove"]');
        if (removeBtn) {
            e.stopPropagation();
            removeFromQueue(index);
            renderNowPlaying();
            return;
        }

        // Default: click to play
        if (!path) return;
        ensureAudioEnabled();
        if (isQueueActive()) {
            playQueueTrack(index);
        } else {
            playTrack(path);
        }
    });

    // Reactive re-render
    audioEvents.addEventListener('queueChanged',      renderNowPlaying);
    audioEvents.addEventListener('nowPlayingChanged',  renderNowPlaying);
    audioEvents.addEventListener('modeChanged',        renderNowPlaying);
    audioEvents.addEventListener('playlistsChanged',   renderNowPlaying);
    audioEvents.addEventListener('tracksScanned',      renderNowPlaying);
    audioEvents.addEventListener('trackListChanged',   renderNowPlaying);  // tag/title edits

    renderNowPlaying();
}

/**
 * Resolve the current eligible track list mirroring selectTrack()'s logic
 * so the Now Playing tab shows exactly what the player considers eligible.
 * @returns {{ tracks: string[], label: string, isPlaylist: boolean, playlistName: string|null }}
 */
function resolveCurrentContext() {
    const mode = extension_settings.audio.mode;
    const context = getContext();
    const characterName = context.name2;

    if (mode === 'playlist') {
        const playlistName = extension_settings.audio.active_playlist;
        const playlist = extension_settings.audio.playlists?.[playlistName];
        if (!playlist) return { tracks: [], label: 'No playlist selected', isPlaylist: true, playlistName: null };

        let tracks;
        if (playlist.type === 'manual') {
            tracks = playlist.tracks || [];
        } else {
            const tags = [...(playlist.tags || [])];
            const includeGlobal = playlist.include_global !== false;
            if (playlist.emotion_mode === 'auto') tags.push(playbackState.currentEmotion);
            else if (playlist.emotion_mode === 'manual' && playlist.emotion_override) tags.push(playlist.emotion_override);
            try { tracks = filterTracksByTags(tags, characterName, includeGlobal); }
            catch { tracks = []; }
        }
        return { tracks, label: playlistName, isPlaylist: true, playlistName };
    }

    if (mode === 'instrumental') {
        const tags = ['instrumental'];
        const includeGlobal = extension_settings.audio.instrumental_include_global !== false;
        if (extension_settings.audio.emotion_detection) tags.push(playbackState.currentEmotion);
        let tracks = filterTracksByTags(tags, characterName, includeGlobal);
        if (tracks.length === 0) tracks = filterTracksByTags(['instrumental'], characterName, includeGlobal);

        const detail = extension_settings.audio.emotion_detection ? playbackState.currentEmotion : '';
        const label = detail ? `Instrumental · ${detail}` : 'Instrumental';
        return { tracks, label, isPlaylist: false, playlistName: null };
    }

    // songs mode
    const emotionFilter = extension_settings.audio.songs_emotion_filter;
    const includeGlobal = extension_settings.audio.songs_include_global !== false;
    let tracks;

    if (emotionFilter && emotionFilter !== 'all') {
        tracks = filterTracksByTags([emotionFilter], characterName, includeGlobal);
    } else {
        tracks = [];
        if (includeGlobal) {
            tracks = [...trackLibrary.global];
            if (characterName && trackLibrary.character[characterName]) {
                tracks = [...trackLibrary.character[characterName], ...tracks];
            }
        } else if (characterName && trackLibrary.character[characterName]) {
            tracks = [...trackLibrary.character[characterName]];
        }
        tracks = [...trackLibrary.imported, ...tracks];
    }

    const filterLabel = emotionFilter && emotionFilter !== 'all'
        ? emotionFilter.charAt(0).toUpperCase() + emotionFilter.slice(1)
        : 'All';
    return { tracks, label: `Songs · ${filterLabel}`, isPlaylist: false, playlistName: null };
}

/**
 * Render the Now Playing tab. Content adapts to the active context:
 *   - Queue active → queue tracks with position, remove buttons
 *   - Playlist mode → resolved playlist tracks
 *   - Songs/Instrumental → eligible track pool
 *   - Nothing → helpful empty state
 */
function renderNowPlaying() {
    if (!$nptHeader || !$nptList) return;

    const qActive = isQueueActive();
    let tracks, headerHtml, showRemove;

    if (qActive) {
        tracks = playbackState.playQueue;
        showRemove = true;
        headerHtml = `
            <div class="dar-npt-context">
                <i class="fa-solid fa-list-ol"></i>
                <span>Queue · ${tracks.length} track${tracks.length !== 1 ? 's' : ''}</span>
            </div>
            <button class="dar-text-btn" data-dar="npt-clear-queue" type="button"><i class="fa-solid fa-xmark"></i> Clear</button>
        `;
    } else {
        const ctx = resolveCurrentContext();
        tracks = ctx.tracks;
        showRemove = false;

        const icon = ctx.isPlaylist ? 'fa-record-vinyl' : 'fa-music';
        const countLabel = ctx.isPlaylist
            ? `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`
            : `${tracks.length} eligible`;
        const displayLabel = ctx.isPlaylist && ctx.playlistName
            ? escapeHtml(ctx.playlistName)
            : ctx.label;

        headerHtml = `
            <div class="dar-npt-context">
                <i class="fa-solid ${icon}"></i>
                <span>${displayLabel} · ${countLabel}</span>
            </div>
        `;
    }

    $nptHeader.innerHTML = headerHtml;

    // Empty state
    if (tracks.length === 0) {
        const hint = playbackState.currentTrack
            ? 'No tracks match the current mode or filter.'
            : 'Select tracks in the Library tab and click <strong>Queue</strong>, or start playback in any mode.';
        $nptList.innerHTML = `<div class="dar-placeholder">${hint}</div>`;
        return;
    }

    // Build track rows
    const rowsHtml = tracks.map((path, index) => {
        const meta = trackLibrary.metadata[path] || {};
        const filename = path.split('/').pop();
        const rawTitle = meta.title || decodeURIComponent(filename.replace(/\.[^.]+$/, ''));
        const isCurrent = playbackState.currentTrack === path;
        const isQueueCurrent = qActive && index === playbackState.queueIndex;
        const highlight = isCurrent || isQueueCurrent;

        const posHtml = highlight
            ? `<span class="dar-eq"><span></span><span></span><span></span><span></span></span>`
            : `<span class="dar-npt-pos-num">${index + 1}</span>`;

        // Source hint
        const isGlobal = (trackLibrary.global || []).includes(path);
        const isImported = (trackLibrary.imported || []).includes(path);
        let sourceHint = '';
        if (isGlobal) sourceHint = 'global';
        else if (isImported) sourceHint = 'imported';
        else {
            for (const [char, charTracks] of Object.entries(trackLibrary.character || {})) {
                if (charTracks.includes(path)) { sourceHint = char; break; }
            }
        }

        // Tag chips — show everything (instrumental + emotions + custom).
        // NP tab has no other tag context, so the full set is most useful.
        const tags = meta.tags || [];
        const tagsHtml = tags.length > 0
            ? `<div class="dar-npt-tags">${
                tags.map(t => `<span class="dar-tag">${escapeHtml(t)}</span>`).join('')
              }</div>`
            : '<div class="dar-npt-tags"></div>';

        const removeHtml = showRemove
            ? `<button class="dar-icon-btn" data-action="npt-remove" type="button" title="Remove"><i class="fa-solid fa-xmark"></i></button>`
            : '';

        const rowClass = highlight ? 'dar-npt-row current' : 'dar-npt-row';

        return `
            <div class="${rowClass}" data-path="${escapeHtml(path)}" data-index="${index}">
                <div class="dar-npt-pos">${posHtml}</div>
                <div class="dar-npt-info">
                    <div class="dar-npt-title">${escapeHtml(rawTitle)}</div>
                    <div class="dar-npt-sub">${escapeHtml(sourceHint)}</div>
                </div>
                ${tagsHtml}
                <div class="dar-npt-actions">${removeHtml}</div>
            </div>
        `;
    }).join('');

    $nptList.innerHTML = rowsHtml;

    // Scroll current track into view (smooth, non-disruptive)
    requestAnimationFrame(() => {
        const currentRow = $nptList.querySelector('.dar-npt-row.current');
        if (currentRow) currentRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
}

// ----------------------------------------------------------------------
// Playback Tab
// ----------------------------------------------------------------------

// Cached refs
let $pbMode = null;
let $pbEmotionDetection = null;
let $pbIncludeGlobalField = null;
let $pbIncludeGlobal = null;
let $pbIncludeGlobalHint = null;
let $pbShuffle = null;
let $pbCooldown = null;
let $pbEmotionFilter = null;

/**
 * Wire the Playback tab — populates emotion options, caches refs,
 * binds change handlers (mode/emotion-detection/shuffle/cooldown/etc.),
 * and syncs UI to current settings.
 * Called once at the end of buildModal().
 */
function wirePlaybackTab() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);

    // Cache refs
    $pbMode               = q('pb-mode');
    $pbEmotionDetection   = q('pb-emotion-detection');
    $pbIncludeGlobalField = q('pb-include-global-field');
    $pbIncludeGlobal      = q('pb-include-global');
    $pbIncludeGlobalHint  = q('pb-include-global-hint');
    $pbShuffle            = q('pb-shuffle');
    $pbCooldown           = q('pb-cooldown');
    $pbEmotionFilter      = q('pb-emotion-filter');

    // Populate emotion filter from EMOTION_TAGS (after the "All Emotions" option)
    const optionsHtml = EMOTION_TAGS.map(tag =>
        `<option value="${tag}">${tag.charAt(0).toUpperCase() + tag.slice(1)}</option>`
    ).join('');
    $pbEmotionFilter.insertAdjacentHTML('beforeend', optionsHtml);

    // ---- Event wiring ----

    // Mode select — change setting, update UI, dispatch event, reselect track
    $pbMode.addEventListener('change', () => {
        const newMode = $pbMode.value;
        extension_settings.audio.mode = newMode;
        // Re-render include-global toggle (rebinds to mode-specific setting)
        syncIncludeGlobalToggle();
        // Cross-module notification
        audioEvents.dispatchEvent(new CustomEvent('modeChanged', { detail: { mode: newMode } }));
        // Reselect immediately if playing
        if (extension_settings.audio.enabled) {
            const track = selectTrack();
            if (track) playTrack(track);
        }
        saveSettingsDebounced();
    });

    // Auto-switch on emotion (toggle)
    $pbEmotionDetection.addEventListener('click', () => {
        const newVal = !extension_settings.audio.emotion_detection;
        extension_settings.audio.emotion_detection = newVal;
        $pbEmotionDetection.classList.toggle('on', newVal);
        saveSettingsDebounced();
    });

    // Include global tracks (toggle, mode-aware)
    $pbIncludeGlobal.addEventListener('click', () => {
        const mode = extension_settings.audio.mode;
        if (mode === 'playlist') return;  // No-op in playlist mode (per-playlist setting)

        const settingKey = mode === 'songs' ? 'songs_include_global' : 'instrumental_include_global';
        const newVal = extension_settings.audio[settingKey] === false;
        extension_settings.audio[settingKey] = newVal;
        $pbIncludeGlobal.classList.toggle('on', newVal);
        // Reselect if playing in matching mode
        if (extension_settings.audio.enabled) {
            const track = selectTrack();
            if (track) playTrack(track);
        }
        saveSettingsDebounced();
    });

    // Shuffle (toggle)
    $pbShuffle.addEventListener('click', () => {
        const newVal = !extension_settings.audio.shuffle;
        extension_settings.audio.shuffle = newVal;
        $pbShuffle.classList.toggle('on', newVal);
        saveSettingsDebounced();
    });

    // Cooldown (number)
    $pbCooldown.addEventListener('input', () => {
        const v = parseInt($pbCooldown.value, 10);
        extension_settings.audio.cooldown = isFinite(v) && v >= 0 ? v : 0;
        saveSettingsDebounced();
    });

    // Emotion filter (select)
    $pbEmotionFilter.addEventListener('change', () => {
        extension_settings.audio.songs_emotion_filter = $pbEmotionFilter.value;
        // Reselect if playing in songs mode
        if (extension_settings.audio.enabled && extension_settings.audio.mode === 'songs') {
            const track = selectTrack();
            if (track) playTrack(track);
        }
        saveSettingsDebounced();
    });

    // Initial sync from settings
    refreshPlaybackTab();
}

/**
 * Sync all Playback tab controls to current extension_settings.audio values.
 * Called on build + every openAudioModal() so changes made via slash
 * commands or other code paths are reflected when the modal next opens.
 */
function refreshPlaybackTab() {
    if (!$pbMode) return;
    const s = extension_settings.audio || {};

    $pbMode.value = s.mode || 'instrumental';
    $pbEmotionDetection.classList.toggle('on', !!s.emotion_detection);
    $pbShuffle.classList.toggle('on', !!s.shuffle);
    $pbCooldown.value = s.cooldown ?? 30;
    $pbEmotionFilter.value = s.songs_emotion_filter || 'all';

    syncIncludeGlobalToggle();
}

/**
 * Rebind the "Include global tracks" toggle to the relevant setting for
 * the current mode. In playlist mode, disable + show explanatory hint.
 */
function syncIncludeGlobalToggle() {
    if (!$pbIncludeGlobal) return;
    const mode = extension_settings.audio.mode || 'instrumental';

    if (mode === 'playlist') {
        $pbIncludeGlobalField.classList.add('dar-field-disabled');
        $pbIncludeGlobal.style.opacity = '0.4';
        $pbIncludeGlobal.style.pointerEvents = 'none';
        $pbIncludeGlobalHint.textContent = 'Set per-playlist in the Playlists tab';
        $pbIncludeGlobal.classList.remove('on');
        return;
    }

    $pbIncludeGlobalField.classList.remove('dar-field-disabled');
    $pbIncludeGlobal.style.opacity = '';
    $pbIncludeGlobal.style.pointerEvents = '';
    $pbIncludeGlobalHint.textContent = 'Mix global with character-specific';

    const settingKey = mode === 'songs' ? 'songs_include_global' : 'instrumental_include_global';
    // Default to true if unset (matches old defaults)
    const val = extension_settings.audio[settingKey] !== false;
    $pbIncludeGlobal.classList.toggle('on', val);
}

// ----------------------------------------------------------------------
// Library Tab
// ----------------------------------------------------------------------

// Cached refs
let $libSearch = null;
let $libList = null;
let $libFilters = null;
let $tabMeta = null;
let $libBulkBar = null;
let $libBulkCount = null;

// Filter state
let libSearchQuery = '';
let libSourceFilter = 'all';     // 'all' | 'global' | 'character'
let libStatusFilter = 'all';     // 'all' | 'instrumental' | 'tagged' | 'untagged'

// Snapshot of the currently-rendered (post-filter) order, used by shift-range
// selection so paths can be resolved from their numeric index in the list.
let libRenderedPaths = [];

/**
 * Wire the Library tab — search input, filter buttons, scan/auto-tag,
 * list event delegation, and reactive re-render on audioEvents.
 * Called once at the end of buildModal().
 */
function wireLibraryTab() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);

    $libSearch    = q('lib-search');
    $libList      = q('lib-list');
    $libFilters   = q('lib-filters');
    $tabMeta      = q('tab-meta');
    $libBulkBar   = q('lib-bulk-bar');
    $libBulkCount = q('lib-bulk-count');

    // Search input — re-render on every keystroke (small library so unbothered;
    // can debounce later if perf becomes an issue with thousands of tracks)
    $libSearch.addEventListener('input', () => {
        libSearchQuery = $libSearch.value.trim().toLowerCase();
        renderLibrary();
    });

    // Scan — kicks off rescan; renderLibrary fires via 'tracksScanned' below
    q('lib-scan').addEventListener('click', () => {
        scanTracks();  // async, but we don't need to await
    });

    // Upload (global) — opens the BGM upload modal. Hidden unless the Nebula
    // Loader plugin advertises the bgmUpload feature. Writes into assets/bgm/,
    // the same folder Scan reads, so uploads appear under the Global source.
    const $libBgmUpload = q('lib-bgm-upload');
    $libBgmUpload.addEventListener('click', () => {
        openBgmUploadModal();
    });
    isBgmUploadAvailable().then(available => {
        if (available) $libBgmUpload.hidden = false;
    }).catch(() => { /* stay hidden on probe failure */ });

    // Auto-Tag — opens the AutoTag modal (direct import from autoTag.js)
    q('lib-autotag').addEventListener('click', () => {
        openAutoTagModal();
    });

    // Add Folder — opens the folder import / management modal
    q('lib-add-folder').addEventListener('click', () => {
        openFolderImportModal();
    });

    // Upload — opens the upload modal. The button is hidden by default and only
    // revealed if the Nebula Loader plugin is installed and advertises the
    // audioUpload feature (probed once, asynchronously, below).
    const $libUpload = q('lib-upload');
    $libUpload.addEventListener('click', () => {
        openFolderUploadModal();
    });
    isAudioUploadAvailable().then(available => {
        if (available) $libUpload.hidden = false;
    }).catch(() => { /* stay hidden on probe failure */ });

    // Filter buttons — delegation handles both groups
    $libFilters.addEventListener('click', (e) => {
        const btn = e.target.closest('.dar-filter');
        if (!btn) return;

        if (btn.dataset.source) {
            // Source group: radio-style, always one active
            libSourceFilter = btn.dataset.source;
            $libFilters.querySelectorAll('[data-source]').forEach(b => {
                b.classList.toggle('active', b.dataset.source === libSourceFilter);
            });
        } else if (btn.dataset.status) {
            // Status group: click active button to clear; otherwise switch
            const status = btn.dataset.status;
            if (libStatusFilter === status) {
                libStatusFilter = 'all';
                btn.classList.remove('active');
            } else {
                libStatusFilter = status;
                $libFilters.querySelectorAll('[data-status]').forEach(b => {
                    b.classList.toggle('active', b.dataset.status === status);
                });
            }
        }
        renderLibrary();
    });

    // Bulk action bar buttons
    $libBulkBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.dar-bulk-btn');
        if (!btn) return;
        const which = btn.dataset.dar;
        if (which === 'lib-bulk-selectall') {
            // Add every currently-visible path to the selection
            libRenderedPaths.forEach(p => playbackState.selectedTracks.add(p));
            renderLibrary();
        } else if (which === 'lib-bulk-tag') {
            if (playbackState.selectedTracks.size === 0) return;
            openBulkTagEditor();
        } else if (which === 'lib-bulk-queue') {
            if (playbackState.selectedTracks.size === 0) return;
            const paths = Array.from(playbackState.selectedTracks);
            const shouldAutoPlay = addToQueue(paths);
            if (shouldAutoPlay) {
                ensureAudioEnabled();
                playTrack(playbackState.playQueue[0]);
            }
            playbackState.selectedTracks.clear();
            playbackState.lastSelectedIndex = -1;
            renderLibrary();
            switchTab('nowplaying');
            darToast.success(`Added ${paths.length} track${paths.length === 1 ? '' : 's'} to queue`);
        } else if (which === 'lib-bulk-clear') {
            playbackState.selectedTracks.clear();
            playbackState.lastSelectedIndex = -1;
            renderLibrary();
        }
    });

    // Track list — delegated handler for row clicks + action buttons + checkbox
    $libList.addEventListener('click', (e) => {
        const row = e.target.closest('.dar-track-row');
        if (!row) return;
        const path = row.dataset.path;
        if (!path) return;
        const index = parseInt(row.dataset.index, 10);

        // Checkbox click — toggle / shift-range select. Stop here so the row
        // doesn't also try to play the track.
        const check = e.target.closest('.dar-track-check');
        if (check) {
            e.stopPropagation();
            if (e.shiftKey && playbackState.lastSelectedIndex >= 0) {
                const start = Math.min(playbackState.lastSelectedIndex, index);
                const end   = Math.max(playbackState.lastSelectedIndex, index);
                for (let i = start; i <= end; i++) {
                    const p = libRenderedPaths[i];
                    if (p) playbackState.selectedTracks.add(p);
                }
            } else if (playbackState.selectedTracks.has(path)) {
                playbackState.selectedTracks.delete(path);
            } else {
                playbackState.selectedTracks.add(path);
                playbackState.lastSelectedIndex = index;
            }
            renderLibrary();
            return;
        }

        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
            e.stopPropagation();
            const action = actionBtn.dataset.action;
            if (action === 'play') {
                ensureAudioEnabled();
                playTrack(path);
            } else if (action === 'queue') {
                const shouldAutoPlay = addToQueue([path]);
                if (shouldAutoPlay) {
                    ensureAudioEnabled();
                    playTrack(playbackState.playQueue[0]);
                }
                darToast.success('Added to queue');
            } else if (action === 'autotag-single') {
                autoTagSingle(path);
            } else if (action === 'edit') {
                openTrackEditor(path);
            }
            return;
        }

        // Default row click — play the track
        ensureAudioEnabled();
        playTrack(path);
    });

    // Reactive re-render on library/playback changes
    audioEvents.addEventListener('tracksScanned',    renderLibrary);
    audioEvents.addEventListener('trackListChanged', renderLibrary);
    audioEvents.addEventListener('nowPlayingChanged', renderLibrary);

    // Initial render
    renderLibrary();
}

/**
 * Render the track list from trackLibrary, applying current filters/search.
 * Also updates the tab meta text ("X tracks · Y tagged").
 */
function renderLibrary() {
    if (!$libList) return;

    // Flatten character + global + imported tracks into one list with source metadata.
    // For imported tracks, the per-track `folder` field (set by registerImportedTracks)
    // distinguishes them. We thread it through to the row renderer so the folder badge
    // can be drawn alongside the source category.
    const allTracks = [];
    Object.entries(trackLibrary.character || {}).forEach(([char, tracks]) => {
        tracks.forEach(t => allTracks.push({ path: t, source: char, isGlobal: false, isImported: false, folder: null }));
    });
    (trackLibrary.global || []).forEach(t => {
        allTracks.push({ path: t, source: 'global', isGlobal: true, isImported: false, folder: null });
    });
    (trackLibrary.imported || []).forEach(t => {
        const folder = (trackLibrary.metadata[t] || {}).folder || '';
        allTracks.push({ path: t, source: folder, isGlobal: false, isImported: true, folder });
    });

    // Compute tab-meta counts before filtering (totals across whole library)
    const taggedCount = allTracks.reduce((n, { path }) => {
        const tags = (trackLibrary.metadata[path] || {}).tags || [];
        return tags.length > 0 ? n + 1 : n;
    }, 0);
    if ($tabMeta) {
        $tabMeta.textContent = allTracks.length === 0
            ? '— tracks'
            : `${allTracks.length} tracks · ${taggedCount} tagged`;
    }

    // Apply filters + search
    const sq = libSearchQuery;
    const filtered = allTracks.filter(({ path, isGlobal, isImported }) => {
        if (libSourceFilter === 'global'    && !isGlobal) return false;
        if (libSourceFilter === 'character' && (isGlobal || isImported)) return false;
        if (libSourceFilter === 'imported'  && !isImported) return false;

        const meta = trackLibrary.metadata[path] || {};
        const tags = meta.tags || [];

        if (libStatusFilter === 'instrumental' && !tags.includes('instrumental')) return false;
        if (libStatusFilter === 'tagged'       && tags.length === 0) return false;
        if (libStatusFilter === 'untagged'     && tags.length  >  0) return false;

        if (sq) {
            const filename = path.split('/').pop();
            const title    = (meta.title || filename).toLowerCase();
            const tagStr   = tags.join(' ').toLowerCase();
            if (!title.includes(sq) && !tagStr.includes(sq)) return false;
        }
        return true;
    });

    // Empty state
    if (filtered.length === 0) {
        const msg = allTracks.length === 0
            ? 'No tracks found. Click Scan to load music from /assets/bgm/ and /characters/&lt;name&gt;/bgm/.'
            : 'No tracks match your filters.';
        $libList.innerHTML = `<div class="dar-placeholder" style="padding: 24px; text-align: center;">${msg}</div>`;
        // Reset rendered-paths snapshot so shift-range doesn't index into stale data
        libRenderedPaths = [];
        updateBulkBar();
        return;
    }

    // Snapshot rendered-order paths for shift-range selection
    libRenderedPaths = filtered.map(t => t.path);

    // Build row HTML
    const rowsHtml = filtered.map(({ path, source, isGlobal, isImported, folder }, index) => {
        const meta = trackLibrary.metadata[path] || {};
        const filename = path.split('/').pop();
        const rawTitle = meta.title || decodeURIComponent(filename.replace(/\.[^.]+$/, ''));
        const tags = meta.tags || [];
        // Don't show 'instrumental' or emotion tags as chips — they're shown via status hints.
        // Just show "other" descriptive tags here.
        const displayTags = tags.filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));
        const isCurrent  = playbackState.currentTrack === path;
        const isUntagged = tags.length === 0;
        const isSelected = playbackState.selectedTracks.has(path);

        const iconHtml = isCurrent
            ? `<span class="dar-eq"><span></span><span></span><span></span><span></span></span>`
            : `<i class="fa-solid fa-music"></i>`;

        // Source line: untagged warning short-circuits the category label, but we still
        // tack on the folder pill for imported tracks so the user can see the folder name
        // even before the track is tagged. Otherwise show the category (global / character /
        // imported), with the folder badge to the right of the "imported" label.
        const folderLabel = (isImported && folder)
            ? folder + (meta.subfolder ? '/' + meta.subfolder : '')
            : '';
        const folderPill = folderLabel
            ? ` <span class="dar-folder-pill"><i class="fa-solid fa-folder"></i> ${escapeHtml(folderLabel)}</span>`
            : '';
        let subHtml;
        if (isUntagged) {
            subHtml = `<i class="fa-solid fa-circle-exclamation"></i> untagged${folderPill}`;
        } else if (isGlobal) {
            subHtml = `<i class="fa-solid fa-globe"></i> global`;
        } else if (isImported) {
            subHtml = `<i class="fa-solid fa-download"></i> imported${folderPill}`;
        } else {
            subHtml = `<i class="fa-solid fa-folder"></i> character/${escapeHtml(source)}`;
        }

        const tagsHtml = displayTags.length > 0
            ? displayTags.map(t => `<span class="dar-tag">${escapeHtml(t)}</span>`).join('')
            : `<span class="dar-tag empty">no tags</span>`;

        // Untagged rows expose a wand button for quick auto-tagging access
        const actionsHtml = isUntagged
            ? `<button class="dar-icon-btn" data-action="play"            type="button" title="Play"><i class="fa-solid fa-play"></i></button>
               <button class="dar-icon-btn" data-action="queue"           type="button" title="Add to queue"><i class="fa-solid fa-list-ol"></i></button>
               <button class="dar-icon-btn" data-action="autotag-single" type="button" title="Tag this track"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
               <button class="dar-icon-btn" data-action="edit"           type="button" title="Edit"><i class="fa-solid fa-pen"></i></button>`
            : `<button class="dar-icon-btn" data-action="play"  type="button" title="Play"><i class="fa-solid fa-play"></i></button>
               <button class="dar-icon-btn" data-action="queue" type="button" title="Add to queue"><i class="fa-solid fa-list-ol"></i></button>
               <button class="dar-icon-btn" data-action="edit"  type="button" title="Edit"><i class="fa-solid fa-pen"></i></button>`;

        const rowClasses = [
            'dar-track-row',
            isCurrent  ? 'current'  : '',
            isSelected ? 'selected' : '',
        ].filter(Boolean).join(' ');

        return `
            <div class="${rowClasses}" data-path="${escapeHtml(path)}" data-index="${index}">
                <span class="dar-track-check" role="checkbox" aria-checked="${isSelected}" tabindex="0">
                    <i class="fa-solid ${isSelected ? 'fa-square-check' : 'fa-square'}"></i>
                </span>
                <div class="dar-track-icon">${iconHtml}</div>
                <div class="dar-track-info">
                    <div class="dar-track-title">${escapeHtml(rawTitle)}</div>
                    <div class="dar-track-sub">${subHtml}</div>
                </div>
                <div class="dar-track-tags">${tagsHtml}</div>
                <div class="dar-track-actions">${actionsHtml}</div>
            </div>
        `;
    }).join('');

    $libList.innerHTML = rowsHtml;
    updateBulkBar();
}

/**
 * Show/hide the bulk action bar and update its count text. Selection state
 * itself is owned by `playbackState.selectedTracks` (Set<string>) and rendered
 * directly into each row by `renderLibrary()`.
 */
function updateBulkBar() {
    if (!$libBulkBar) return;
    const n = playbackState.selectedTracks.size;
    if (n === 0) {
        $libBulkBar.setAttribute('hidden', '');
    } else {
        $libBulkBar.removeAttribute('hidden');
        if ($libBulkCount) {
            $libBulkCount.textContent = `${n} selected`;
        }
    }
}

/**
 * Open the bulk tag editor for `playbackState.selectedTracks`. Tags are
 * ADDITIVE — checkboxes start checked for tags present on ALL selected
 * tracks; unchecking does NOT remove existing tags. (Mirrors the behavior
 * of the old trackList.js bulk tag editor, but rebuilt with the `dar-`
 * design system.)
 */
function openBulkTagEditor() {
    const paths = Array.from(playbackState.selectedTracks);
    if (paths.length === 0) return;

    // Determine tags common to ALL selected tracks
    const tagSets = paths.map(p => new Set((trackLibrary.metadata[p] || {}).tags || []));
    const commonTags = tagSets.length > 0
        ? [...tagSets[0]].filter(tag => tagSets.every(s => s.has(tag)))
        : [];
    const isInstrumentalCommon = commonTags.includes('instrumental');
    const otherCommonTags = commonTags.filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));

    // Emotion checkboxes — 3 per row, pre-checked if common
    const emotionCheckboxesHtml = EMOTION_TAGS.map(emotion => {
        const isCommon = commonTags.includes(emotion);
        return `
            <label class="dar-emotion-check">
                <input type="checkbox" value="${emotion}" ${isCommon ? 'checked' : ''}>
                <span>${emotion}</span>
            </label>
        `;
    }).join('');

    const backdrop = document.createElement('div');
    backdrop.className = 'dar-confirm-backdrop';
    backdrop.innerHTML = `
        <div class="dar-bulk-tag-modal" role="dialog" aria-label="Bulk add tags">
            <div class="dar-bulk-tag-header">
                <i class="fa-solid fa-tags"></i>
                <span>Add tags to ${paths.length} track${paths.length === 1 ? '' : 's'}</span>
            </div>

            <label class="dar-bulk-tag-row">
                <input type="checkbox" data-dar="bulk-instr" ${isInstrumentalCommon ? 'checked' : ''}>
                <span>Instrumental (no vocals)</span>
            </label>

            <div class="dar-bulk-tag-section">
                <button class="dar-bulk-tag-section-toggle" type="button" data-dar="bulk-toggle-emo">
                    <i class="fa-solid fa-chevron-right"></i>
                    <span>Emotions</span>
                </button>
                <div class="dar-bulk-emotion-grid" data-dar="bulk-emo-grid" hidden>
                    ${emotionCheckboxesHtml}
                </div>
            </div>

            <div class="dar-bulk-tag-section">
                <label class="dar-bulk-tag-label" for="dar-bulk-other-tags">Other tags (comma-separated)</label>
                <input type="text" class="dar-bulk-tag-input" id="dar-bulk-other-tags"
                    value="${escapeHtml(otherCommonTags.join(', '))}"
                    placeholder="action, ambient, battle...">
            </div>

            <div class="dar-bulk-tag-hint">
                <i class="fa-solid fa-info-circle"></i>
                Tags are <strong>added</strong> to existing tags. Pre-checked tags are already on all selected tracks. Unchecking won't remove them.
            </div>

            <div class="dar-bulk-tag-actions">
                <button class="dar-confirm-btn dar-confirm-btn--cancel" type="button" data-dar="bulk-cancel">Cancel</button>
                <button class="dar-confirm-btn dar-confirm-btn--confirm" type="button" data-dar="bulk-apply">
                    <i class="fa-solid fa-check"></i> Apply
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(backdrop);

    const q = (attr) => backdrop.querySelector(`[data-dar="${attr}"]`);

    // Toggle emotions section
    q('bulk-toggle-emo').addEventListener('click', () => {
        const grid = q('bulk-emo-grid');
        const icon = q('bulk-toggle-emo').querySelector('i');
        const isHidden = grid.hasAttribute('hidden');
        if (isHidden) {
            grid.removeAttribute('hidden');
            icon.classList.remove('fa-chevron-right');
            icon.classList.add('fa-chevron-down');
        } else {
            grid.setAttribute('hidden', '');
            icon.classList.remove('fa-chevron-down');
            icon.classList.add('fa-chevron-right');
        }
    });

    const close = () => backdrop.remove();

    q('bulk-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    q('bulk-apply').addEventListener('click', () => {
        const isInstr = q('bulk-instr').checked;
        const emotions = Array.from(
            backdrop.querySelectorAll('[data-dar="bulk-emo-grid"] input:checked')
        ).map(cb => cb.value);
        const otherTags = (document.getElementById('dar-bulk-other-tags').value || '')
            .split(',').map(t => t.trim()).filter(Boolean);

        const newTags = [];
        if (isInstr) newTags.push('instrumental');
        newTags.push(...emotions, ...otherTags);

        // Additive merge into each selected track's metadata
        paths.forEach(path => {
            const meta = trackLibrary.metadata[path] || { tags: [], title: '' };
            const merged = new Set(meta.tags || []);
            newTags.forEach(t => merged.add(t));
            trackLibrary.metadata[path] = { ...meta, tags: Array.from(merged) };
        });

        saveMetadata();  // fires 'trackListChanged' → renderLibrary
        playbackState.selectedTracks.clear();
        playbackState.lastSelectedIndex = -1;
        renderLibrary();
        close();
        darToast.success(`Tagged ${paths.length} track${paths.length === 1 ? '' : 's'}`);
    });
}

/**
 * Enable audio playback if not already enabled. Used when the user clicks
 * a track row to play — mirrors the behavior of the old trackList.js.
 */
function ensureAudioEnabled() {
    if (extension_settings.audio.enabled) return;
    extension_settings.audio.enabled = true;
    saveSettingsDebounced();
}

/**
 * Minimal HTML escaper for user-supplied strings (track titles, tags, source names).
 * Defends against malformed/injected metadata; not strictly necessary for local
 * files, but cheap insurance.
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ----------------------------------------------------------------------
// Playlists Tab
// ----------------------------------------------------------------------

let $plSearch = null;
let $plGrid = null;
let $plFromChat = null;
let plSearchQuery = '';

/**
 * Wire up the Playlists tab: search, From Chat launcher, card click handlers,
 * and the "+ New" cards. Subscribes to 'playlistsChanged' for auto-refresh
 * after any mutation (create/edit/delete via existing playlists.js modals,
 * or from playlistFromChat / slash commands).
 *
 * Called once at the end of buildModal().
 */
function wirePlaylistsTab() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);

    $plSearch = q('pl-search');
    $plGrid = q('pl-grid');
    $plFromChat = q('pl-from-chat');

    // Live filter on every keystroke
    $plSearch.addEventListener('input', () => {
        plSearchQuery = $plSearch.value.trim().toLowerCase();
        renderPlaylists();
    });

    // "New Smart" + "New Manual" toolbar buttons
    q('pl-new-smart')?.addEventListener('click', () => {
        createSmartPlaylist();
    });

    q('pl-new-manual')?.addEventListener('click', () => {
        createManualPlaylist();
    });

    // "From Chat" → launch the AI playlist-from-chat modal (direct import)
    $plFromChat.addEventListener('click', () => {
        openPlaylistFromChatModal();
    });

    // Delegated click handler for cards + actions
    $plGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.dar-playlist-card');
        if (!card) return;

        const name = card.dataset.name;
        if (!name) return;

        // Action buttons (edit / delete) inside the card
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
            e.stopPropagation();
            const action = actionBtn.dataset.action;
            if (action === 'edit') {
                editPlaylist(name);
            } else if (action === 'delete') {
                darConfirm(`Delete playlist "${name}"?`, {
                    confirmText: 'Delete',
                    danger: true,
                }).then((ok) => {
                    if (!ok) return;
                    delete extension_settings.audio.playlists[name];
                    if (extension_settings.audio.active_playlist === name) {
                        extension_settings.audio.active_playlist = null;
                    }
                    saveSettingsDebounced();
                    // updatePlaylistDropdown dispatches 'playlistsChanged',
                    // which triggers the grid re-render.
                    updatePlaylistDropdown();
                    darToast.success(`Deleted playlist "${name}"`);
                });
            }
            return;
        }

        // Default card click: toggle active playlist
        const isActive = extension_settings.audio.active_playlist === name;
        extension_settings.audio.active_playlist = isActive ? null : name;

        saveSettingsDebounced();

        // If in playlist mode and audio enabled, immediately play from new active playlist
        if (
            !isActive &&
            extension_settings.audio.enabled &&
            extension_settings.audio.mode === 'playlist'
        ) {
            const track = selectTrack();
            if (track) playTrack(track);
        }

        renderPlaylists();
    });

    // Re-render whenever playlists mutate (create / edit / delete / from-chat / slash)
    audioEvents.addEventListener('playlistsChanged', () => {
        renderPlaylists();
    });

    // Initial render
    renderPlaylists();
}

/**
 * Render the playlist grid based on current playlists + search query.
 * Active playlist gets the `.active` class. Each existing playlist card
 * shows name + type/count line + edit/delete action buttons (visible on hover).
 * Cards with a cover image use it as a CSS background.
 */
function renderPlaylists() {
    if (!$plGrid) return;

    const playlists = extension_settings.audio.playlists || {};
    const activeName = extension_settings.audio.active_playlist || null;
    const names = Object.keys(playlists);

    // Apply search filter
    const filtered = plSearchQuery
        ? names.filter(n => n.toLowerCase().includes(plSearchQuery))
        : names;

    const cardsHtml = filtered.map(name => {
        const pl = playlists[name];
        const isSmart = pl.type === 'smart';

        // Compute track count
        let count;
        if (isSmart) {
            let tags = [...(pl.tags || [])];
            if (pl.emotion_mode === 'auto') {
                tags.push(playbackState.currentEmotion);
            } else if (pl.emotion_mode === 'manual' && pl.emotion_override) {
                tags.push(pl.emotion_override);
            }
            const includeGlobal = pl.include_global !== false;
            try {
                count = filterTracksByTags(tags, null, includeGlobal).length;
            } catch (err) {
                count = 0;
            }
        } else {
            count = (pl.tracks || []).length;
        }

        const typeIcon = isSmart ? 'fa-wand-magic-sparkles' : 'fa-list';
        const typeLabel = isSmart ? 'Smart' : 'Manual';
        const activeClass = name === activeName ? ' active' : '';

        // Cover image — prefer the 300×300 thumbnail for grid display
        const coverUrl = pl.coverThumb || pl.coverImage || null;
        const bgStyle = coverUrl ? ` style="background-image: url('${escapeHtml(coverUrl)}')"` : '';
        const noCoverClass = coverUrl ? '' : ' dar-pl-no-cover';
        const coverIcon = isSmart ? 'fa-wand-magic-sparkles' : 'fa-list';

        return `
            <div class="dar-playlist-card${activeClass}${noCoverClass}" data-name="${escapeHtml(name)}"${bgStyle}>
                <div class="dar-pl-actions">
                    <button data-action="edit"   title="Edit"   type="button"><i class="fa-solid fa-pen"></i></button>
                    <button data-action="delete" title="Delete" type="button"><i class="fa-solid fa-trash"></i></button>
                </div>
                <div class="dar-pl-info">
                    <i class="fa-solid ${coverIcon} dar-pl-cover-icon"></i>
                    <div class="dar-pl-name">${escapeHtml(name)}</div>
                    <div class="dar-pl-type"><i class="fa-solid ${typeIcon}"></i> ${typeLabel} · ${count} tracks</div>
                </div>
            </div>
        `;
    }).join('');

    $plGrid.innerHTML = cardsHtml;

    // Empty state when no playlists exist (and not filtered)
    if (filtered.length === 0 && names.length === 0) {
        $plGrid.innerHTML = `<div class="dar-placeholder" style="grid-column: 1 / -1;">
            No playlists yet — create one with the buttons above.
        </div>`;
    } else if (filtered.length === 0) {
        $plGrid.innerHTML = `<div class="dar-placeholder" style="grid-column: 1 / -1;">
            No playlists match your search.
        </div>`;
    }
}

// ----------------------------------------------------------------------
// Preferences Tab
// ----------------------------------------------------------------------

// Cached refs
let $prefsMpEnabled = null;
let $prefsMpReset   = null;
let $prefsMpSnap    = null;
let $prefsDebug     = null;
let $prefsMigrate   = null;

/**
 * Wire the Preferences tab — miniplayer + advanced settings.
 * Called once at the end of buildModal().
 *
 * Refreshes from `extension_settings` whenever the modal is opened (via
 * `refreshPreferencesTab()`) so changes made by slash commands or other
 * code paths are reflected when the user next opens the modal.
 */
function wirePreferencesTab() {
    const q = (attr) => modalRoot.querySelector(`[data-dar="${attr}"]`);
    $prefsMpEnabled = q('prefs-mp-enabled');
    $prefsMpReset   = q('prefs-mp-reset');
    $prefsMpSnap    = q('prefs-mp-snap');
    $prefsDebug     = q('prefs-debug');
    $prefsMigrate   = q('prefs-migrate');

    // Enable miniplayer (toggle)
    $prefsMpEnabled.addEventListener('click', () => {
        const newVal = !extension_settings.audio.miniplayer_enabled;
        extension_settings.audio.miniplayer_enabled = newVal;
        $prefsMpEnabled.classList.toggle('on', newVal);
        updateMiniplayerVisibility();
        saveSettingsDebounced();
    });

    // Reset miniplayer position (button) — clears free-form x/y so the
    // miniplayer falls back to its default bottom-right anchor.
    $prefsMpReset.addEventListener('click', () => {
        extension_settings.audio.miniplayer_x = null;
        extension_settings.audio.miniplayer_y = null;
        updateMiniplayerPosition();
        saveSettingsDebounced();
        darToast.success('Miniplayer position reset');
    });

    // Snap to edges (toggle) — read live by miniplayer.js on drag-end.
    $prefsMpSnap.addEventListener('click', () => {
        const newVal = !extension_settings.audio.miniplayer_snap_to_edges;
        extension_settings.audio.miniplayer_snap_to_edges = newVal;
        $prefsMpSnap.classList.toggle('on', newVal);
        saveSettingsDebounced();
    });

    // Debug mode (toggle) — no legacy UI to sync; takes effect immediately
    // via debugLog() in state.js reading extension_settings.audio.debug_mode.
    $prefsDebug.addEventListener('click', () => {
        const newVal = !extension_settings.audio.debug_mode;
        extension_settings.audio.debug_mode = newVal;
        $prefsDebug.classList.toggle('on', newVal);
        saveSettingsDebounced();
    });

    // Migrate metadata (button) — same entry point as /d-audio migrate.
    // Returns a status message when no migration UI is needed (no orphans,
    // or no good matches). When suggestions exist, opens the migration modal
    // itself and returns an empty string.
    $prefsMigrate.addEventListener('click', () => {
        const msg = migrateMetadata();
        if (msg) {
            darToast.info(msg);
        }
    });

    // Initial sync from settings
    refreshPreferencesTab();
}

/**
 * Sync all Preferences tab controls to current extension_settings.audio values.
 * Called on build + every openAudioModal() so changes made via the old
 * drawer or slash commands are reflected when the modal next opens.
 */
function refreshPreferencesTab() {
    if (!$prefsMpEnabled) return;
    const s = extension_settings.audio || {};
    $prefsMpEnabled.classList.toggle('on', !!s.miniplayer_enabled);
    // Default snap-to-edges to true if unset (matches defaultSettings)
    $prefsMpSnap.classList.toggle('on', s.miniplayer_snap_to_edges !== false);
    $prefsDebug.classList.toggle('on', !!s.debug_mode);
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * Open (and lazily build) the audio modal.
 */
export function openAudioModal() {
    if (!modalRoot) buildModal();
    modalRoot.style.display = 'flex';
    requestAnimationFrame(() => draggableModal?.clamp());
    // Sync everything to current state (settings may have changed via slash commands)
    refreshNowPlaying();
    syncPlayPauseIcon();
    syncLoopButton();
    syncVolumeIcon();
    refreshPlaybackTab();
    renderNowPlaying();
    renderLibrary();
    renderPlaylists();
    refreshPreferencesTab();
    debugLog('Audio modal opened');
}

/**
 * Hide the audio modal. Safe to call when the modal hasn't been built yet.
 */
export function closeAudioModal() {
    if (!modalRoot) return;
    modalRoot.style.display = 'none';
    debugLog('Audio modal closed');
}

/**
 * Switch to a named tab. Silently ignored for unknown tab names.
 *
 * @param {('playback'|'library'|'playlists'|'preferences')} tabName
 */
export function switchTab(tabName) {
    if (!modalRoot) return;
    if (!VALID_TABS.includes(tabName)) {
        debugLog(`switchTab: unknown tab "${tabName}"`);
        return;
    }
    activeTab = tabName;

    modalRoot.querySelectorAll('.dar-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });
    modalRoot.querySelectorAll('.dar-tab-panel').forEach(p => {
        p.classList.toggle('active', p.dataset.panel === tabName);
    });
}

/**
 * @returns {string} the currently active tab name.
 */
export function getActiveTab() {
    return activeTab;
}

/**
 * @returns {boolean} true if the modal DOM has been built.
 *   (Doesn't reflect whether it's currently visible.)
 */
export function isModalBuilt() {
    return modalRoot !== null;
}
