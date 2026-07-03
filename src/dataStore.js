/*
 * dataStore.js — Persistent library/playlist storage for Dynamic Audio Redux.
 *
 * Single file: user/files/dar_library.json
 * Replaces the use of extension_settings.audio.{track_metadata,playlists,
 * character_defaults} as canonical storage. Settings.json keeps only
 * config/UI state; this file owns curated data.
 *
 * Persistence strategy:
 *   - Loaded once on init() (cached in memory)
 *   - Hydrates trackLibrary.metadata + extension_settings.audio.playlists
 *     so existing read sites keep working without changes
 *   - Listens to audioEvents.playlistsChanged + .trackListChanged and
 *     schedules a debounced save — no call site needs to know about us
 *   - sendBeacon flush on page unload (skipped if payload > 60KB)
 *
 * Migration: on first run with no file, seeds from
 *   extension_settings.audio.{track_metadata,playlists,character_defaults}
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

import {
    DEBUG_PREFIX,
    trackLibrary,
    audioEvents,
    debugLog,
} from './state.js';

const FILENAME = 'dar_library.json';
const FILE_URL = `/user/files/${FILENAME}`;
const DEBOUNCE_MS = 2000;
const BEACON_LIMIT_BYTES = 60_000;
const SCHEMA_VERSION = 1;

// ---- In-memory cache ----
let cache = null;
let loaded = false;

// ---- Debounce state ----
let saveTimer = null;
let pendingSave = false;
let unloadRegistered = false;

// ============================================================
// File API helpers — upload base64 to /api/files/upload,
// download via GET on /user/files/<name>
// ============================================================

function encodeBase64(jsonString) {
    const bytes = new TextEncoder().encode(jsonString);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function uploadJSON(data) {
    const json = JSON.stringify(data, null, 2);
    const base64 = encodeBase64(json);

    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: FILENAME, data: base64 }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`dar_library upload failed: ${errorText}`);
    }
    return (await response.json()).path;
}

async function downloadJSON() {
    const response = await fetch(FILE_URL, {
        method: 'GET',
        headers: getRequestHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`dar_library download failed: ${errorText}`);
    }
    const text = await response.text();
    return JSON.parse(text);
}

// ============================================================
// Cache <-> in-memory views
//
// trackLibrary.metadata, extension_settings.audio.playlists, and
// extension_settings.audio.character_defaults are the in-memory shapes
// the rest of the codebase reads from. On load, we point those at our
// cached objects. On mutation (signalled via audioEvents), we snapshot
// them back into cache.{tracks,playlists,characterDefaults} and save.
// ============================================================

function createEmptyStore() {
    return {
        version: SCHEMA_VERSION,
        lastModified: new Date().toISOString(),
        tracks: {},              // url -> { tags, title, folder?, originalName?, ... }
        folders: {},             // folderName -> { addedAt, lastSyncedAt }
        playlists: {},           // name -> { type, tracks, tags, ... }
        characterDefaults: {},   // charName -> { playlist?, ... }
    };
}

function hydrateInMemoryShapes() {
    // Point the existing read sites at our cached objects.
    // Mutations to these objects (e.g. `trackLibrary.metadata[url] = {...}`)
    // mutate our cache in-place, so snapshotForSave() is a no-op read.
    trackLibrary.metadata = cache.tracks;

    if (!extension_settings.audio) extension_settings.audio = {};
    extension_settings.audio.playlists = cache.playlists;
    extension_settings.audio.character_defaults = cache.characterDefaults;
}

function snapshotForSave() {
    // Defensive: in case someone reassigned trackLibrary.metadata to a new
    // object (rather than mutating in place), pick that up before saving.
    cache.tracks            = trackLibrary.metadata            || cache.tracks;
    cache.playlists         = extension_settings.audio?.playlists         || cache.playlists;
    cache.characterDefaults = extension_settings.audio?.character_defaults || cache.characterDefaults;
    cache.lastModified      = new Date().toISOString();

    // Re-point hydration in case any of the above were swapped out
    hydrateInMemoryShapes();
}

// ============================================================
// Debounced persistence
// ============================================================

function scheduleSave() {
    pendingSave = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        try {
            snapshotForSave();
            await uploadJSON(cache);
            pendingSave = false;
            debugLog(`dar_library.json saved (${Object.keys(cache.tracks).length} tracks, ${Object.keys(cache.playlists).length} playlists, ${Object.keys(cache.folders).length} folders)`);
        } catch (e) {
            console.error(DEBUG_PREFIX, 'Debounced dar_library save failed:', e);
            // Leave pendingSave=true so unload flush still attempts
        }
    }, DEBOUNCE_MS);
}

async function saveImmediate() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    snapshotForSave();
    await uploadJSON(cache);
    pendingSave = false;
    debugLog(`dar_library.json saved (immediate)`);
}

function flushOnUnload() {
    if (!pendingSave) return;
    try {
        snapshotForSave();
        const json = JSON.stringify(cache, null, 2);
        const base64 = encodeBase64(json);
        const payload = JSON.stringify({ name: FILENAME, data: base64 });

        if (payload.length < BEACON_LIMIT_BYTES) {
            navigator.sendBeacon(
                '/api/files/upload',
                new Blob([payload], { type: 'application/json' }),
            );
        }
        // If payload exceeds the beacon limit, the most recent debounced save
        // (≤2s old) is our safety net. Better than dropping a partial write.
    } catch (e) {
        console.error(DEBUG_PREFIX, 'dar_library unload flush failed:', e);
    }
    pendingSave = false;
}

// markDirty is the external "something changed" signal.
// Called by audioEvents listeners; also exposed for direct callers
// (e.g. folder import after a bulk add wants to ensure a save).
export function markDirty() {
    if (!loaded) return; // Guard against pre-init dispatches
    scheduleSave();
}

export async function flushStore() {
    if (!loaded || !pendingSave) return;
    await saveImmediate();
}

// ============================================================
// Migration from extension_settings.audio (one-time on first run)
// ============================================================

function migrateFromSettings() {
    const seed = createEmptyStore();
    const audio = extension_settings.audio || {};
    let migrated = false;

    if (audio.track_metadata && Object.keys(audio.track_metadata).length > 0) {
        seed.tracks = audio.track_metadata;
        migrated = true;
        debugLog(`Migration: copied ${Object.keys(audio.track_metadata).length} track metadata entries from settings`);
    }
    if (audio.playlists && Object.keys(audio.playlists).length > 0) {
        seed.playlists = audio.playlists;
        migrated = true;
        debugLog(`Migration: copied ${Object.keys(audio.playlists).length} playlists from settings`);
    }
    if (audio.character_defaults && Object.keys(audio.character_defaults).length > 0) {
        seed.characterDefaults = audio.character_defaults;
        migrated = true;
        debugLog(`Migration: copied ${Object.keys(audio.character_defaults).length} character defaults from settings`);
    }

    if (migrated) {
        debugLog('Migrated track_metadata / playlists / character_defaults from extension_settings → user/files/dar_library.json. Settings copies retained as redundancy until next ST update.');
    }
    return seed;
}

// ============================================================
// Public init — call once at extension boot
// ============================================================

export async function initDataStore() {
    if (loaded) return cache;

    let didMigrate = false;
    try {
        const existing = await downloadJSON();
        if (existing && typeof existing === 'object') {
            // Defensive merge against an empty store so missing top-level keys
            // (e.g. a v1 file that pre-dates folders/) don't crash readers.
            const empty = createEmptyStore();
            cache = {
                version: existing.version || SCHEMA_VERSION,
                lastModified: existing.lastModified || new Date().toISOString(),
                tracks:            existing.tracks            || empty.tracks,
                folders:           existing.folders           || empty.folders,
                playlists:         existing.playlists         || empty.playlists,
                characterDefaults: existing.characterDefaults || empty.characterDefaults,
            };
            debugLog(`dar_library.json loaded: ${Object.keys(cache.tracks).length} tracks, ${Object.keys(cache.playlists).length} playlists, ${Object.keys(cache.folders).length} folders`);
        } else {
            // No file yet — seed from existing settings (one-time migration)
            cache = migrateFromSettings();
            didMigrate = true;
        }
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Failed to load dar_library.json, starting empty:', e);
        cache = createEmptyStore();
        didMigrate = true;
    }

    hydrateInMemoryShapes();
    loaded = true;

    // Auto-save listeners — every mutation that fires one of these events
    // will trigger a debounced file write. No call site changes needed.
    audioEvents.addEventListener('playlistsChanged', markDirty);
    audioEvents.addEventListener('trackListChanged', markDirty);

    // Beacon flush on tab close
    if (!unloadRegistered) {
        window.addEventListener('beforeunload', flushOnUnload);
        unloadRegistered = true;
    }

    // Persist immediately ONLY on first run (after migration), so the file
    // exists going forward. On subsequent boots we wait for a real mutation.
    if (didMigrate) {
        try {
            await saveImmediate();
        } catch (e) {
            console.error(DEBUG_PREFIX, 'Initial dar_library save failed (will retry on next mutation):', e);
        }
    }

    return cache;
}

// ============================================================
// Folder registry — imported folder operations
//
// Folders are directories under user/files/ that the user has manually
// dropped audio files into and then "registered" with DAR via the folder
// import UI. Tracks from these folders live in cache.tracks with a
// `folder` field so we can group/filter/rescan/remove by folder.
// ============================================================

export function getStore() {
    if (!loaded) {
        console.warn(DEBUG_PREFIX, 'getStore() called before initDataStore() — returning empty cache');
        return createEmptyStore();
    }
    return cache;
}

export function getFolders() {
    return Object.keys(getStore().folders);
}

export function addFolder(folderName, meta = {}) {
    const store = getStore();
    store.folders[folderName] = {
        addedAt:      meta.addedAt      || new Date().toISOString(),
        lastSyncedAt: meta.lastSyncedAt || new Date().toISOString(),
    };
    scheduleSave();
}

export function updateFolderSync(folderName) {
    const store = getStore();
    if (store.folders[folderName]) {
        store.folders[folderName].lastSyncedAt = new Date().toISOString();
        scheduleSave();
    }
}

/**
 * Remove a folder registration. By default this also strips the metadata for
 * any tracks tagged with that folder — they vanish from the library. The
 * actual audio files on disk are NOT touched.
 *
 * Returns the number of track metadata entries removed.
 */
