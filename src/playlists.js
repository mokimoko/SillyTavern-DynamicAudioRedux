/*
 * Playlists — CRUD operations and manager UI for smart + manual playlists.
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { getContext, extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';

import {
    DEBUG_PREFIX,
    EMOTION_TAGS,
    trackLibrary,
    playbackState,
    debugLog,
    debugError,
    audioEvents,
} from './state.js';
import { filterTracksByTags } from './player.js';
import { darToast, darConfirm } from './ui.js';

// ============================================================================
// Cover image upload — 300×300 JPEG thumbnail for playlist cards
// ============================================================================

const COVER_UPLOAD_FOLDER = 'dynamic_audio';
const COVER_THUMB_SIZE = 300;        // px — square thumbnail
const COVER_THUMB_QUALITY = 0.88;    // JPEG quality

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(blob);
    });
}

async function postImage(base64, format, filename) {
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: base64, format, filename, ch_name: COVER_UPLOAD_FOLDER }),
    });
    if (!response.ok) throw new Error(`Upload failed: ${await response.text()}`);
    return (await response.json()).path;
}

function safeBaseName(file) {
    const raw = (file.name || 'cover').replace(/\.[^.]+$/, '');
    return (raw.trim().replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'cover').slice(0, 50);
}

/**
 * Downscale an image to a 300×300 square JPEG thumbnail (center-cropped).
 * Uses stepped halving for quality (same approach as Story Manager).
 */
function makeCoverThumbBlob(file) {
    return new Promise((resolve) => {
        const objUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const size = COVER_THUMB_SIZE;
                // Determine crop region (center-crop to square)
                const srcSize = Math.min(img.width, img.height);
                const sx = (img.width - srcSize) / 2;
                const sy = (img.height - srcSize) / 2;

                // Draw the cropped region, stepping down for quality
                let src = document.createElement('canvas');
                src.width = srcSize;
                src.height = srcSize;
                const sctx = src.getContext('2d');
                sctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, srcSize, srcSize);

                // Step down by halves until near target
                let curSize = srcSize;
                while (curSize > size * 2) {
                    const stepSize = Math.max(size, Math.floor(curSize / 2));
                    const step = document.createElement('canvas');
                    step.width = stepSize;
                    step.height = stepSize;
                    const ctx = step.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(src, 0, 0, stepSize, stepSize);
                    src = step;
                    curSize = stepSize;
                }

                // Final draw
                const out = document.createElement('canvas');
                out.width = size;
                out.height = size;
                const cx = out.getContext('2d');
                cx.fillStyle = '#000000';
                cx.fillRect(0, 0, size, size);
                cx.imageSmoothingEnabled = true;
                cx.imageSmoothingQuality = 'high';
                cx.drawImage(src, 0, 0, size, size);

                URL.revokeObjectURL(objUrl);
                out.toBlob((blob) => resolve(blob), 'image/jpeg', COVER_THUMB_QUALITY);
            } catch (e) {
                URL.revokeObjectURL(objUrl);
                resolve(null);
            }
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
        img.src = objUrl;
    });
}

/**
 * Upload a cover image: creates a 300×300 thumbnail and also uploads the
 * full image as a fallback. Returns { coverImage, coverThumb }.
 */
async function uploadCoverImage(file) {
    const format = (file.type.split('/')[1] || 'png').toLowerCase();
    const base = `${safeBaseName(file)}_${Date.now().toString(36)}`;

    // Upload full image
    const coverImage = await postImage(await blobToBase64(file), format, base);

    // Generate and upload 300×300 thumbnail
    let coverThumb = null;
    try {
        const blob = await makeCoverThumbBlob(file);
        if (blob) coverThumb = await postImage(await blobToBase64(blob), 'jpeg', `${base}_300`);
    } catch (e) {
        debugError('cover thumbnail generation failed:', e);
    }

    return { coverImage, coverThumb: coverThumb || coverImage };
}

/**
 * Render a cover image picker inside a container element.
 * @param {Element} container - DOM element to render into
 * @param {{ coverImage: string|null, coverThumb: string|null }} current
 * @param {(v: { coverImage: string|null, coverThumb: string|null }) => void} onChange
 */
