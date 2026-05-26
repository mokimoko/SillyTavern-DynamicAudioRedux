/*
 * Auto-Tag - AI-powered automatic track tagging
 * Part of Dynamic Audio Redux extension
 */

import { getContext } from '../../../../extensions.js';

const DEBUG_PREFIX = '<Audio-AutoTag>';

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
            console.error(DEBUG_PREFIX, 'AI tagging failed:', error);
            throw error;
        }
    }
    
    /**
     * Show preview modal with suggested tags
     */
    showPreviewModal(taggedTracks, onApply) {
        const backdrop = $('<div class="audio-modal-backdrop"></div>');
        backdrop.css({
            'position': 'fixed',
            'inset': '0',
            'background': 'rgba(0, 0, 0, 0.7)',
            'z-index': '10000',
            'display': 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'backdrop-filter': 'blur(4px)'
        });
        
        const modal = $(`
            <div class="auto-tag-preview-modal">
                <h3 style="margin-top: 0;">Review AI Tag Suggestions</h3>
                <p style="opacity: 0.8; margin-bottom: 1em;">
                    AI suggested tags for ${taggedTracks.length} tracks. Review and edit before applying.
                </p>
                
                <div id="tag_preview_list" style="max-height: 400px; overflow-y: auto; margin-bottom: 1em; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px;"></div>
                
                <div class="flex-container" style="gap: 0.5em;">
                    <button class="menu_button" id="apply_all_tags" style="flex: 1; background: rgba(81, 207, 102, 0.2);">
                        <i class="fa-solid fa-check"></i> Apply All Tags
                    </button>
                    <button class="menu_button" id="cancel_tag_preview" style="flex: 1;">
                        <i class="fa-solid fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        `);
        
        modal.css({
            'background': '#1a1a1a',
            'border': '1px solid rgba(255, 255, 255, 0.2)',
            'border-radius': '10px',
            'padding': '1.5em',
            'max-width': '700px',
            'width': '90%',
            'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
            'color': '#e0e0e0'
        });
        
        const list = modal.find('#tag_preview_list');
        
        // Build editable tag list
        taggedTracks.forEach((item, index) => {
            const trackItem = $(`
                <div class="tag-preview-item" data-index="${index}" style="padding: 0.75em; margin-bottom: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.1);">
                    <div style="font-weight: bold; margin-bottom: 0.5em;">${item.trackName}</div>
                    <div style="display: flex; align-items: center; gap: 0.5em;">
                        <label style="opacity: 0.7; min-width: 40px;">Tags:</label>
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
            alert('No untagged tracks found! All tracks already have tags.');
            return;
        }
        
        // Determine which tracks to offer
        let availableTracks;
        let sourceMessage;
        
        if (preselectedTracks.length > 0) {
            // Filter preselected to only untagged ones
            availableTracks = preselectedTracks.filter(path => untaggedTracks.includes(path));
            
            if (availableTracks.length === 0) {
                alert('Selected tracks are already tagged!');
                return;
            }
            
            sourceMessage = `Found ${availableTracks.length} untagged tracks in your selection.`;
        } else {
            availableTracks = untaggedTracks;
            sourceMessage = `Found ${availableTracks.length} untagged tracks in your library.`;
        }
        
        const backdrop = $('<div class="audio-modal-backdrop"></div>');
        backdrop.css({
            'position': 'fixed',
            'inset': '0',
            'background': 'rgba(0, 0, 0, 0.7)',
            'z-index': '9999',
            'display': 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'backdrop-filter': 'blur(4px)'
        });
        
        const modal = $(`
            <div class="auto-tag-modal">
                <h3 style="margin-top: 0;">Auto-Tag Tracks</h3>
                <p style="opacity: 0.8; margin-bottom: 1em;">${sourceMessage}</p>
                
                <div style="margin-bottom: 1em;">
                    <p style="font-size: 0.9em; opacity: 0.9;">
                        How many tracks would you like to tag in this batch?
                    </p>
                </div>
                
                <div style="display: flex; gap: 0.5em; margin-bottom: 1em;">
                    <button class="menu_button batch-size-btn" data-size="10" style="flex: 1;">
                        10 Tracks
                    </button>
                    <button class="menu_button batch-size-btn" data-size="15" style="flex: 1;">
                        15 Tracks
                    </button>
                    <button class="menu_button batch-size-btn" data-size="20" style="flex: 1;">
                        20 Tracks
                    </button>
                </div>
                
                <div style="margin-bottom: 1em; padding: 0.75em; background: rgba(88, 101, 242, 0.1); border: 1px solid rgba(88, 101, 242, 0.3); border-radius: 5px; font-size: 0.9em;">
                    <strong>Note:</strong> The AI will analyze track names and suggest appropriate tags. You'll be able to review and edit before applying.
                </div>
                
                <button class="menu_button" id="cancel_auto_tag" style="width: 100%;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        `);
        
        modal.css({
            'background': '#1a1a1a',
            'border': '1px solid rgba(255, 255, 255, 0.2)',
            'border-radius': '10px',
            'padding': '1.5em',
            'max-width': '500px',
            'width': '90%',
            'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
            'color': '#e0e0e0'
        });
        
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
                    alert('AI could not confidently tag any of the tracks. Try with different tracks or tag them manually.');
                    backdrop.remove();
                    return;
                }
                
                // Close this modal
                backdrop.remove();
                
                // Show preview modal
                this.showPreviewModal(taggedTracks, (count) => {
                    // Update track list after applying
                    if (window.updateTrackList) {
                        window.updateTrackList();
                    }
                    if (window._expandedTrackListUpdate) {
                        window._expandedTrackListUpdate();
                    }
                    
                    alert(`Successfully tagged ${count} tracks!`);
                });
                
            } catch (error) {
                console.error(DEBUG_PREFIX, 'Error during auto-tagging:', error);
                alert(`Failed to get AI tags: ${error.message}`);
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