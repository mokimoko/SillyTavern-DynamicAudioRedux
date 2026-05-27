/*
 * Scanner — discovers tracks on disk and manages metadata persistence.
 * Dispatches 'tracksScanned' after a successful scan.
 */

import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { getContext, extension_settings } from '../../../../extensions.js';

import {
    DEBUG_PREFIX,
    trackLibrary,
    playbackState,
    audioEvents,
    debugLog,
} from './state.js';
import { getImportedTrackUrls } from './dataStore.js';

export function cleanFilename(filename) {
    let cleaned = filename;

    // Remove file extension
    cleaned = cleaned.replace(/\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i, '');

    // Remove common junk patterns
    const patterns = [
        /\(from [^)]+\)/gi,
        /\[from [^\]]+\]/gi,
        /\(official[^)]*\)/gi,
        /\[official[^\]]*\]/gi,
        /\(hd\)/gi, /\[hd\]/gi,
        /\(4k\)/gi, /\[4k\]/gi,
        /\(lyrics?\)/gi, /\[lyrics?\]/gi,
        /\(audio\)/gi, /\[audio\]/gi,
        /\(music video\)/gi, /\[music video\]/gi,
        /\(full\)/gi, /\[full\]/gi,
        /\s+-\s+Topic$/,
        /\s+\d{4}$/,
    ];

    patterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
    });

    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
}

export async function scanTracks() {
    debugLog('Scanning for tracks...');

    try {
        const globalTracks = await fetch('/api/assets/get', {
            method: 'POST',
            headers: getRequestHeaders(),
        }).then(r => r.json());

        trackLibrary.global = (globalTracks.bgm || []).filter(f => f !== '.placeholder');

        const context = getContext();
        if (context.name2) {
            const charTracks = await fetch(`/api/assets/character?name=${encodeURIComponent(context.name2)}&category=bgm`, {
                method: 'POST',
                headers: getRequestHeaders(),
            }).then(r => r.json());

            trackLibrary.character[context.name2] = charTracks || [];
        }

        // Imported tracks live under /user/files/<folder>/. The dataStore
        // is the source of truth — we don't enumerate the filesystem here,
        // since ST has no list endpoint for user/files. Whatever the user
        // registered via folderImport is what we have.
        trackLibrary.imported = getImportedTrackUrls();

        debugLog(`Found tracks: global=${trackLibrary.global.length}, character=${Object.keys(trackLibrary.character).reduce((sum, k) => sum + trackLibrary.character[k].length, 0)}, imported=${trackLibrary.imported.length}`);

        // Update last known character to prevent duplicate auto-scans
        playbackState.lastCharacterName = context.name2;

        await loadMetadata();

        // Notify listeners (trackList.js renders, etc.)
        audioEvents.dispatchEvent(new CustomEvent('tracksScanned'));
        audioEvents.dispatchEvent(new CustomEvent('trackListChanged'));
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error scanning tracks:', error);
    }
}

export async function loadMetadata() {
    // dataStore.initDataStore() has already hydrated trackLibrary.metadata
    // from user/files/dar_library.json (or migrated it from
    // extension_settings.audio.track_metadata on first run). Nothing to do
    // here at scan time — just log what's loaded.
    debugLog(`Loaded metadata for ${Object.keys(trackLibrary.metadata).length} tracks (via dataStore)`);
}

export async function saveMetadata() {
    debugLog('Saving track metadata...');

    try {
        // dataStore listens to 'trackListChanged' and schedules a debounced
        // save to user/files/dar_library.json. The settings copy is kept
        // briefly as redundancy and will fall out of sync once dataStore
        // takes over fully — that's fine; file wins on next boot.
        extension_settings.audio.track_metadata = trackLibrary.metadata;
        saveSettingsDebounced();
        debugLog(`Metadata saved successfully: ${Object.keys(trackLibrary.metadata).length} tracks`);
        // Notify listeners (modal Library tab, dataStore, etc.) so they
        // refresh / persist after edits/bulk-tag/migration without each
        // caller having to dispatch separately.
        audioEvents.dispatchEvent(new CustomEvent('trackListChanged'));
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error saving metadata:', error);
    }
}