function renderCoverPicker(container, current, onChange) {
    const url = current.coverThumb || current.coverImage;

    container.innerHTML = `
        <div class="dar-cover-picker">
            <div class="dar-cover-preview ${url ? '' : 'dar-cover-empty'}">
                ${url
                    ? `<img src="${_plEsc(url)}" alt="cover">`
                    : `<i class="fa-solid fa-image"></i>`}
            </div>
            <div class="dar-cover-controls">
                <div class="dar-cover-controls-row">
                    <label class="dar-cover-upload-btn">
                        <i class="fa-solid fa-upload"></i> Upload
                        <input type="file" accept="image/*" hidden>
                    </label>
                    ${url ? `<button class="dar-cover-clear-btn" type="button">
                        <i class="fa-solid fa-xmark"></i> Remove
                    </button>` : ''}
                </div>
                <div class="dar-cover-status"></div>
            </div>
        </div>
    `;

    const status = container.querySelector('.dar-cover-status');
    const fileInput = container.querySelector('input[type="file"]');
    const clearBtn = container.querySelector('.dar-cover-clear-btn');

    const setStatus = (msg, isError = false) => {
        if (!status) return;
        status.textContent = msg || '';
        status.classList.toggle('dar-cover-error', isError);
    };

    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        setStatus('Uploading…');
        try {
            const result = await uploadCoverImage(file);
            onChange(result);
            renderCoverPicker(container, result, onChange);
        } catch (e) {
            debugError('cover upload failed:', e);
            setStatus(e.message || 'Upload failed', true);
        }
    });

    clearBtn?.addEventListener('click', () => {
        onChange({ coverImage: null, coverThumb: null });
        renderCoverPicker(container, { coverImage: null, coverThumb: null }, onChange);
    });
}

/**
 * Split cover picker — preview element and controls element are separate.
 * Used by the manual playlist editor for a more compact header layout.
 */
function renderCoverPickerSplit(previewContainer, controlsContainer, current, onChange) {
    const url = current.coverThumb || current.coverImage;

    previewContainer.innerHTML = `
        <div class="dar-cover-preview ${url ? '' : 'dar-cover-empty'}">
            ${url
                ? `<img src="${_plEsc(url)}" alt="cover">`
                : `<i class="fa-solid fa-image"></i>`}
        </div>
    `;

    controlsContainer.innerHTML = `
        <div class="dar-cover-controls-row">
            <label class="dar-cover-upload-btn">
                <i class="fa-solid fa-upload"></i> Upload
                <input type="file" accept="image/*" hidden>
            </label>
            ${url ? `<button class="dar-cover-clear-btn" type="button">
                <i class="fa-solid fa-xmark"></i> Remove
            </button>` : ''}
        </div>
        <div class="dar-cover-status"></div>
    `;

    const status = controlsContainer.querySelector('.dar-cover-status');
    const fileInput = controlsContainer.querySelector('input[type="file"]');
    const clearBtn = controlsContainer.querySelector('.dar-cover-clear-btn');

    const setStatus = (msg, isError = false) => {
        if (!status) return;
        status.textContent = msg || '';
        status.classList.toggle('dar-cover-error', isError);
    };

    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        setStatus('Uploading…');
        try {
            const result = await uploadCoverImage(file);
            onChange(result);
            renderCoverPickerSplit(previewContainer, controlsContainer, result, onChange);
        } catch (e) {
            debugError('cover upload failed:', e);
            setStatus(e.message || 'Upload failed', true);
        }
    });

    clearBtn?.addEventListener('click', () => {
        onChange({ coverImage: null, coverThumb: null });
        renderCoverPickerSplit(previewContainer, controlsContainer, { coverImage: null, coverThumb: null }, onChange);
    });
}

