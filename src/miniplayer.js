/*
 * Miniplayer — floating compact player.
 *
 * Free-form draggable widget anchored to viewport. Lives at z-index 1000
 * so it sits above chat content but below all SillyTavern drawers, panels,
 * popup dialogs, and toastr (which use 3000-10000+). Opening any ST drawer
 * or our own audio modal cleanly covers it.
 *
 * Position model:
 *   - extension_settings.audio.miniplayer_x / miniplayer_y (px coords)
 *   - null/undefined means "use default" (bottom-right with 20px gap)
 *   - Updated on drag-end; cleared to null by the "Reset position" button
 *
 * Snap-to-edges:
 *   - extension_settings.audio.miniplayer_snap_to_edges (boolean)
 *   - Left/right edges only (top/bottom skipped to avoid the chat input
 *     area and topbar)
 *
 * Input: pointer events (mouse + touch + pen in one API) with
 * setPointerCapture so drag tracks even when the pointer leaves the
 * element. Buttons and the progress bar opt out of drag.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

import { playbackState, audioEvents, debugLog } from './state.js';
import { onSkipTrack } from './player.js';
import { openAudioModal } from './audioModal.js';
import { showVolumePopup, hideVolumePopup } from './ui.js';

// ---- Layout constants ------------------------------------------------
const MP_WIDTH = 170;         // matches .dar-miniplayer width in style.css
const EDGE_GAP = 20;          // default px gap from viewport edges
const SNAP_THRESHOLD = 20;    // snap if pointer within this many px of an edge
const SNAP_GAP = 8;           // px gap from edge after snapping

// Drag state (module-scoped). Null when not dragging.
let dragState = null;

// ---- Construction ----------------------------------------------------

export function createMiniplayer() {
    if (document.getElementById('audio_miniplayer')) {
        return; // Already exists
    }

    const mp = document.createElement('div');
    mp.id = 'audio_miniplayer';
    mp.className = 'dar-miniplayer';
    mp.innerHTML = `
        <div class="dar-miniplayer-label">drag me anywhere</div>
        <div class="dar-miniplayer-controls">
            <button class="dar-mp-btn" id="miniplayer_mute" title="Mute/Unmute" type="button">
                <i class="fa-solid fa-volume-high" id="miniplayer_mute_icon"></i>
            </button>
            <div class="dar-mp-progress" id="miniplayer_progress">
                <div class="dar-mp-progress-fill" id="miniplayer_progress_fill"></div>
            </div>
            <button class="dar-mp-btn" id="miniplayer_next" title="Next track" type="button">
                <i class="fa-solid fa-forward"></i>
            </button>
            <button class="dar-mp-btn" id="miniplayer_settings" title="Open audio settings" type="button">
                <i class="fa-solid fa-gear"></i>
            </button>
        </div>
    `;

    document.body.appendChild(mp);

    wireMiniplayerControls(mp);
    wireMiniplayerDrag(mp);

    updateMiniplayerPosition();
    updateMiniplayerContent();
    updateMiniplayerProgress();
}

// ---- Control wiring --------------------------------------------------

function wireMiniplayerControls(mp) {
    // Next track
    mp.querySelector('#miniplayer_next').addEventListener('click', onSkipTrack);

    // Settings → open the audio modal (direct import from audioModal.js).
    mp.querySelector('#miniplayer_settings').addEventListener('click', () => {
        openAudioModal();
    });

    // Mute toggle
    mp.querySelector('#miniplayer_mute').addEventListener('click', () => {
        const muted = !extension_settings.audio.bgm_muted;
        extension_settings.audio.bgm_muted = muted;

        const audioEl = document.getElementById('audio_bgm');
        if (audioEl) audioEl.muted = muted;

        applyVolumeIcon();
        saveSettingsDebounced();
    });

    // Volume popup on hover
    const muteBtn = mp.querySelector('#miniplayer_mute');
    muteBtn.addEventListener('mouseenter', () => {
        showVolumePopup(muteBtn, {
            value: extension_settings.audio.bgm_volume ?? 50,
            onChange: onVolumeSliderChange,
        });
    });
    muteBtn.addEventListener('mouseleave', () => {
        hideVolumePopup();
    });

    // Click-to-seek on progress bar (matches now-playing scrubber pattern in audioModal.js).
    const progress = mp.querySelector('#miniplayer_progress');
    progress.addEventListener('click', (e) => {
        const audio = document.getElementById('audio_bgm');
        if (!audio || !audio.duration || !isFinite(audio.duration)) return;
        const rect = progress.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = pct * audio.duration;
    });
}

// ---- Drag wiring -----------------------------------------------------

function wireMiniplayerDrag(mp) {
    mp.addEventListener('pointerdown', (e) => {
        // Buttons and the progress bar handle their own interactions.
        if (e.target.closest('button')) return;
        if (e.target.closest('.dar-mp-progress')) return;
        // Mouse: left button only. Touch/pen: pointerType !== 'mouse', allow.
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        const rect = mp.getBoundingClientRect();
        dragState = {
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            pointerId: e.pointerId,
            moved: false,
        };
        try {
            mp.setPointerCapture(e.pointerId);
        } catch (err) {
            // Some browsers/devices throw on setPointerCapture; non-fatal.
            debugLog(`setPointerCapture failed: ${err.message}`);
        }
        mp.style.transition = 'none';
        mp.classList.add('dar-miniplayer--dragging');
        e.preventDefault();
    });

    mp.addEventListener('pointermove', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;

        const x = e.clientX - dragState.offsetX;
        const y = e.clientY - dragState.offsetY;
        const clamped = clampToViewport(x, y, mp);

        mp.style.left = clamped.x + 'px';
        mp.style.top = clamped.y + 'px';
        mp.style.right = 'auto';
        mp.style.bottom = 'auto';
        dragState.moved = true;
    });

    const endDrag = (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        try {
            mp.releasePointerCapture(e.pointerId);
        } catch { /* ignore — capture may already be lost */ }

        mp.style.transition = '';
        mp.classList.remove('dar-miniplayer--dragging');

        if (dragState.moved) {
            const rect = mp.getBoundingClientRect();
            let finalX = rect.left;
            let finalY = rect.top;

            // Snap to left/right edges if enabled and pointer is close.
            // Top/bottom intentionally skipped — keeps miniplayer out of the
            // ST chat input area at the bottom and the topbar at the top.
            if (extension_settings.audio.miniplayer_snap_to_edges !== false) {
                if (rect.left <= SNAP_THRESHOLD) {
                    finalX = SNAP_GAP;
                } else if ((window.innerWidth - rect.right) <= SNAP_THRESHOLD) {
                    finalX = window.innerWidth - rect.width - SNAP_GAP;
                }
            }

            const clamped = clampToViewport(finalX, finalY, mp);
            mp.style.left = clamped.x + 'px';
            mp.style.top = clamped.y + 'px';

            extension_settings.audio.miniplayer_x = clamped.x;
            extension_settings.audio.miniplayer_y = clamped.y;
            saveSettingsDebounced();
            debugLog(`Miniplayer position saved: (${clamped.x}, ${clamped.y})`);
        }
        dragState = null;
    };

    mp.addEventListener('pointerup', endDrag);
    mp.addEventListener('pointercancel', endDrag);
}

