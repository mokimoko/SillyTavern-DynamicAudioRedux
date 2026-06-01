/*
 * Emotion Detection — reads character sprite expression and drives auto-switch.
 * moduleWorker is registered on a ModuleWorkerWrapper interval from index.js.
 */

import { getContext, extension_settings } from '../../../../extensions.js';

import {
    UPDATE_INTERVAL,
    EMOTION_TAGS,
    playbackState,
    debugLog,
    isQueueActive,
} from './state.js';
import { scanTracks } from './scanner.js';
import { selectTrack, playTrack } from './player.js';
import { updateMiniplayerProgress } from './miniplayer.js';

export function detectEmotion() {
    const spriteImg = $('#expression-image').attr('src');
    if (!spriteImg) {
        return 'neutral';
    }

    const expressionName = spriteImg.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();

    if (EMOTION_TAGS.includes(expressionName)) {
        return expressionName;
    }

    const emotionMap = {
        'happy': 'joy',
        'sad': 'sadness',
        'angry': 'anger',
        'scared': 'fear',
        'surprised': 'surprise',
        'disgusted': 'disgust',
        'loving': 'love',
        'excited': 'excitement',
        'nervous': 'nervousness',
        'embarrassed': 'embarrassment',
        'proud': 'pride',
        'grateful': 'gratitude',
        'curious': 'curiosity',
        'confused': 'confusion',
        'disappointed': 'disappointment',
        'relieved': 'relief',
        'annoyed': 'annoyance',
        'amused': 'amusement',
        'caring': 'caring',
        'approving': 'approval',
        'disapproving': 'disapproval',
        'optimistic': 'optimism',
        'remorseful': 'remorse',
    };

    return emotionMap[expressionName] || 'neutral';
}

export async function moduleWorker() {
    if (!extension_settings.audio.enabled) return;

    // Check if character changed and auto-rescan
    const context = getContext();
    const currentCharacter = context.name2;
    if (currentCharacter && currentCharacter !== playbackState.lastCharacterName) {
        debugLog(`Character changed to: ${currentCharacter} - Auto-rescanning tracks...`);
        playbackState.lastCharacterName = currentCharacter;
        await scanTracks();
    }

    if (playbackState.cooldownTimer > 0) {
        playbackState.cooldownTimer -= UPDATE_INTERVAL;
    }

    // Update miniplayer progress display (modal subscribes to audio
    // timeupdate directly, so no need to push to it from here)
    updateMiniplayerProgress();

    const newEmotion = detectEmotion();
    if (newEmotion !== playbackState.currentEmotion) {
        playbackState.currentEmotion = newEmotion;
        debugLog(`Emotion changed to: ${playbackState.currentEmotion}`);

        // Don't auto-switch tracks while the user's queue is playing
        if (isQueueActive()) return;

        if (playbackState.cooldownTimer <= 0 && !extension_settings.audio.loop_single) {
            const track = selectTrack();
            if (track && track !== playbackState.currentTrack) {
                await playTrack(track);
                playbackState.cooldownTimer = extension_settings.audio.cooldown * 1000;
            }
        }
    }
}