export function createSmartPlaylist() {
    let coverState = { coverImage: null, coverThumb: null };
    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const editor = $(`
        <div class="dar-sub-modal">
            <h3>Create Smart Playlist</h3>

            <div style="margin-bottom: 12px;">
                <label for="smart_playlist_name" style="display: block; margin-bottom: 4px;">Playlist Name</label>
                <input type="text" class="text_pole" id="smart_playlist_name" placeholder="e.g. Alice's Revenge Arc">
            </div>

            <div style="margin-bottom: 12px;">
                <label for="smart_playlist_tags" style="display: block; margin-bottom: 4px;">Base Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="smart_playlist_tags" placeholder="e.g. character:alice, arc:revenge, instrumental">
            </div>

            <div style="margin-bottom: 12px;">
                <label class="checkbox_label" for="smart_include_global">
                    <input type="checkbox" id="smart_include_global" checked>
                    <span>Include Global Tracks</span>
                </label>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 6px;">Emotion Filter</label>
                <div style="margin-left: 14px;">
                    <label class="checkbox_label">
                        <input type="radio" name="emotion_mode" value="auto" checked>
                        <span>Auto-detect from character expression</span>
                    </label><br>
                    <label class="checkbox_label">
                        <input type="radio" name="emotion_mode" value="manual">
                        <span>Manual: </span>
                    </label>
                    <select id="emotion_override" class="text_pole" style="width: auto; display: inline-block;">
                        ${EMOTION_TAGS.map(tag => `<option value="${tag}">${tag}</option>`).join('')}
                    </select><br>
                    <label class="checkbox_label">
                        <input type="radio" name="emotion_mode" value="off">
                        <span>Off (play all matching tracks)</span>
                    </label>
                </div>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px;">Cover Image</label>
                <div id="smart_cover_picker"></div>
            </div>

            <div id="smart_preview" class="dar-sub-item" style="margin-bottom: 12px; font-size: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <strong>Preview:</strong>
                    <span id="preview_count">Enter tags to preview</span>
                    <button id="toggle_preview_list" class="menu_button menu_button_icon" style="display: none;">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="preview_track_list" style="display: none; height: 130px; overflow-y: auto; padding-top: 6px; border-top: 1px solid var(--dar-border-hairline);"></div>
            </div>

            <div class="dar-sub-actions">
                <button class="menu_button" id="save_smart_playlist">
                    <i class="fa-solid fa-save"></i> Create
                </button>
                <button class="menu_button" id="cancel_smart_playlist">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    backdrop.append(editor);
    $('body').append(backdrop);

    setTimeout(() => $('#smart_playlist_name').focus(), 100);

    // Mount cover image picker
    const coverHost = document.getElementById('smart_cover_picker');
    if (coverHost) {
        renderCoverPicker(coverHost, coverState, (v) => {
            coverState = v;
        });
    }

    function updateSmartPreview() {
        const tagsInput = $('#smart_playlist_tags').val().trim();
        const emotionMode = $('input[name="emotion_mode"]:checked').val();
        const emotionOverride = $('#emotion_override').val();
        const includeGlobal = $('#smart_include_global').is(':checked');

        let tags = [];
        if (tagsInput) {
            tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
        }

        // Add emotion tag based on mode (simulating playback)
        if (emotionMode === 'auto') {
            tags.push(playbackState.currentEmotion);
        } else if (emotionMode === 'manual' && emotionOverride) {
            tags.push(emotionOverride);
        }

        if (tags.length === 0) {
            $('#preview_count').text('Select emotion mode or enter tags to preview');
            $('#toggle_preview_list').hide();
            $('#preview_track_list').hide();
            return;
        }

        const context = getContext();
        const matches = filterTracksByTags(tags, context.name2, includeGlobal);

        $('#preview_count').text(`${matches.length} tracks match`);

        if (matches.length > 0) {
            $('#toggle_preview_list').show();

            const trackListHtml = matches.map(path => {
                const metadata = trackLibrary.metadata[path] || {};
                const filename = path.split('/').pop();
                return `<div style="padding: 0.25em 0; font-size: 0.9em; opacity: 0.8;">• ${metadata.title || filename}</div>`;
            }).join('');

            $('#preview_track_list').html(trackListHtml);
        } else {
            $('#toggle_preview_list').hide();
            $('#preview_track_list').hide();
        }
    }

    $('#smart_playlist_tags').on('input', updateSmartPreview);
    $('input[name="emotion_mode"]').on('change', updateSmartPreview);
    $('#emotion_override').on('change', updateSmartPreview);
    $('#smart_include_global').on('change', updateSmartPreview);

    setTimeout(updateSmartPreview, 100);

    $('#toggle_preview_list').on('click', function() {
        const list = $('#preview_track_list');
        const icon = $(this).find('i');

        if (list.is(':visible')) {
            list.slideUp(200);
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            list.slideDown(200);
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    $('#save_smart_playlist').on('click', () => {
        const name = $('#smart_playlist_name').val().trim();
        const tagsInput = $('#smart_playlist_tags').val().trim();
        const emotionMode = $('input[name="emotion_mode"]:checked').val();
        const emotionOverride = $('#emotion_override').val();

        if (!name) {
            darToast.warn('Please enter a playlist name');
            return;
        }

        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];

        if (tags.length === 0 && emotionMode === 'off') {
            darToast.warn('Please enter at least one tag or enable emotion filtering');
            return;
        }

        extension_settings.audio.playlists[name] = {
            type: 'smart',
            tags: tags,
            emotion_mode: emotionMode,
            emotion_override: emotionMode === 'manual' ? emotionOverride : null,
            include_global: $('#smart_include_global').is(':checked'),
            coverImage: coverState.coverImage,
            coverThumb: coverState.coverThumb,
        };

        if (extension_settings.audio.debug_mode) {
            debugLog('Created smart playlist:', name, extension_settings.audio.playlists[name]);
        }
        saveSettingsDebounced();
        updatePlaylistDropdown();
        backdrop.remove();
    });

    $('#cancel_smart_playlist').on('click', () => backdrop.remove());

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            e.stopPropagation();
            backdrop.remove();
        }
    });

    editor.on('click', (e) => {
        e.stopPropagation();
    });
}

export function createManualPlaylist() {
    openManualPlaylistEditor({ isEdit: false, name: '', existingTracks: [] });
}

// ============================================================================
// SHARED MANUAL PLAYLIST EDITOR — Transfer-list (two-column) layout
// ============================================================================

function openManualPlaylistEditor({ isEdit = false, name = '', existingTracks = [], existingCover = null }) {
    // Mutable ordered list of selected track paths
    const selected = [...existingTracks];
    let availSearch = '';
    let coverState = existingCover
        ? { coverImage: existingCover.coverImage || null, coverThumb: existingCover.coverThumb || null }
        : { coverImage: null, coverThumb: null };

    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const modal = $(`
        <div class="dar-sub-modal dar-sub-modal--lg">
            <h3>${isEdit ? 'Edit' : 'Create'} Manual Playlist</h3>

            <div class="dar-mpl-header">
                <div class="dar-mpl-header-cover" id="dar_mpl_cover"></div>
                <div class="dar-mpl-header-meta">
                    <input type="text" class="text_pole" id="dar_mpl_name"
                        value="${_plEsc(name)}" placeholder="Playlist name…">
                    <div id="dar_mpl_cover_controls"></div>
                </div>
            </div>

            <div class="dar-transfer">
                <div class="dar-transfer-col">
                    <div class="dar-transfer-header">
                        <span>Available</span>
                        <span class="dar-transfer-count" id="dar_mpl_avail_count">0</span>
                    </div>
                    <div class="dar-transfer-search">
                        <input type="text" id="dar_mpl_avail_search" placeholder="Filter by name, source, or tag...">
                    </div>
                    <div class="dar-transfer-items" id="dar_mpl_avail"></div>
                </div>
                <div class="dar-transfer-col">
                    <div class="dar-transfer-header">
                        <span>Selected</span>
                        <span class="dar-transfer-count" id="dar_mpl_sel_count">0</span>
                    </div>
                    <div class="dar-transfer-items" id="dar_mpl_sel"></div>
                </div>
            </div>

            <div class="dar-sub-actions">
                <button class="menu_button" id="dar_mpl_save" style="white-space: nowrap;">
                    <i class="fa-solid fa-save"></i> ${isEdit ? 'Save Changes' : 'Create'}
                </button>
                <button class="menu_button" id="dar_mpl_cancel" style="white-space: nowrap;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    backdrop.append(modal);
    $('body').append(backdrop);
    setTimeout(() => $('#dar_mpl_name').focus(), 100);

    // Mount cover image picker (split mode: preview in one el, controls in another)
    const coverHost = document.getElementById('dar_mpl_cover');
    const controlsHost = document.getElementById('dar_mpl_cover_controls');
    if (coverHost && controlsHost) {
        renderCoverPickerSplit(coverHost, controlsHost, coverState, (v) => {
            coverState = v;
        });
    }

    // --- helpers ---

    function getAllTracks() {
        const all = [];
        Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
            tracks.forEach(t => all.push({ path: t, source: char }));
        });
        trackLibrary.global.forEach(t => all.push({ path: t, source: 'global' }));
        (trackLibrary.imported || []).forEach(t => all.push({ path: t, source: 'imported' }));
        return all;
    }

    function trackDisplay(path, source) {
        const meta = trackLibrary.metadata[path] || {};
        const filename = path.split('/').pop();
        return {
            name: meta.title || decodeURIComponent(filename.replace(/\.[^.]+$/, '')),
            source,
        };
    }

    // --- render functions ---

    function renderAvailable() {
        const $el = $('#dar_mpl_avail');
        const selSet = new Set(selected);
        const all = getAllTracks().filter(t => !selSet.has(t.path));
        const sq = availSearch.toLowerCase();
        const filtered = sq
            ? all.filter(t => {
                const d = trackDisplay(t.path, t.source);
                if (d.name.toLowerCase().includes(sq) || t.source.toLowerCase().includes(sq)) {
                    return true;
                }
                const tags = (trackLibrary.metadata[t.path] || {}).tags || [];
                return tags.some(tag => tag.toLowerCase().includes(sq));
            })
            : all;

        $('#dar_mpl_avail_count').text(filtered.length);

        if (filtered.length === 0) {
            $el.html('<div class="dar-transfer-empty">No tracks available</div>');
            return;
        }

        $el.html(filtered.map(t => {
            const d = trackDisplay(t.path, t.source);
            return `<div class="dar-transfer-item" data-path="${_plEsc(t.path)}">
                <i class="fa-solid fa-plus dar-ti-icon"></i>
                <span class="dar-ti-name">${_plEsc(d.name)}</span>
                <span class="dar-ti-source">${_plEsc(d.source)}</span>
            </div>`;
        }).join(''));
    }

    function renderSelected() {
        const $el = $('#dar_mpl_sel');
        $('#dar_mpl_sel_count').text(selected.length);

        if (selected.length === 0) {
            $el.html('<div class="dar-transfer-empty">Click tracks on the left to add them</div>');
            return;
        }

        // Build source map for display
        const sourceMap = {};
        Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
            tracks.forEach(t => { sourceMap[t] = char; });
        });
        trackLibrary.global.forEach(t => { sourceMap[t] = 'global'; });
        (trackLibrary.imported || []).forEach(t => { sourceMap[t] = 'imported'; });

        $el.html(selected.map((path, i) => {
            const d = trackDisplay(path, sourceMap[path] || '');
            return `<div class="dar-transfer-item" data-path="${_plEsc(path)}" data-index="${i}" draggable="true">
                <i class="fa-solid fa-grip-vertical dar-ti-grip"></i>
                <span class="dar-ti-name">${_plEsc(d.name)}</span>
                <i class="fa-solid fa-xmark dar-ti-icon"></i>
            </div>`;
        }).join(''));
    }

    function renderBoth() { renderAvailable(); renderSelected(); }

    renderBoth();

    // --- events: search ---

    $('#dar_mpl_avail_search').on('input', function () {
        availSearch = $(this).val().trim();
        renderAvailable();
    });

    // --- events: click to add / remove ---

    $('#dar_mpl_avail').on('click', '.dar-transfer-item', function () {
        const path = $(this).data('path');
        if (path && !selected.includes(path)) {
            selected.push(path);
            renderBoth();
        }
    });

    $('#dar_mpl_sel').on('click', '.dar-ti-icon', function (e) {
        e.stopPropagation();
        const path = $(this).closest('.dar-transfer-item').data('path');
        const idx = selected.indexOf(path);
        if (idx >= 0) {
            selected.splice(idx, 1);
            renderBoth();
        }
    });

    // --- events: drag-to-reorder on selected column ---

    let dragIdx = null;

    $('#dar_mpl_sel').on('dragstart', '.dar-transfer-item', function (e) {
        dragIdx = parseInt($(this).data('index'), 10);
        $(this).addClass('dragging');
        e.originalEvent.dataTransfer.effectAllowed = 'move';
    });

    $('#dar_mpl_sel').on('dragend', '.dar-transfer-item', function () {
        $(this).removeClass('dragging');
        $('#dar_mpl_sel .drag-over').removeClass('drag-over');
        dragIdx = null;
    });

    $('#dar_mpl_sel').on('dragover', '.dar-transfer-item', function (e) {
        e.preventDefault();
        e.originalEvent.dataTransfer.dropEffect = 'move';
        $('#dar_mpl_sel .drag-over').removeClass('drag-over');
        $(this).addClass('drag-over');
    });

    $('#dar_mpl_sel').on('drop', '.dar-transfer-item', function (e) {
        e.preventDefault();
        const dropIdx = parseInt($(this).data('index'), 10);
        if (dragIdx !== null && dragIdx !== dropIdx) {
            const [moved] = selected.splice(dragIdx, 1);
            selected.splice(dropIdx, 0, moved);
            renderSelected();
        }
        dragIdx = null;
    });

    // --- save ---

    $('#dar_mpl_save').on('click', () => {
        const newName = $('#dar_mpl_name').val().trim();

        if (!newName) {
            darToast.warn('Please enter a playlist name');
            return;
        }

        if (isEdit && newName !== name && extension_settings.audio.playlists[newName]) {
            darToast.warn(`A playlist named "${newName}" already exists`);
            return;
        }

        if (selected.length === 0) {
            darToast.warn('Please select at least one track');
            return;
        }

        // If renamed during edit, clean up old entry
        if (isEdit && newName !== name) {
            delete extension_settings.audio.playlists[name];
            if (extension_settings.audio.active_playlist === name) {
                extension_settings.audio.active_playlist = newName;
            }
        }

        extension_settings.audio.playlists[newName] = {
            type: 'manual',
            tracks: [...selected],
            coverImage: coverState.coverImage,
            coverThumb: coverState.coverThumb,
        };

        debugLog(`${isEdit ? 'Updated' : 'Created'} manual playlist: ${newName}`);
        saveSettingsDebounced();
        updatePlaylistDropdown();
        backdrop.remove();
    });

    // --- close ---

    $('#dar_mpl_cancel').on('click', () => backdrop.remove());

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) backdrop.remove();
    });
    modal.on('click', (e) => e.stopPropagation());
}

