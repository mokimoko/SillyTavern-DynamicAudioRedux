/*
 * Auto-Tag - AI-powered automatic track tagging
 * Part of Dynamic Audio Redux extension
 */

import { getContext, extension_settings } from '../../../../extensions.js';
import { generateRaw } from '../../../../../script.js';
import { trackLibrary, EMOTION_TAGS } from './state.js';
import { saveMetadata } from './scanner.js';
import { darToast } from './ui.js';

const DEBUG_PREFIX = '<Audio-AutoTag>';

// Debug-gated error logging. The user already sees these failures via a toast,
// so keep them out of the console unless debug_mode is on.
const debugError = (...args) => {
    if (extension_settings?.audio?.debug_mode) console.error(DEBUG_PREFIX, ...args);
};

export class AutoTag {
    constructor(trackLibrary, extension_settings, saveMetadata, EMOTION_TAGS, generateRaw) {
        this.trackLibrary = trackLibrary;
        this.extension_settings = extension_settings;
        this.saveMetadata = saveMetadata;
        this.EMOTION_TAGS = EMOTION_TAGS;
        this.generateRaw = generateRaw;
    }
    
    debugLog(msg) {
        if (this.extension_settings?.audio?.debug_mode) {
            console.log(DEBUG_PREFIX, msg);
        }
    }
    
    /**
     * Get all untagged tracks
     */
    getUntaggedTracks() {
        const allTracks = [
            ...this.trackLibrary.global,
            ...Object.values(this.trackLibrary.character).flat()
        ];
        
        return allTracks.filter(path => {
            const metadata = this.trackLibrary.metadata[path];
            return !metadata || !metadata.tags || metadata.tags.length === 0;
        });
    }
    
