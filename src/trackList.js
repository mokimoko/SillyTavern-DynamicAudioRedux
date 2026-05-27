/*
 * Track List — track editor modal + metadata migration UI.
 *
 * Library rendering and bulk operations live in audioModal.js; this module
 * owns the per-track edit modal and the rename-detection migration tool.
 */

import {
    EMOTION_TAGS,
    trackLibrary,
} from './state.js';
import { saveMetadata, cleanFilename } from './scanner.js';
import { darToast } from './ui.js';

// ============================================================================
// METADATA MIGRATION
// ============================================================================

export function fuzzyMatch(str1, str2) {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    const set1 = new Set(s1.split(''));
    const set2 = new Set(s2.split(''));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
}

export function migrateMetadata() {
    // Get all current tracks
    const currentTracks = [
        ...trackLibrary.global,
        ...Object.values(trackLibrary.character).flat()
    ];

    // Find orphaned metadata (metadata for tracks that don't exist anymore)
    const orphanedMetadata = {};
    Object.keys(trackLibrary.metadata).forEach(path => {
        if (!currentTracks.includes(path)) {
            orphanedMetadata[path] = trackLibrary.metadata[path];
        }
    });

    if (Object.keys(orphanedMetadata).length === 0) {
        return 'No orphaned metadata found. All tracks are accounted for!';
    }

    // Find potential matches
    const suggestions = [];
    Object.entries(orphanedMetadata).forEach(([oldPath, metadata]) => {
        const oldFilename = oldPath.split('/').pop();

        let bestMatch = null;
        let bestScore = 0;

        currentTracks.forEach(newPath => {
            // Skip if this track already has metadata
            if (trackLibrary.metadata[newPath]) return;

            const newFilename = newPath.split('/').pop();
            const score = fuzzyMatch(oldFilename, newFilename);

            if (score > bestScore && score > 0.3) {
                bestScore = score;
                bestMatch = newPath;
            }
        });

        if (bestMatch) {
            suggestions.push({
                oldPath,
                newPath: bestMatch,
                oldFilename,
                newFilename: bestMatch.split('/').pop(),
                metadata,
                score: bestScore
            });
        }
    });

    if (suggestions.length === 0) {
        return `Found ${Object.keys(orphanedMetadata).length} orphaned metadata entries, but couldn't find good matches. You may need to manually re-tag these tracks.`;
    }

    showMigrationUI(suggestions, orphanedMetadata);
    return '';
}

