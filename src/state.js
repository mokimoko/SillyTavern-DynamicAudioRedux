/*
 * State — shared constants, mutable state, and event bus
 * Foundation module. Imports nothing from internal modules.
 */

import { extension_settings } from '../../../../extensions.js';

export const MODULE_NAME = 'Audio';
export const DEBUG_PREFIX = '<Audio Module>';
export const UPDATE_INTERVAL = 1000;
export const COMMAND_NAME = 'd-audio';

// Default emotion tags - matches SillyTavern character expressions
export const EMOTION_TAGS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval',
    'caring', 'confusion', 'curiosity', 'desire', 'disappointment',
    'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear',
    'gratitude', 'grief', 'joy', 'love', 'nervousness',
    'optimism', 'pride', 'realization', 'relief', 'remorse',
    'sadness', 'surprise', 'neutral',
];

// Default settings (deep-copied per-key on first load by loadSettings)
export const defaultSettings = {
    enabled: false,
    mode: 'instrumental',

    bgm_volume: 50,
    bgm_muted: false,
    ambient_volume: 50,
    ambient_muted: false,

    emotion_detection: true,
    instrumental_only: true,
    instrumental_include_global: true,
    songs_emotion_filter: 'all',
    songs_include_global: true,
    cooldown: 30,
    loop_single: false,
    shuffle: false,

    miniplayer_enabled: false,
    miniplayer_x: null,               // free-form X coord in px (null = use default bottom-right)
    miniplayer_y: null,               // free-form Y coord in px (null = use default bottom-right)
    miniplayer_snap_to_edges: true,

    show_global_tracks: true,
    show_only_current_character: false,

    debug_mode: false,

    // active_playlist is UI/selection state — stays in settings.
    // playlists + character_defaults moved to user/files/dar_library.json
    // (see src/dataStore.js). dataStore hydrates them onto
    // extension_settings.audio at boot so existing read sites keep working.
    active_playlist: null,

    // Playlist-from-Chat — persisted AI suggestion track count (10 / 15 / 20).
    playlist_from_chat_ai_count: 15,
};

// Track Library — central storage for all discovered tracks.
// Mutated via property access from any module.
export const trackLibrary = {
    global: [],      // Tracks from /assets/bgm/
    character: {},   // Tracks from /characters/<name>/bgm/
    imported: [],    // Tracks from /user/files/<folder>/ (registered via folder import)
    metadata: {},    // Track metadata (tags, titles, etc) — keyed by URL; populated by dataStore
};

/**
 * Return every track URL across global, character, and imported sources.
 * Centralizes the "give me everything" idiom that several modules used to
 * spell out as [...trackLibrary.global, ...Object.values(character).flat()].
 */
export function getAllTrackPaths() {
    return [
        ...trackLibrary.global,
        ...Object.values(trackLibrary.character).flat(),
        ...trackLibrary.imported,
    ];
}

// Playback / selection state — mutated via property access.
// Using a single object so all modules see the same live values.
export const playbackState = {
    currentTrack: null,
    previousTrack: null,
    currentEmotion: 'neutral',
    playQueue: [],
    cooldownTimer: 0,
    lastSkipDirection: 'forward',
    isSeeking: false,
    lastCharacterName: null,
    selectedTracks: new Set(),
    lastSelectedIndex: -1,
};

// Event bus — cross-module notifications without circular imports.
// Dispatched events:
//   'tracksScanned'       — after scanTracks completes (trackLibrary populated)
//   'trackListChanged'    — anything affecting visible track list/highlight
//   'nowPlayingChanged'   — after playTrack succeeds (detail: { trackPath })
//   'playlistsChanged'    — after playlist CRUD
//   'modeChanged'         — after mode toggle (detail: { mode })
//   'miniplayerVisibilityChanged' — after enable/disable
export const audioEvents = new EventTarget();

// Global debug logging
export function debugLog(msg) {
    if (extension_settings.audio && extension_settings.audio.debug_mode) {
        console.log(DEBUG_PREFIX, msg);
    }
}