    /**
     * Send tracks to AI for tagging suggestions
     */
    async getAITagSuggestions(tracks) {
        this.debugLog(`Requesting AI tags for ${tracks.length} tracks...`);
        
        // Build track list for AI
        const trackNames = tracks.map(path => {
            const metadata = this.trackLibrary.metadata[path] || {};
            const filename = path.split('/').pop();
            return metadata.title || filename;
        });
        
        // Build prompt
        const messages = [];
        
        // System prompt
        messages.push({
            role: 'system',
            content: `You are tagging music tracks. For each track, suggest relevant tags based on the track name.

        Available EMOTION tags: ${this.EMOTION_TAGS.join(', ')}

        Tag Guidelines:
        - Use emotion tags when the mood is clear from the name
        - Add "instrumental" if you think the track has no vocals
        - Add descriptive tags like: battle, romance, ambient, intense, gentle, upbeat, slow, dramatic, epic, peaceful, dark, hopeful, mysterious, action, suspense, etc.
        - If you recognize a song title, use your knowledge to tag it appropriately
        - Skip tracks where you cannot determine appropriate tags with confidence

        CRITICAL: Format each track EXACTLY like this (use bullet points):
        - Track Name Here: tag1, tag2, tag3, tag4
        - Another Track: instrumental, calm, peaceful

        Use 2-5 tags per track. Only list tracks you can confidently tag.`
        });
        
        // User message with track list
        let trackListMessage = `Tag these tracks:\n\n`;
        trackNames.forEach((name, idx) => {
            trackListMessage += `${idx + 1}. ${name}\n`;
        });

        trackListMessage += `\nRemember: Use the exact format with bullet points (•) and colons (:)`;

        messages.push({
            role: 'user',
            content: trackListMessage
        });
        
        try {
            const result = await this.generateRaw({
                prompt: messages,
                trimNames: false
            });
            
            if (!result || !result.trim()) {
                throw new Error('Empty response from AI');
            }
            
            this.debugLog('AI response received');
            this.debugLog('Raw AI response:\n' + result); // Log full response for debugging
            
            // Extract tags using multiple regex patterns to be more forgiving
            const suggestions = new Map();
            
            // Pattern 1: Bullet point with colon (• Track Name: tags)
            let trackRegex = /[•\-\*]\s*([^:]+):\s*([^\n]+)/g;
            let match;
            
            while ((match = trackRegex.exec(result)) !== null) {
                const trackName = match[1].trim();
                const tagsString = match[2].trim();
                const tags = tagsString.split(',').map(t => t.trim()).filter(Boolean);
                
                if (trackName && tags.length > 0) {
                    suggestions.set(trackName, tags);
                }
            }
            
            // Pattern 2: Numbered list (1. Track Name: tags)
            if (suggestions.size === 0) {
                this.debugLog('Trying numbered list pattern...');
                trackRegex = /^\d+\.\s*([^:]+):\s*([^\n]+)/gm;
                
                while ((match = trackRegex.exec(result)) !== null) {
                    const trackName = match[1].trim();
                    const tagsString = match[2].trim();
                    const tags = tagsString.split(',').map(t => t.trim()).filter(Boolean);
                    
                    if (trackName && tags.length > 0) {
                        suggestions.set(trackName, tags);
                    }
                }
            }
            
            // Pattern 3: Just track name on one line, tags on next (fallback)
            if (suggestions.size === 0) {
                this.debugLog('Trying multi-line pattern...');
                trackRegex = /^(.+?)\n\s*(?:Tags?:|-)?\s*(.+?)$/gm;
                
                while ((match = trackRegex.exec(result)) !== null) {
                    const trackName = match[1].trim();
                    const tagsString = match[2].trim();
                    
                    // Skip if it looks like headers or other content
                    if (trackName.toLowerCase().includes('track') && trackName.toLowerCase().includes('tags')) {
                        continue;
                    }
                    
                    const tags = tagsString.split(',').map(t => t.trim()).filter(Boolean);
                    
                    if (trackName && tags.length > 0 && tags.length <= 10) {
                        suggestions.set(trackName, tags);
                    }
                }
            }
            
            this.debugLog(`Extracted ${suggestions.size} tracks from AI response`);
            
            if (suggestions.size === 0) {
                throw new Error('Could not extract any tags from AI response. Check console for raw response.');
            }
            
            this.debugLog(`AI suggested tags for ${suggestions.size} tracks`);
            
            // Map track names back to paths
            const taggedTracks = [];
            tracks.forEach(path => {
                const metadata = this.trackLibrary.metadata[path] || {};
                const filename = path.split('/').pop();
                const trackName = metadata.title || filename;
                
                // Try to find match in suggestions
                let matchedTags = null;
                for (const [suggestedName, tags] of suggestions.entries()) {
                    if (trackName.toLowerCase() === suggestedName.toLowerCase() ||
                        trackName.toLowerCase().includes(suggestedName.toLowerCase()) ||
                        suggestedName.toLowerCase().includes(trackName.toLowerCase())) {
                        matchedTags = tags;
                        break;
                    }
                }
                
                if (matchedTags) {
                    taggedTracks.push({
                        path,
                        trackName,
                        tags: matchedTags
                    });
                }
            });
            
            return taggedTracks;
            
        } catch (error) {
            debugError('AI tagging failed:', error);
            throw error;
        }
    }
    