// ---- Geometry helpers ------------------------------------------------

function clampToViewport(x, y, mp) {
    const width = mp.offsetWidth || MP_WIDTH;
    const height = mp.offsetHeight || 32;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return {
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY)),
    };
}

// ---- Public API: position, content, progress, visibility -------------

export function updateMiniplayerPosition() {
    const mp = document.getElementById('audio_miniplayer');
    if (!mp) return;

    let x = extension_settings.audio.miniplayer_x;
    let y = extension_settings.audio.miniplayer_y;

    // First-time / post-reset default: bottom-right with EDGE_GAP.
    // We do NOT save these defaults — leaving x/y null lets the default
    // re-evaluate on window resize, which is the desired behavior.
    if (x == null || y == null) {
        const width = mp.offsetWidth || MP_WIDTH;
        const height = mp.offsetHeight || 32;
        x = window.innerWidth - width - EDGE_GAP;
        y = window.innerHeight - height - EDGE_GAP;
    }

    const clamped = clampToViewport(x, y, mp);
    mp.style.left = clamped.x + 'px';
    mp.style.top = clamped.y + 'px';
    mp.style.right = 'auto';
    mp.style.bottom = 'auto';
}

export function updateMiniplayerContent() {
    // Currently only volume/mute state; track-info updates may come later.
    applyVolumeIcon();
}