export function removeFolder(folderName, { keepTrackMetadata = false } = {}) {
    const store = getStore();
    if (!store.folders[folderName]) return 0;

    delete store.folders[folderName];

    let removedTracks = 0;
    if (!keepTrackMetadata) {
        for (const [url, meta] of Object.entries(store.tracks)) {
            if (meta && meta.folder === folderName) {
                delete store.tracks[url];
                removedTracks++;
            }
        }
    }

    scheduleSave();
    // Fire trackListChanged so the Library tab + miniplayer refresh
    audioEvents.dispatchEvent(new CustomEvent('trackListChanged'));
    return removedTracks;
}

/**
 * Return the imported-track URLs for a given folder (or all folders if name
 * is omitted). Used by the scanner to populate trackLibrary.imported.
 */
export function getImportedTrackUrls(folderName = null) {
    const store = getStore();
    const urls = [];
    for (const [url, meta] of Object.entries(store.tracks)) {
        if (!meta || !meta.folder) continue;
        if (folderName === null || meta.folder === folderName) {
            urls.push(url);
        }
    }
    return urls;
}

/**
 * Register a batch of imported tracks at once. Used by folderImport.js after
 * the verify endpoint confirms which files exist on disk.
 *
 * `tracks` is an array of { url, originalName, folder, subfolder }.
 * Existing metadata for a URL is preserved (tags, title, etc).
 */
export function registerImportedTracks(tracks) {
    const store = getStore();
    let added = 0;
    for (const { url, originalName, folder, subfolder } of tracks) {
        const existing = store.tracks[url] || {};
        store.tracks[url] = {
            ...existing,
            folder,
            subfolder: subfolder || existing.subfolder || '',
            originalName: originalName || existing.originalName,
        };
        if (!existing.folder) added++;
    }
    scheduleSave();
    audioEvents.dispatchEvent(new CustomEvent('trackListChanged'));
    return added;
}