export function showMigrationUI(suggestions, orphanedMetadata) {
    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const migrationUI = $(`
        <div class="dar-sub-modal dar-sub-modal--lg">
            <h3>Migrate Track Metadata</h3>
            <p>Found ${suggestions.length} potential matches for renamed tracks. 
                Review and confirm the migrations below.</p>

            <div id="migration_list" class="dar-sub-list"></div>

            <div class="dar-sub-actions">
                <button class="menu_button" id="migrate_selected">
                    <i class="fa-solid fa-check"></i> Migrate Selected
                </button>
                <button class="menu_button" id="cancel_migration">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    const list = migrationUI.find('#migration_list');

    suggestions.forEach((suggestion, index) => {
        const tags = suggestion.metadata.tags || [];
        const title = suggestion.metadata.title || '';
        const confidence = Math.round(suggestion.score * 100);

        const item = $(`
            <div class="dar-sub-item">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                    <input type="checkbox" class="migration-checkbox" data-index="${index}" checked style="cursor: pointer;">
                    <div style="flex: 1;">
                        <div style="font-size: 12px;">
                            <span style="color: #ff6b6b;">${suggestion.oldFilename}</span> → <span style="color: #51cf66;">${suggestion.newFilename}</span>
                        </div>
                        <div style="font-size: 10px; opacity: 0.5; margin-top: 2px;">
                            Match confidence: ${confidence}%
                        </div>
                    </div>
                </div>
                ${title ? `<div style="font-size: 12px; margin-left: 22px;"><strong>Title:</strong> ${title}</div>` : ''}
                ${tags.length > 0 ? `<div style="font-size: 12px; margin-left: 22px;"><strong>Tags:</strong> ${tags.join(', ')}</div>` : ''}
            </div>
        `);

        list.append(item);
    });

    backdrop.append(migrationUI);
    $('body').append(backdrop);

    $('#migrate_selected').on('click', () => {
        let migratedCount = 0;

        $('.migration-checkbox:checked').each(function() {
            const index = $(this).data('index');
            const suggestion = suggestions[index];

            // Copy metadata to new path
            trackLibrary.metadata[suggestion.newPath] = { ...suggestion.metadata };

            // Remove old metadata
            delete trackLibrary.metadata[suggestion.oldPath];

            migratedCount++;
        });

        if (migratedCount > 0) {
            saveMetadata();
            darToast.success(`Successfully migrated metadata for ${migratedCount} track(s)!`);
        }

        backdrop.remove();
    });

    $('#cancel_migration').on('click', () => {
        backdrop.remove();
    });

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            e.stopPropagation();
            backdrop.remove();
        }
    });

    migrationUI.on('click', (e) => {
        e.stopPropagation();
    });
}

// ============================================================================
// TRACK EDITOR MODAL
// ============================================================================

export function openTrackEditor(trackPath) {
    const metadata = trackLibrary.metadata[trackPath] || { tags: [], title: '' };
    const filename = trackPath.split('/').pop();

    // Separate instrumental, emotions, and other tags
    const isInstrumental = (metadata.tags || []).includes('instrumental');
    const emotionTags = (metadata.tags || []).filter(t => EMOTION_TAGS.includes(t));
    const otherTags = (metadata.tags || []).filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));

    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const emotionCheckboxes = EMOTION_TAGS.map(emotion => {
        const checked = emotionTags.includes(emotion);
        return `
            <label class="checkbox_label" style="display: flex; align-items: center; width: 32%; margin: 2px 0; font-size: 12px; gap: 4px;">
                <input type="checkbox" class="emotion-checkbox" value="${emotion}" ${checked ? 'checked' : ''} style="margin: 0;">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${emotion}</span>
            </label>
        `;
    }).join('');

    const editor = $(`
        <div class="dar-sub-modal">
            <h3>Edit Track</h3>
            <p style="font-style: italic;">File: ${filename}</p>

            <div style="margin-bottom: 12px;">
                <label for="track_title" style="display: block; margin-bottom: 4px;">Display Name</label>
                <div style="display: flex; gap: 6px;">
                    <input type="text" class="text_pole" id="track_title" value="${metadata.title || ''}" placeholder="Custom display name (leave empty to use filename)" style="flex: 1;">
                    <button class="menu_button menu_button_icon" id="clean_filename" title="Auto-clean filename">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
                </div>
                <small style="opacity: 0.7; font-size: 11px;">This is how the track will appear in lists and the miniplayer</small>
            </div>

            <div style="margin-bottom: 12px;">
                <label class="checkbox_label" for="track_instrumental">
                    <input type="checkbox" id="track_instrumental" ${isInstrumental ? 'checked' : ''}>
                    <span>Instrumental (no vocals)</span>
                </label>
            </div>

            <div style="margin-bottom: 12px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                    <label style="margin: 0;">Emotions (select all that apply)</label>
                    <button class="menu_button menu_button_icon" id="toggle_emotions" title="Show/hide emotions">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="emotion_selector" class="dar-sub-item" style="display: none; max-height: 200px; overflow-y: auto;">
                    <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                        ${emotionCheckboxes}
                    </div>
                </div>
                <div id="selected_emotions" style="margin-top: 6px; font-size: 12px; opacity: 0.8;">
                    ${emotionTags.length > 0 ? `Selected: ${emotionTags.join(', ')}` : 'No emotions selected'}
                </div>
            </div>

            <div style="margin-bottom: 12px;">
                <label for="track_tags" style="display: block; margin-bottom: 4px;">Other Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="track_tags" value="${otherTags.join(', ')}" placeholder="e.g. action, ambient, battle, romance">
                <small style="opacity: 0.7; font-size: 11px;">For non-emotion descriptors</small>
            </div>

            <div class="dar-sub-actions" style="margin-top: 14px;">
                <button class="menu_button" id="save_track">
                    <i class="fa-solid fa-save"></i> Save
                </button>
                <button class="menu_button" id="cancel_track">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    backdrop.append(editor);
    $('body').append(backdrop);

    setTimeout(() => $('#track_title').focus(), 100);

    // Auto-expand emotions if any are selected
    if (emotionTags.length > 0) {
        $('#emotion_selector').show();
        $('#toggle_emotions i').removeClass('fa-chevron-down').addClass('fa-chevron-up');
    }

    // Toggle emotion selector
    $('#toggle_emotions').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const selector = $('#emotion_selector');
        const icon = $('#toggle_emotions i');

        if (selector.is(':visible')) {
            selector.slideUp(200);
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            selector.slideDown(200);
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });

    // Update selected emotions display when checkboxes change
    $('.emotion-checkbox').on('change', () => {
        const selected = [];
        $('.emotion-checkbox:checked').each(function() {
            selected.push($(this).val());
        });

        $('#selected_emotions').text(
            selected.length > 0 ? `Selected: ${selected.join(', ')}` : 'No emotions selected'
        );
    });

    $('#clean_filename').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cleaned = cleanFilename(filename);
        $('#track_title').val(cleaned);
    });

    $('#save_track').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const title = $('#track_title').val().trim();
        const isInstrumental = $('#track_instrumental').is(':checked');

        // Collect selected emotions
        const selectedEmotions = [];
        $('.emotion-checkbox:checked').each(function() {
            selectedEmotions.push($(this).val());
        });

        // Collect other tags
        let otherTags = $('#track_tags').val().split(',').map(t => t.trim()).filter(Boolean);

        // Combine all tags: instrumental (if checked) + emotions + other tags
        let allTags = [];
        if (isInstrumental) {
            allTags.push('instrumental');
        }
        allTags.push(...selectedEmotions);
        allTags.push(...otherTags);

        trackLibrary.metadata[trackPath] = { title, tags: allTags };
        saveMetadata();
        backdrop.remove();
    });

    $('#cancel_track').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        backdrop.remove();
    });

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            e.stopPropagation();
            backdrop.remove();
        }
    });

    $(document).on('keydown.trackEditor', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            backdrop.remove();
            $(document).off('keydown.trackEditor');
        }
    });

    editor.on('click', (e) => {
        e.stopPropagation();
    });
}