export function updateMiniplayerProgress() {
    const fill = document.getElementById('miniplayer_progress_fill');
    if (!fill || playbackState.isSeeking) return;

    const audio = document.getElementById('audio_bgm');
    if (!audio || !audio.duration || !isFinite(audio.duration)) {
        fill.style.width = '0%';
        return;
    }

    const pct = (audio.currentTime / audio.duration) * 100;
    fill.style.width = pct + '%';
}

export function updateMiniplayerVisibility() {
    const shouldShow = !!(extension_settings.audio.miniplayer_enabled && extension_settings.audio.enabled);

    if (shouldShow) {
        if (!document.getElementById('audio_miniplayer')) {
            createMiniplayer();
        }
        const mp = document.getElementById('audio_miniplayer');
        if (mp) mp.style.display = '';
    } else {
        const mp = document.getElementById('audio_miniplayer');
        if (mp) mp.style.display = 'none';
    }

    audioEvents.dispatchEvent(new CustomEvent('miniplayerVisibilityChanged', {
        detail: { visible: shouldShow },
    }));
}

// ---- Internals -------------------------------------------------------

/** Sync the mute-button icon (and the old drawer icon during coexistence). */
function applyVolumeIcon() {
    const volume = extension_settings.audio.bgm_volume;
    let icon;
    if (extension_settings.audio.bgm_muted || volume === 0) {
        icon = 'fa-volume-mute';
    } else if (volume < 50) {
        icon = 'fa-volume-low';
    } else {
        icon = 'fa-volume-high';
    }

    const mpIcon = document.getElementById('miniplayer_mute_icon');
    if (mpIcon) {
        mpIcon.classList.remove('fa-volume-high', 'fa-volume-low', 'fa-volume-mute');
        mpIcon.classList.add(icon);
    }
}

/**
 * Callback for the shared volume popup slider. Updates the volume setting,
 * applies it to the <audio> element, auto-unmutes if the user drags above 0,
 * and saves.
 */
function onVolumeSliderChange(vol) {
    extension_settings.audio.bgm_volume = vol;

    const audioEl = document.getElementById('audio_bgm');
    if (audioEl) {
        audioEl.volume = vol / 100;
        // Auto-unmute when the user actively raises volume from the slider
        if (vol > 0 && extension_settings.audio.bgm_muted) {
            extension_settings.audio.bgm_muted = false;
            audioEl.muted = false;
        }
    }

    applyVolumeIcon();
    saveSettingsDebounced();
}

// ---- Event subscriptions ---------------------------------------------

// Refresh mute icon on track changes (in case track-specific volume logic
// is ever added; also keeps the icon in sync if other modules toggle mute).
audioEvents.addEventListener('nowPlayingChanged', () => {
    updateMiniplayerContent();
});

// Keep the volume icon in sync when volume/mute is changed elsewhere
// (e.g. from the modal's volume popup or slider).
const _bgmAudio = document.getElementById('audio_bgm');
if (_bgmAudio) {
    _bgmAudio.addEventListener('volumechange', () => applyVolumeIcon());
}

// Re-clamp position when the viewport changes so the miniplayer never
// ends up off-screen after a resize.
window.addEventListener('resize', () => {
    updateMiniplayerPosition();
});
