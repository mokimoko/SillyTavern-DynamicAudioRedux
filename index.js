/*
 * Dynamic Audio Redux — entry point.
 *
 * Responsible for: the hidden <audio> element host, settings hydration,
 * initial track scan, the ModuleWorkerWrapper for emotion detection,
 * extensions-menu wiring, and slash-command registration. All user-facing
 * UI lives in the audio modal (src/audioModal.js).
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings, ModuleWorkerWrapper } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';

import { openPlaylistFromChatModal } from './src/playlistFromChat.js';

import {
    UPDATE_INTERVAL,
    COMMAND_NAME,
    defaultSettings,
    trackLibrary,
    playbackState,
    debugLog,
} from './src/state.js';
import { scanTracks } from './src/scanner.js';
import { initDataStore } from './src/dataStore.js';
import {
    selectTrack,
    playTrack,
} from './src/player.js';
import { moduleWorker } from './src/emotionDetection.js';
import {
    updateMiniplayerVisibility,
    updateMiniplayerProgress,
} from './src/miniplayer.js';
import { updatePlaylistDropdown } from './src/playlists.js';
import { handleAudioCommand } from './src/slashCommands.js';
import { openAudioModal } from './src/audioModal.js';

// ============================================
// SETTINGS LIFECYCLE
// ============================================

function loadSettings() {
    if (!extension_settings.audio) {
        extension_settings.audio = {};
    }
    // playlists / track_metadata / character_defaults are NOT auto-created
    // here — dataStore.initDataStore() (called from the boot sequence
    // below) loads them from user/files/dar_library.json and hydrates the
    // appropriate in-memory shapes.

    Object.keys(defaultSettings).forEach(key => {
        if (extension_settings.audio[key] === undefined) {
            extension_settings.audio[key] = defaultSettings[key];
        }
    });

    // Push saved values onto the live <audio> element. The modal handles
    // its own UI sync via refreshPlaybackTab() / refreshPreferencesTab() on
    // every openAudioModal().
    const audio = $('#audio_bgm')[0];
    if (audio) {
        audio.volume = (extension_settings.audio.bgm_volume ?? 50) * 0.01;
        audio.muted  = !!extension_settings.audio.bgm_muted;
        audio.loop   = !!extension_settings.audio.loop_single;
    }

    updateMiniplayerVisibility();
}

// ============================================
// INITIALIZATION
// ============================================

jQuery(async () => {
    debugLog('Loading Dynamic Audio Redux...');

    // Mount the hidden audio element. This is the actual <audio> the rest of
    // the extension talks to via `$('#audio_bgm')[0]`. We host it under
    // #audio_settings (a hidden wrapper kept around for any future settings
    // the user may add).
    $('#audio_settings').remove();
    $('#extensions_settings').append(
        '<div id="audio_settings" style="display:none;"><audio id="audio_bgm"></audio></div>'
    );

    loadSettings();

    // Hydrate the persistent library/playlists store from
    // user/files/dar_library.json. Must run BEFORE scanTracks so
    // trackLibrary.metadata is populated and trackLibrary.imported can be
    // built from the registered folders. Migrates from settings on first
    // run (one-time).
    await initDataStore();

    // --- Audio element events ---
    // Track-ended → auto-advance unless single-loop is on
    $('#audio_bgm').on('ended', () => {
        if (!extension_settings.audio.loop_single) {
            const track = selectTrack(true);
            if (track) playTrack(track);
        }
    });

    // Metadata loaded → refresh duration-dependent UI (the modal and the
    // miniplayer subscribe to the audio element directly for the
    // moment-to-moment timeupdate events; this just kicks the miniplayer
    // once at load time so the initial display isn't blank.)
    $('#audio_bgm').on('loadedmetadata', () => {
        updateMiniplayerProgress();
    });

    // --- Initial scan + worker setup ---

    const context = getContext();
    playbackState.lastCharacterName = context.name2;

    await scanTracks();

    updatePlaylistDropdown();

    const totalTracks = trackLibrary.global.length +
        Object.values(trackLibrary.character).reduce((sum, tracks) => sum + tracks.length, 0);
    const totalMetadata = Object.keys(trackLibrary.metadata).length;

    debugLog(`Loaded ${totalTracks} tracks with ${totalMetadata} tagged`);

    const wrapper = new ModuleWorkerWrapper(moduleWorker);
    setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL);

    // Add extensions-menu items: Create Playlist from Chat + Audio Library
    const $extensionsMenu = $('#extensionsMenu');
    if ($extensionsMenu.length > 0) {
        const $playlistMenuItem = $(`
            <div class="list-group-item flex-container flexGap5 interactable" id="audio_playlist_from_chat_btn">
                <i class="fa-solid fa-music"></i>
                <span>Create Playlist from Chat</span>
            </div>
        `);
        $extensionsMenu.append($playlistMenuItem);
        $playlistMenuItem.on('click', () => openPlaylistFromChatModal());

        const $audioModalMenuItem = $(`
            <div class="list-group-item flex-container flexGap5 interactable" id="audio_open_modal_btn">
                <i class="fa-solid fa-headphones-simple"></i>
                <span>Audio Library</span>
            </div>
        `);
        $extensionsMenu.append($audioModalMenuItem);
        $audioModalMenuItem.on('click', () => openAudioModal());
    }

    // Register slash command
    registerSlashCommand(
        COMMAND_NAME,
        handleAudioCommand,
        [],
        `<div>
            <strong>/d-audio</strong> - Control Dynamic Audio Redux
            <br><br>
            <strong>Actions:</strong> on, off, skip, prev, scan, migrate, library, status, nowplaying
            <br>
            <strong>Get/Set:</strong> mode, emotion, autoswitch, shuffle, loop, volume, miniplayer, position, cooldown, debug
            <br>
            <strong>Playlist Commands:</strong>
            <br>• <code>/d-audio playlist</code> - Show current playlist
            <br>• <code>/d-audio playlist "My Playlist"</code> - Switch to playlist
            <br>
            <strong>Examples:</strong>
            <br>• <code>/d-audio on</code>
            <br>• <code>/d-audio mode=instrumental autoswitch=on</code>
            <br>• <code>/d-audio playlist "Epic Battles"</code>
            <br>• <code>/d-audio debug on</code> (enable debug logging)
            <br>• <code>/d-audio nowplaying</code> (returns current track)
            <br>• <code>/d-audio "track" playlist="Favorites"</code> (add track)
            <br>• <code>/d-audio migrate</code> (fix metadata after renaming files)
        </div>`,
        true,
        true
    );

    debugLog('Dynamic Audio Redux loaded successfully');
});
