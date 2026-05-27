/*
 * Player — track selection, playback, transport controls.
 * Dispatches 'nowPlayingChanged' after a successful play.
 */

import { getContext, extension_settings } from '../../../../extensions.js';

import {
    DEBUG_PREFIX,
    trackLibrary,
    playbackState,
    audioEvents,
    debugLog,
} from './state.js';

export function filterTracksByTags(tags, characterName = null, includeGlobal = true) {
    if (trackLibrary.global.length === 0 && Object.keys(trackLibrary.character).length === 0) {
        if (extension_settings.audio.debug_mode) {
            console.warn(DEBUG_PREFIX, 'filterTracksByTags called but track library is empty!');
        }
    }

    let tracks = [];

    if (includeGlobal) {
        tracks = [...trackLibrary.global];
    }

    if (characterName && trackLibrary.character[characterName]) {
        tracks = [...trackLibrary.character[characterName], ...tracks];
    } else if (!characterName) {
        Object.values(trackLibrary.character).forEach(charTracks => {
            tracks = [...charTracks, ...tracks];
        });
    }

    // Imported tracks (registered folders under /user/files/) are always
    // included — they're user-curated. The includeGlobal toggle controls
    // /assets/bgm tracks specifically.
    tracks = [...trackLibrary.imported, ...tracks];

    const matches = tracks.filter(path => {
        const metadata = trackLibrary.metadata[path];
        if (!metadata || !metadata.tags) return false;
        return tags.every(tag => metadata.tags.includes(tag));
    });

    return matches;
}

export function selectTrack(skipForward = false) {
    const mode = extension_settings.audio.mode;
    const context = getContext();
    const characterName = context.name2;

    let candidates = [];

    if (mode === 'instrumental') {
        const tags = ['instrumental'];
        const includeGlobal = extension_settings.audio.instrumental_include_global !== false;

        if (extension_settings.audio.emotion_detection) {
            tags.push(playbackState.currentEmotion);
        }
        candidates = filterTracksByTags(tags, characterName, includeGlobal);

        if (candidates.length === 0) {
            candidates = filterTracksByTags(['instrumental'], characterName, includeGlobal);
        }

    } else if (mode === 'songs') {
        const emotionFilter = extension_settings.audio.songs_emotion_filter;
        const includeGlobal = extension_settings.audio.songs_include_global !== false;

        if (emotionFilter && emotionFilter !== 'all') {
            candidates = filterTracksByTags([emotionFilter], characterName, includeGlobal);
        } else {
            // Get all songs based on include_global setting
            if (includeGlobal) {
                candidates = [...trackLibrary.global];
                if (characterName && trackLibrary.character[characterName]) {
                    candidates = [...trackLibrary.character[characterName], ...candidates];
                }
            } else {
                // Only character tracks
                if (characterName && trackLibrary.character[characterName]) {
                    candidates = [...trackLibrary.character[characterName]];
                } else {
                    candidates = [];
                }
            }
        }
    } else if (mode === 'playlist') {
        const playlistName = extension_settings.audio.active_playlist;
        const playlist = extension_settings.audio.playlists[playlistName];

        if (playlist) {
            if (playlist.type === 'manual') {
                candidates = playlist.tracks || [];
            } else if (playlist.type === 'smart') {
                const tags = [...(playlist.tags || [])];
                const includeGlobal = playlist.include_global !== false;

                if (playlist.emotion_mode === 'auto') {
                    tags.push(playbackState.currentEmotion);
                } else if (playlist.emotion_mode === 'manual' && playlist.emotion_override) {
                    tags.push(playlist.emotion_override);
                }

                candidates = filterTracksByTags(tags, characterName, includeGlobal);
            }
        }
    }

    if (candidates.length === 0) {
        if (extension_settings.audio.debug_mode) {
            debugLog('No tracks match current criteria');
        }
        return null;
    }

    // --- Debug: trace candidate list and selection logic ---
    if (extension_settings.audio.debug_mode) {
        debugLog(`selectTrack called: skipForward=${skipForward}, shuffle=${extension_settings.audio.shuffle}, candidates=${candidates.length}, currentTrack=${playbackState.currentTrack?.split('/').pop()}`);
        const currentIdx = candidates.indexOf(playbackState.currentTrack);
        debugLog(`  currentTrack index in candidates: ${currentIdx}`);
        // Log first 10 candidates to see ordering + duplicates
        candidates.slice(0, Math.min(15, candidates.length)).forEach((c, i) => {
            const marker = (c === playbackState.currentTrack) ? ' ◀ CURRENT' : '';
            debugLog(`  [${i}] ${c.split('/').pop()}${marker}`);
        });
        if (candidates.length > 15) debugLog(`  ... and ${candidates.length - 15} more`);
    }

    if (skipForward && playbackState.currentTrack) {
        const currentIndex = candidates.indexOf(playbackState.currentTrack);

        if (currentIndex !== -1) {
            const nextIndex = (currentIndex + 1) % candidates.length;
            if (extension_settings.audio.debug_mode) {
                debugLog(`  → skipForward: index ${currentIndex} → ${nextIndex}, picking: ${candidates[nextIndex]?.split('/').pop()}`);
            }
            return candidates[nextIndex];
        }
        if (extension_settings.audio.debug_mode) {
            debugLog(`  → skipForward: currentTrack not in candidates, falling back to [0]: ${candidates[0]?.split('/').pop()}`);
        }
        return candidates[0];
    }

    if (extension_settings.audio.shuffle) {
        const availableCandidates = candidates.filter(t => t !== playbackState.currentTrack);
        const finalCandidates = availableCandidates.length > 0 ? availableCandidates : candidates;
        return finalCandidates[Math.floor(Math.random() * finalCandidates.length)];
    } else {
        // Sequential: advance to the track after the current one in the
        // candidate list (wraps to start when reaching the end).
        if (playbackState.currentTrack) {
            const currentIndex = candidates.indexOf(playbackState.currentTrack);
            if (currentIndex !== -1) {
                const nextIndex = (currentIndex + 1) % candidates.length;
                return candidates[nextIndex];
            }
        }
        // Current track not in candidates (mode/filter changed) or nothing
        // playing yet — start from the beginning.
        return candidates[0];
    }
}

