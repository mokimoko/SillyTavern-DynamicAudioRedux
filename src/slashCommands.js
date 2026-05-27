/*
 * Slash Commands — handler for /d-audio with all subcommands.
 *
 * Mutates extension_settings directly and calls live helpers (selectTrack,
 * playTrack, updateMiniplayerVisibility, etc.) where the change has an
 * immediate UI side-effect. The new audio modal re-reads settings every
 * time it opens, so the slash commands don't need to push anything to it.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

import {
    EMOTION_TAGS,
    trackLibrary,
    playbackState,
} from './state.js';
import { selectTrack, playTrack, onSkipTrack, onPreviousTrack } from './player.js';
import { scanTracks } from './scanner.js';
import {
    updateMiniplayerVisibility,
    updateMiniplayerContent,
    updateMiniplayerPosition,
} from './miniplayer.js';
import { migrateMetadata } from './trackList.js';
import { openAudioModal } from './audioModal.js';

export function handleAudioCommand(args, value) {
    // Action commands (no arguments)
    if (value) {
        const action = value.toLowerCase().trim();

        switch (action) {
            case 'on': {
                extension_settings.audio.enabled = true;
                const track = selectTrack();
                if (track) playTrack(track);
                updateMiniplayerVisibility();
                saveSettingsDebounced();
                return 'Audio enabled';
            }

            case 'off':
                extension_settings.audio.enabled = false;
                $('#audio_bgm')[0].pause();
                updateMiniplayerVisibility();
                saveSettingsDebounced();
                return 'Audio disabled';

            case 'skip':
                onSkipTrack();
                return 'Skipped to next track';

            case 'prev':
            case 'previous':
                onPreviousTrack();
                return 'Returned to previous track';

            case 'scan':
                scanTracks();
                return 'Rescanning tracks...';

            case 'migrate':
            case 'fix':
            case 'fix-metadata':
                return migrateMetadata();

            case 'library':
            case 'open':
            case 'modal':
                openAudioModal();
                return 'Opened Audio Library';

            case 'status': {
                const status = [];
                status.push(`Enabled: ${extension_settings.audio.enabled ? 'Yes' : 'No'}`);
                status.push(`Mode: ${extension_settings.audio.mode}`);
                status.push(`Volume: ${extension_settings.audio.bgm_volume}%`);
                if (extension_settings.audio.mode === 'playlist' && extension_settings.audio.active_playlist) {
                    status.push(`Active Playlist: ${extension_settings.audio.active_playlist}`);
                }
                if (playbackState.currentTrack) {
                    const metadata = trackLibrary.metadata[playbackState.currentTrack] || {};
                    const filename = playbackState.currentTrack.split('/').pop();
                    status.push(`Now Playing: ${metadata.title || filename}`);
                }
                status.push(`Emotion Detection: ${extension_settings.audio.emotion_detection ? 'On' : 'Off'}`);
                if (extension_settings.audio.emotion_detection) {
                    status.push(`Current Emotion: ${playbackState.currentEmotion}`);
                }
                status.push(`Shuffle: ${extension_settings.audio.shuffle ? 'On' : 'Off'}`);
                status.push(`Loop: ${extension_settings.audio.loop_single ? 'On' : 'Off'}`);
                status.push(`Miniplayer: ${extension_settings.audio.miniplayer_enabled ? 'On' : 'Off'}`);
                if (extension_settings.audio.miniplayer_enabled) {
                    const mx = extension_settings.audio.miniplayer_x;
                    const my = extension_settings.audio.miniplayer_y;
                    const posStr = (mx == null || my == null) ? 'default' : `(${mx}, ${my})`;
                    status.push(`Miniplayer Position: ${posStr}`);
                }
                return status.join('\n');
            }

            case 'nowplaying': {
                if (!playbackState.currentTrack) return '';
                const metadata = trackLibrary.metadata[playbackState.currentTrack] || {};
                const filename = playbackState.currentTrack.split('/').pop();
                return metadata.title || filename;
            }
        }
    }

    // Handle track addition to playlist
    // /d-audio "track-name" playlist="My Playlist"
    if (value && args.playlist) {
        const trackQuery = value.trim();
        const playlistName = args.playlist;

        const allTracks = [
            ...trackLibrary.global,
            ...Object.values(trackLibrary.character).flat()
        ];

        const matchingTrack = allTracks.find(path => {
            const filename = path.split('/').pop();
            const metadata = trackLibrary.metadata[path] || {};
            const title = metadata.title || filename;
            return title.toLowerCase().includes(trackQuery.toLowerCase()) ||
                   filename.toLowerCase().includes(trackQuery.toLowerCase());
        });

        if (!matchingTrack) {
            return `Track not found: ${trackQuery}`;
        }

        const playlist = extension_settings.audio.playlists[playlistName];
        if (!playlist) {
            return `Playlist not found: ${playlistName}`;
        }

        if (playlist.type !== 'manual') {
            return `Cannot add tracks to smart playlist: ${playlistName}`;
        }

        if (!playlist.tracks.includes(matchingTrack)) {
            playlist.tracks.push(matchingTrack);
            saveSettingsDebounced();
            const metadata = trackLibrary.metadata[matchingTrack] || {};
            const filename = matchingTrack.split('/').pop();
            return `Added "${metadata.title || filename}" to playlist "${playlistName}"`;
        } else {
            return `Track already in playlist`;
        }
    }

    // Named arguments - get/set pattern
    let results = [];
    let hasChanges = false;

    // Mode
    if ('mode' in args) {
        if (args.mode === '') {
            return extension_settings.audio.mode;
        } else if (['instrumental', 'songs', 'playlist'].includes(args.mode)) {
            extension_settings.audio.mode = args.mode;
            if (extension_settings.audio.enabled) {
                const track = selectTrack();
                if (track) playTrack(track);
            }
            hasChanges = true;
            results.push(`Mode set to: ${args.mode}`);
        }
    }

    // Playlist - handle both with and without value
    if ('playlist' in args) {
        const playlistValue = args.playlist || value;

        if (!playlistValue || playlistValue === '') {
            return extension_settings.audio.active_playlist || '';
        } else {
            if (extension_settings.audio.playlists[playlistValue]) {
                extension_settings.audio.active_playlist = playlistValue;
                if (extension_settings.audio.enabled && extension_settings.audio.mode === 'playlist') {
                    const track = selectTrack();
                    if (track) playTrack(track);
                }
                hasChanges = true;
                results.push(`Playlist set to: ${playlistValue}`);
            } else {
                results.push(`Playlist not found: ${playlistValue}`);
            }
        }
    }

    // Emotion filter (for songs mode)
    if ('emotion' in args) {
        if (args.emotion === '') {
            return extension_settings.audio.songs_emotion_filter;
        } else if (args.emotion === 'all' || EMOTION_TAGS.includes(args.emotion)) {
            extension_settings.audio.songs_emotion_filter = args.emotion;
            if (extension_settings.audio.enabled && extension_settings.audio.mode === 'songs') {
                const track = selectTrack();
                if (track) playTrack(track);
            }
            hasChanges = true;
            results.push(`Emotion filter set to: ${args.emotion}`);
        }
    }

    // Auto-switch (emotion detection)
    if ('autoswitch' in args) {
        if (args.autoswitch === '') {
            return extension_settings.audio.emotion_detection ? 'on' : 'off';
        } else {
            const enabled = args.autoswitch === 'on' || args.autoswitch === 'true';
            extension_settings.audio.emotion_detection = enabled;
            hasChanges = true;
            results.push(`Auto-switch: ${enabled ? 'on' : 'off'}`);
        }
    }

    // Shuffle
    if ('shuffle' in args) {
        if (args.shuffle === '') {
            return extension_settings.audio.shuffle ? 'on' : 'off';
        } else {
            const enabled = args.shuffle === 'on' || args.shuffle === 'true';
            extension_settings.audio.shuffle = enabled;
            hasChanges = true;
            results.push(`Shuffle: ${enabled ? 'on' : 'off'}`);
        }
    }

    // Loop
    if ('loop' in args) {
        if (args.loop === '') {
            return extension_settings.audio.loop_single ? 'on' : 'off';
        } else {
            const enabled = args.loop === 'on' || args.loop === 'true';
            extension_settings.audio.loop_single = enabled;
            $('#audio_bgm')[0].loop = enabled;
            hasChanges = true;
            results.push(`Loop: ${enabled ? 'on' : 'off'}`);
        }
    }

    // Volume
    if ('volume' in args) {
        if (args.volume === '') {
            return String(extension_settings.audio.bgm_volume);
        } else {
            const vol = parseInt(args.volume);
            if (!isNaN(vol) && vol >= 0 && vol <= 100) {
                extension_settings.audio.bgm_volume = vol;
                $('#audio_bgm')[0].volume = vol * 0.01;
                $('#miniplayer_volume').val(vol);
                updateMiniplayerContent();
                hasChanges = true;
                results.push(`Volume set to: ${vol}%`);
            }
        }
    }

    // Miniplayer
    if ('miniplayer' in args) {
        if (args.miniplayer === '') {
            return extension_settings.audio.miniplayer_enabled ? 'on' : 'off';
        } else {
            const enabled = args.miniplayer === 'on' || args.miniplayer === 'true';
            extension_settings.audio.miniplayer_enabled = enabled;
            updateMiniplayerVisibility();
            hasChanges = true;
            results.push(`Miniplayer: ${enabled ? 'on' : 'off'}`);
        }
    }

    // Position — translates the corner enum to free-form x/y so the
    // command keeps working with the draggable miniplayer.
    if ('position' in args) {
        if (args.position === '') {
            const mx = extension_settings.audio.miniplayer_x;
            const my = extension_settings.audio.miniplayer_y;
            return (mx == null || my == null) ? 'default' : `(${mx}, ${my})`;
        } else if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(args.position)) {
            const mp = document.getElementById('audio_miniplayer');
            const w = mp?.offsetWidth || 170;
            const h = mp?.offsetHeight || 32;
            const gap = 20;
            let x, y;
            switch (args.position) {
                case 'top-right':    x = window.innerWidth - w - gap; y = gap; break;
                case 'top-left':     x = gap;                          y = gap; break;
                case 'bottom-right': x = window.innerWidth - w - gap; y = window.innerHeight - h - gap; break;
                case 'bottom-left':  x = gap;                          y = window.innerHeight - h - gap; break;
            }
            extension_settings.audio.miniplayer_x = x;
            extension_settings.audio.miniplayer_y = y;
            updateMiniplayerPosition();
            hasChanges = true;
            results.push(`Position set to: ${args.position}`);
        }
    }

    // Cooldown
    if ('cooldown' in args) {
        if (args.cooldown === '') {
            return String(extension_settings.audio.cooldown);
        } else {
            const cd = parseInt(args.cooldown);
            if (!isNaN(cd) && cd >= 0) {
                extension_settings.audio.cooldown = cd;
                hasChanges = true;
                results.push(`Cooldown set to: ${cd} seconds`);
            }
        }
    }

    // Debug mode
    if ('debug' in args) {
        if (args.debug === '') {
            return extension_settings.audio.debug_mode ? 'on' : 'off';
        } else {
            const enabled = args.debug === 'on' || args.debug === 'true';
            extension_settings.audio.debug_mode = enabled;
            hasChanges = true;
            results.push(`Debug mode: ${enabled ? 'on' : 'off'}`);
        }
    }

    if (hasChanges) {
        saveSettingsDebounced();
    }

    return results.length > 0 ? results.join('\n') : '';
}