    /**
     * Show preview modal with suggested tags
     */
    showPreviewModal(taggedTracks, onApply) {
        const backdrop = $('<div class="dar-sub-backdrop"></div>');
        
        const modal = $(`
            <div class="dar-sub-modal dar-sub-modal--lg">
                <h3>Review AI Tag Suggestions</h3>
                <p>AI suggested tags for ${taggedTracks.length} tracks. Review and edit before applying.</p>
                
                <div id="tag_preview_list" class="dar-sub-list"></div>
                
                <div class="dar-sub-actions">
                    <button class="menu_button" id="apply_all_tags" style="background: rgba(81, 207, 102, 0.2);">
                        <i class="fa-solid fa-check"></i> Apply All Tags
                    </button>
                    <button class="menu_button" id="cancel_tag_preview">
                        <i class="fa-solid fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        `);
        
        const list = modal.find('#tag_preview_list');
        
        // Build editable tag list
        taggedTracks.forEach((item, index) => {
            const trackItem = $(`
                <div class="dar-sub-item" data-index="${index}">
                    <div style="font-weight: 500; margin-bottom: 6px;">${item.trackName}</div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <label>Tags:</label>
                        <input type="text" class="text_pole tag-input" value="${item.tags.join(', ')}" style="flex: 1;" data-index="${index}">
                    </div>
                </div>
            `);
            
            list.append(trackItem);
        });
        
        backdrop.append(modal);
        $('body').append(backdrop);
        
        // Apply tags handler
        $('#apply_all_tags').on('click', () => {
            // Collect edited tags
            const finalTags = [];
            
            $('.tag-input').each(function() {
                const index = $(this).data('index');
                const tagsString = $(this).val().trim();
                const tags = tagsString.split(',').map(t => t.trim()).filter(Boolean);
                
                if (tags.length > 0) {
                    finalTags.push({
                        path: taggedTracks[index].path,
                        tags: tags
                    });
                }
            });
            
            // Apply tags
            finalTags.forEach(({ path, tags }) => {
                this.trackLibrary.metadata[path] = {
                    ...(this.trackLibrary.metadata[path] || {}),
                    tags: tags
                };
            });
            
            this.saveMetadata();
            
            if (onApply) {
                onApply(finalTags.length);
            }
            
            backdrop.remove();
        });
        
        $('#cancel_tag_preview').on('click', () => {
            backdrop.remove();
        });
        
        backdrop.on('click', (e) => {
            if (e.target === backdrop[0]) {
                backdrop.remove();
            }
        });
        
        modal.on('click', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * Open the auto-tag modal
     */
    openModal(preselectedTracks = []) {
        const untaggedTracks = this.getUntaggedTracks();
        
        if (untaggedTracks.length === 0) {
            darToast.info('No untagged tracks found! All tracks already have tags.');
            return;
        }
        
        // Determine which tracks to offer
        let availableTracks;
        let sourceMessage;
        
        if (preselectedTracks.length > 0) {
            // Filter preselected to only untagged ones
            availableTracks = preselectedTracks.filter(path => untaggedTracks.includes(path));
            
            if (availableTracks.length === 0) {
                darToast.info('Selected tracks are already tagged!');
                return;
            }
            
            sourceMessage = `Found ${availableTracks.length} untagged tracks in your selection.`;
        } else {
            availableTracks = untaggedTracks;
            sourceMessage = `Found ${availableTracks.length} untagged tracks in your library.`;
        }
        
        const backdrop = $('<div class="dar-sub-backdrop"></div>');
        
        const modal = $(`
            <div class="dar-sub-modal">
                <h3>Auto-Tag Tracks</h3>
                <p>${sourceMessage}</p>
                <p>How many tracks would you like to tag in this batch?</p>
                
                <div class="dar-sub-actions" style="margin-bottom: 12px;">
                    <button class="menu_button batch-size-btn" data-size="10">
                        10 Tracks
                    </button>
                    <button class="menu_button batch-size-btn" data-size="15">
                        15 Tracks
                    </button>
                    <button class="menu_button batch-size-btn" data-size="20">
                        20 Tracks
                    </button>
                </div>
                
                <div class="dar-sub-note">
                    <strong>Note:</strong> The AI will analyze track names and suggest appropriate tags. You'll be able to review and edit before applying.
                </div>
                
                <button class="menu_button" id="cancel_auto_tag" style="width: 100%;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        `);
        
        backdrop.append(modal);
        $('body').append(backdrop);
        
        // Batch size button handlers
        $('.batch-size-btn').on('click', async (e) => {
            const batchSize = parseInt($(e.currentTarget).data('size'));
            const tracksToProcess = availableTracks.slice(0, batchSize);
            
            // Update button to show loading
            const $allButtons = $('.batch-size-btn, #cancel_auto_tag');
            $allButtons.prop('disabled', true);
            $(e.currentTarget).html('<i class="fa-solid fa-spinner fa-spin"></i> Processing...');
            
            try {
                const taggedTracks = await this.getAITagSuggestions(tracksToProcess);
                
                if (taggedTracks.length === 0) {
                    darToast.warn('AI could not confidently tag any of the tracks. Try with different tracks or tag them manually.');
                    backdrop.remove();
                    return;
                }
                
                // Close this modal
                backdrop.remove();
                
                // Show preview modal
                this.showPreviewModal(taggedTracks, (count) => {
                    // saveMetadata() fires 'trackListChanged' which the
                    // modal's Library tab listens for, so no explicit
                    // re-render is needed here.
                    darToast.success(`Successfully tagged ${count} tracks!`);
                });
                
            } catch (error) {
                debugError('Error during auto-tagging:', error);
                darToast.error(`Failed to get AI tags: ${error.message}`);
                backdrop.remove();
            }
        });
        
        $('#cancel_auto_tag').on('click', () => {
            backdrop.remove();
        });
        
        backdrop.on('click', (e) => {
            if (e.target === backdrop[0]) {
                backdrop.remove();
            }
        });
        
        modal.on('click', (e) => {
            e.stopPropagation();
        });
    }
}

// ============================================================================
// CONVENIENCE WRAPPERS
// ============================================================================
//
// Constructs a new AutoTag with module-imported deps and opens its modal.
// Lets callers (audioModal.js, index.js extensions-menu, etc.) trigger the
// auto-tag UI without manually wiring up dependencies.

export function openAutoTagModal() {
    const autoTag = new AutoTag(
        trackLibrary,
        extension_settings,
        saveMetadata,
        EMOTION_TAGS,
        generateRaw,
    );
    autoTag.openModal();
}


// ============================================================================
// SINGLE-TRACK AUTO-TAG
// ============================================================================

/**
 * Tag a single track via AI. Shows a compact confirmation modal with
 * editable tags. Triggered by the wand button on untagged track rows.
 */
export async function autoTagSingle(trackPath) {
    const autoTag = new AutoTag(
        trackLibrary,
        extension_settings,
        saveMetadata,
        EMOTION_TAGS,
        generateRaw,
    );

    const meta = trackLibrary.metadata[trackPath] || {};
    const filename = trackPath.split('/').pop();
    const displayName = meta.title || decodeURIComponent(filename.replace(/\.[^.]+$/, ''));

    darToast.info(`Asking AI to tag "${displayName}"...`);

    try {
        const taggedTracks = await autoTag.getAITagSuggestions([trackPath]);

        if (taggedTracks.length === 0) {
            darToast.warn(`AI couldn't confidently tag "${displayName}". Try the manual editor instead.`);
            return;
        }

        showSingleTagConfirm(trackPath, displayName, taggedTracks[0].tags);

    } catch (error) {
        debugError('Single-track tagging failed:', error);
        darToast.error(`Failed to tag: ${error.message}`);
    }
}

/**
 * Compact confirmation modal for single-track AI tag results.
 */
function showSingleTagConfirm(trackPath, displayName, suggestedTags) {
    const backdrop = $('<div class="dar-sub-backdrop"></div>');

    const modal = $(`
        <div class="dar-sub-modal">
            <h3>AI Tag Suggestion</h3>
            <p style="font-style: italic; word-break: break-word;">${_esc(displayName)}</p>

            <div style="margin-bottom: 12px;">
                <label for="dar_single_tag_input" style="display: block; margin-bottom: 4px;">Suggested tags (edit before applying)</label>
                <input type="text" class="text_pole" id="dar_single_tag_input" value="${_esc(suggestedTags.join(', '))}">
            </div>

            <div class="dar-sub-actions">
                <button class="menu_button" id="dar_single_tag_apply" style="background: rgba(81, 207, 102, 0.2);">
                    <i class="fa-solid fa-check"></i> Apply Tags
                </button>
                <button class="menu_button" id="dar_single_tag_cancel">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);

    backdrop.append(modal);
    $('body').append(backdrop);

    setTimeout(() => $('#dar_single_tag_input').focus().select(), 100);

    $('#dar_single_tag_apply').on('click', () => {
        const tags = $('#dar_single_tag_input').val().trim()
            .split(',').map(t => t.trim()).filter(Boolean);

        if (tags.length === 0) {
            darToast.warn('Enter at least one tag');
            return;
        }

        trackLibrary.metadata[trackPath] = {
            ...(trackLibrary.metadata[trackPath] || {}),
            tags,
        };
        saveMetadata();
        backdrop.remove();
        darToast.success(`Tagged "${displayName}"`);
    });

    $('#dar_single_tag_cancel').on('click', () => backdrop.remove());

    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) backdrop.remove();
    });
    modal.on('click', (e) => e.stopPropagation());

    $(document).on('keydown.darSingleTag', (e) => {
        if (e.key === 'Escape') {
            backdrop.remove();
            $(document).off('keydown.darSingleTag');
        }
    });
}

/** Minimal HTML escaper (local to this module). */
function _esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