export async function playTrack(trackPath) {
    if (!trackPath) return;

    debugLog(`Playing track: ${trackPath}`);

    if (playbackState.currentTrack && playbackState.currentTrack !== trackPath) {
        playbackState.previousTrack = playbackState.currentTrack;
    }

    playbackState.currentTrack = trackPath;

    const audio = $('#audio_bgm')[0];

    const pathParts = trackPath.split('/');
    const encodedPath = pathParts.map((part, index) => {
        return index === 0 ? part : encodeURIComponent(part);
    }).join('/');
    audio.src = encodedPath;
    audio.volume = extension_settings.audio.bgm_volume * 0.01;
    audio.loop = extension_settings.audio.loop_single;

    try {
        await audio.play();
        // Notify miniplayer + modal + track list to refresh
        audioEvents.dispatchEvent(new CustomEvent('nowPlayingChanged', { detail: { trackPath } }));
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error playing track:', error);

        const nextTrack = selectTrack(true);

        if (nextTrack && nextTrack !== trackPath) {
            setTimeout(() => playTrack(nextTrack), 100);
        } else {
            audio.pause();
            playbackState.currentTrack = null;
        }
    }
}

export function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ----- Transport-control handlers (used by miniplayer, slash commands, audio modal) -----

export function onSkipTrack() {
    const track = selectTrack(true);
    if (track) {
        playTrack(track);
        playbackState.cooldownTimer = extension_settings.audio.cooldown * 1000;
    }
}

export function onPreviousTrack() {
    if (playbackState.previousTrack) {
        const temp = playbackState.currentTrack;
        playTrack(playbackState.previousTrack);
        playbackState.previousTrack = temp;
    }
}