/** Minimal HTML escaper for playlist editor. */
function _plEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function editPlaylist(name) {
    const playlist = extension_settings.audio.playlists[name];

    if (playlist.type === 'smart') {
        editSmartPlaylist(name, playlist);
    } else {
        editManualPlaylist(name, playlist);
    }
}

function editSmartPlaylist(name, playlist) {
    let coverState = {
        coverImage: playlist.coverImage || null,
        coverThumb: playlist.coverThumb || null,
    };
    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const editor = $(`
        <div class="dar-sub-modal">
            <h3>Edit Smart Playlist</h3>

            <div style="margin-bottom: 12px;">
                <label for="edit_smart_playlist_name" style="display: block; margin-bottom: 4px;">Playlist Name</label>
                <input type="text" class="text_pole" id="edit_smart_playlist_name" value="${name}">
            </div>

            <div style="margin-bottom: 12px;">
                <label for="edit_smart_playlist_tags" style="display: block; margin-bottom: 4px;">Base Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="edit_smart_playlist_tags" value="${(playlist.tags || []).join(', ')}">
            </div>

            <div style="margin-bottom: 12px;">
                <label class="checkbox_label" for="edit_smart_include_global">
                    <input type="checkbox" id="edit_smart_include_global" ${playlist.include_global !== false ? 'checked' : ''}>
                    <span>Include Global Tracks</span>
                </label>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 6px;">Emotion Filter</label>
                <div style="margin-left: 14px;">
                    <label class="checkbox_label">
                        <input type="radio" name="edit_emotion_mode" value="auto" ${playlist.emotion_mode === 'auto' ? 'checked' : ''}>
                        <span>Auto-detect from character expression</span>
                    </label><br>
                    <label class="checkbox_label">
                        <input type="radio" name="edit_emotion_mode" value="manual" ${playlist.emotion_mode === 'manual' ? 'checked' : ''}>
                        <span>Manual: </span>
                    </label>
                    <select id="edit_emotion_override" class="text_pole" style="width: auto; display: inline-block;">
                        ${EMOTION_TAGS.map(tag => `<option value="${tag}" ${playlist.emotion_override === tag ? 'selected' : ''}>${tag}</option>`).join('')}
                    </select><br>
                    <label class="checkbox_label">
                        <input type="radio" name="edit_emotion_mode" value="off" ${playlist.emotion_mode === 'off' ? 'checked' : ''}>
                        <span>Off (play all matching tracks)</span>
                    </label>
                </div>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: block; margin-bottom: 4px;">Cover Image</label>
                <div id="edit_smart_cover_picker"></div>
            </div>

            <div id="edit_smart_preview" class="dar-sub-item" style="margin-bottom: 12px; font-size: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <strong>Preview:</strong>
                    <span id="edit_preview_count"></span>
                    <button id="edit_toggle_preview_list" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="edit_preview_track_list" style="display: none; height: 130px; overflow-y: auto; padding-top: 6px; border-top: 1px solid var(--dar-border-hairline);"></div>
            </div>

            <div class="dar-sub-actions">
                <button class="menu_button" id="update_smart_playlist" style="white-space: nowrap;">
                    <i class="fa-solid fa-save"></i> Save Changes
                </button>
                <button class="menu_button" id="cancel_edit_smart_playlist" style="white-space: nowrap;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    backdrop.append(editor);
    $('body').append(backdrop);

    setTimeout(() => $('#edit_smart_playlist_name').focus(), 100);

    // Mount cover image picker
    const editCoverHost = document.getElementById('edit_smart_cover_picker');
    if (editCoverHost) {
        renderCoverPicker(editCoverHost, coverState, (v) => {
            coverState = v;
        });
    }

    function updateEditPreview() {
        const tagsInput = $('#edit_smart_playlist_tags').val().trim();
        const emotionMode = $('input[name="edit_emotion_mode"]:checked').val();
        const emotionOverride = $('#edit_emotion_override').val();
        const includeGlobal = $('#edit_smart_include_global').is(':checked');

        let tags = [];
        if (tagsInput) {
            tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
        }

        if (emotionMode === 'auto') {
            tags.push(playbackState.currentEmotion);
        } else if (emotionMode === 'manual' && emotionOverride) {
            tags.push(emotionOverride);
        }

        if (tags.length === 0) {
            $('#edit_preview_count').text('Select emotion mode or enter tags to preview');
            $('#edit_toggle_preview_list').hide();
            $('#edit_preview_track_list').hide();
            return;
        }

        const context = getContext();
        const matches = filterTracksByTags(tags, context.name2, includeGlobal);

        $('#edit_preview_count').text(`${matches.length} tracks match`);

        if (matches.length > 0) {
            $('#edit_toggle_preview_list').show();

            const trackListHtml = matches.map(path => {
                const metadata = trackLibrary.metadata[path] || {};
                const filename = path.split('/').pop();
                return `<div style="padding: 0.25em 0; font-size: 0.9em; opacity: 0.8;">• ${metadata.title || filename}</div>`;
            }).join('');

            $('#edit_preview_track_list').html(trackListHtml);
        } else {
            $('#edit_toggle_preview_list').hide();
            $('#edit_preview_track_list').hide();
        }
    }

    $('input[name="edit_emotion_mode"]').on('change', updateEditPreview);
    $('#edit_emotion_override').on('change', updateEditPreview);
    $('#edit_smart_include_global').on('change', updateEditPreview);
    $('#edit_smart_playlist_tags').on('input', updateEditPreview);

    $('#edit_toggle_preview_list').on('click', function() {
        const list = $('#edit_preview_track_list');
        const icon = $(this).find('i');

        if (list.is(':visible')) {
            list.slideUp(200);
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            list.slideDown(200);
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    setTimeout(updateEditPreview, 100);

    $('#update_smart_playlist').on('click', () => {
        const newName = $('#edit_smart_playlist_name').val().trim();
        const tagsInput = $('#edit_smart_playlist_tags').val().trim();
        const emotionMode = $('input[name="edit_emotion_mode"]:checked').val();
        const emotionOverride = $('#edit_emotion_override').val();

        if (!newName) {
            darToast.warn('Please enter a playlist name');
            return;
        }

        if (newName !== name && extension_settings.audio.playlists[newName]) {
            darToast.warn(`A playlist named "${newName}" already exists`);
            return;
        }

        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];

        if (tags.length === 0 && emotionMode === 'off') {
            darToast.warn('Please enter at least one tag or enable emotion filtering');
            return;
        }

        const playlistData = {
            type: 'smart',
            tags: tags,
            emotion_mode: emotionMode,
            emotion_override: emotionMode === 'manual' ? emotionOverride : null,
            include_global: $('#edit_smart_include_global').is(':checked'),
            coverImage: coverState.coverImage,
            coverThumb: coverState.coverThumb,
        };

        if (newName !== name) {
            delete extension_settings.audio.playlists[name];

            if (extension_settings.audio.active_playlist === name) {
                extension_settings.audio.active_playlist = newName;
            }
        }

        extension_settings.audio.playlists[newName] = playlistData;

        saveSettingsDebounced();
        updatePlaylistDropdown();
        backdrop.remove();
    });

    $('#cancel_edit_smart_playlist').on('click', () => backdrop.remove());

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            e.stopPropagation();
            backdrop.remove();
        }
    });

    editor.on('click', (e) => {
        e.stopPropagation();
    });
}

function editManualPlaylist(name, playlist) {
    openManualPlaylistEditor({
        isEdit: true,
        name,
        existingTracks: [...(playlist.tracks || [])],
        existingCover: {
            coverImage: playlist.coverImage || null,
            coverThumb: playlist.coverThumb || null,
        },
    });
}

// ============================================================================
// DROPDOWN + EXTERNAL CREATE HELPERS (used by playlist-from-chat)
// ============================================================================

// Notify any UI listening for playlist changes (new modal Playlists tab,
// Playback tab playlist card grid, etc.). Kept as a named function so its
// many callers across playlists.js / playlistFromChat.js / slashCommands.js
// don't have to be rewritten — they all want "playlists just changed, please
// re-render".
export function updatePlaylistDropdown() {
    audioEvents.dispatchEvent(new CustomEvent('playlistsChanged'));
}

export function createSmartPlaylistFromTags(name, tags, characterName = null) {
    if (!name || tags.length === 0) {
        debugError('Invalid playlist parameters');
        return false;
    }

    extension_settings.audio.playlists[name] = {
        type: 'smart',
        tags: tags,
        emotion_mode: 'off', // Created from chat, no additional emotion filtering
        emotion_override: null,
        include_global: true
    };

    saveSettingsDebounced();
    updatePlaylistDropdown();

    debugLog(`Created smart playlist: ${name}`);
    return true;
}

export function createManualPlaylistFromTracks(name, tracks) {
    if (!name || !tracks || tracks.length === 0) {
        debugError('Invalid playlist parameters');
        return false;
    }

    extension_settings.audio.playlists[name] = {
        type: 'manual',
        tracks: tracks
    };

    saveSettingsDebounced();
    updatePlaylistDropdown();

    debugLog(`Created manual playlist: ${name} with ${tracks.length} tracks`);
    return true;
}
