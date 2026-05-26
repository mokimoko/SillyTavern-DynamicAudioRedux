/*
 * Playlist from Chat - AI-powered playlist creation based on conversation context
 * Part of Dynamic Audio Redux extension
 */

import { getContext } from '../../../../extensions.js';
import { chat } from '../../../../../script.js';

const DEBUG_PREFIX = '<Audio-PlaylistFromChat>';

export class PlaylistFromChat {
    constructor(trackLibrary, extension_settings, saveSettingsDebounced, generateRaw) {
        this.trackLibrary = trackLibrary;
        this.extension_settings = extension_settings;
        this.saveSettingsDebounced = saveSettingsDebounced;
        this.generateRaw = generateRaw;
    }
    
    debugLog(msg) {
        if (this.extension_settings?.audio?.debug_mode) {
            console.log(DEBUG_PREFIX, msg);
        }
    }
    
    /**
     * Filter tracks by tags with intelligent scoring and flexible matching
     */
    filterTracksByTags(tags, characterName = null, includeGlobal = true) {
        let allTracks = [];
        
        // Collect all available tracks
        if (includeGlobal) {
            allTracks = [...this.trackLibrary.global];
        }
        
        if (characterName && this.trackLibrary.character[characterName]) {
            allTracks = [...this.trackLibrary.character[characterName], ...allTracks];
        } else if (!characterName) {
            Object.values(this.trackLibrary.character).forEach(charTracks => {
                allTracks = [...charTracks, ...allTracks];
            });
        }
        
        // Normalize query tags for better matching
        const normalizedQueryTags = tags.map(t => t.toLowerCase().trim());
        
        // Score each track based on tag matches
        const scoredTracks = allTracks.map(path => {
            const metadata = this.trackLibrary.metadata[path];
            if (!metadata || !metadata.tags || metadata.tags.length === 0) {
                return { path, score: 0, matchCount: 0 };
            }
            
            const trackTags = metadata.tags.map(t => t.toLowerCase().trim());
            
            let score = 0;
            let matchCount = 0;
            
            normalizedQueryTags.forEach(queryTag => {
                // Exact match = 2 points
                if (trackTags.includes(queryTag)) {
                    score += 2;
                    matchCount++;
                }
                // Partial match (query tag is substring of track tag or vice versa) = 1 point
                else {
                    const partialMatch = trackTags.some(trackTag => 
                        trackTag.includes(queryTag) || queryTag.includes(trackTag)
                    );
                    if (partialMatch) {
                        score += 1;
                        matchCount++;
                    }
                }
            });
            
            // Bonus points for matching multiple tags
            if (matchCount > 1) {
                score += matchCount * 0.5;
            }
            
            return { path, score, matchCount };
        });
        
        // Filter to only tracks with at least one match and sort by score
        const matches = scoredTracks
            .filter(item => item.score > 0)
            .sort((a, b) => {
                // Primary sort by match count (more matches = better)
                if (b.matchCount !== a.matchCount) {
                    return b.matchCount - a.matchCount;
                }
                // Secondary sort by score
                return b.score - a.score;
            })
            .map(item => item.path);
        
        this.debugLog(`Smart playlist matching: ${matches.length} tracks found for tags: ${tags.join(', ')}`);
        
        return matches;
    }
    
    /**
     * Analyze the current chat to extract relevant information for playlist creation
     */
    analyzeChat() {
        this.debugLog('Analyzing chat for playlist suggestions...');
        
        const context = getContext();
        const characterName = context.name2 || '';
        const userName = context.name1 || 'User';
        
        // Get recent messages (last 50 or fewer)
        const recentMessages = chat?.slice(-50) || [];
        
        // Extract emotions from messages
        const emotionKeywords = {
            joy: ['happy', 'joy', 'joyful', 'excited', 'cheerful', 'delighted', 'glad', 'pleased'],
            sadness: ['sad', 'unhappy', 'depressed', 'melancholy', 'gloomy', 'sorrowful', 'miserable'],
            anger: ['angry', 'mad', 'furious', 'annoyed', 'irritated', 'enraged', 'hostile'],
            fear: ['scared', 'afraid', 'frightened', 'terrified', 'anxious', 'nervous', 'worried'],
            love: ['love', 'loving', 'affectionate', 'romantic', 'tender', 'caring', 'devoted'],
            excitement: ['excited', 'thrilled', 'eager', 'enthusiastic', 'pumped', 'energetic'],
            surprise: ['surprised', 'shocked', 'amazed', 'astonished', 'startled', 'stunned'],
            disgust: ['disgusted', 'repulsed', 'revolted', 'sickened', 'appalled'],
            curiosity: ['curious', 'interested', 'intrigued', 'wondering', 'inquisitive'],
            confusion: ['confused', 'puzzled', 'perplexed', 'bewildered', 'baffled'],
            disappointment: ['disappointed', 'let down', 'discouraged', 'dismayed'],
            pride: ['proud', 'accomplished', 'triumphant', 'satisfied'],
            embarrassment: ['embarrassed', 'ashamed', 'humiliated', 'flustered'],
            gratitude: ['grateful', 'thankful', 'appreciative', 'indebted'],
            relief: ['relieved', 'comforted', 'reassured', 'eased']
        };
        
        const emotionCounts = {};
        const detectedKeywords = new Set();
        
        // Scan messages for emotion keywords
        recentMessages.forEach(msg => {
            if (!msg.mes) return;
            const text = msg.mes.toLowerCase();
            
            Object.entries(emotionKeywords).forEach(([emotion, keywords]) => {
                keywords.forEach(keyword => {
                    if (text.includes(keyword)) {
                        emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
                        detectedKeywords.add(keyword);
                    }
                });
            });
        });
        
        // Get top 3 emotions
        const topEmotions = Object.entries(emotionCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([emotion]) => emotion);
        
        // Look for other potentially relevant keywords (action, battle, etc.)
        const thematicKeywords = [
            'battle', 'fight', 'combat', 'war', 'action',
            'romance', 'romantic', 'date', 'kiss', 'intimate',
            'mystery', 'mysterious', 'investigation', 'detective',
            'adventure', 'quest', 'journey', 'explore',
            'dramatic', 'tension', 'intense', 'suspense',
            'peaceful', 'calm', 'relaxing', 'serene', 'quiet',
            'epic', 'grand', 'legendary', 'heroic',
            'dark', 'sinister', 'ominous', 'foreboding',
            'comedy', 'funny', 'humorous', 'amusing', 'playful'
        ];
        
        const detectedThemes = [];
        const messageText = recentMessages.map(m => m.mes).join(' ').toLowerCase();
        
        thematicKeywords.forEach(keyword => {
            if (messageText.includes(keyword)) {
                detectedThemes.push(keyword);
            }
        });
        
        // Build suggested tags
        const suggestedTags = [];
        
        // Add character tag if present
        if (characterName) {
            suggestedTags.push(`character:${characterName.toLowerCase()}`);
        }
        
        // Add top emotions
        topEmotions.forEach(emotion => {
            suggestedTags.push(emotion);
        });
        
        // Add detected themes (limit to top 3)
        detectedThemes.slice(0, 3).forEach(theme => {
            suggestedTags.push(theme);
        });
        
        // Generate suggested playlist name
        let suggestedName = '';
        if (characterName) {
            suggestedName = `Chat with ${characterName}`;
            if (topEmotions.length > 0) {
                suggestedName += ` - ${topEmotions[0]}`;
            }
        } else {
            suggestedName = 'Chat Playlist';
        }
        
        // Add date to make unique
        const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        suggestedName += ` (${date})`;
        
        this.debugLog(`Analysis complete: ${topEmotions.length} emotions, ${detectedThemes.length} themes detected`);
        
        return {
            characterName,
            userName,
            suggestedName,
            suggestedTags,
            topEmotions,
            detectedThemes,
            messageCount: recentMessages.length,
            recentMessages: recentMessages.slice(-15) // Last 15 for AI context
        };
    }
    
    /**
     * Get AI track suggestions using SillyTavern's AI backend
     */
    async getAISuggestions(analysis, userNotes = '') {
        this.debugLog('Requesting AI track suggestions...');
        
        // Build track list for AI
        const availableTracks = [];
        
        // Add character tracks
        Object.entries(this.trackLibrary.character || {}).forEach(([char, tracks]) => {
            tracks.forEach(path => {
                const metadata = this.trackLibrary.metadata[path] || {};
                const filename = path.split('/').pop();
                availableTracks.push({
                    name: metadata.title || filename,
                    tags: metadata.tags || [],
                    source: char,
                    path: path
                });
            });
        });
        
        // Add global tracks
        (this.trackLibrary.global || []).forEach(path => {
            const metadata = this.trackLibrary.metadata[path] || {};
            const filename = path.split('/').pop();
            availableTracks.push({
                name: metadata.title || filename,
                tags: metadata.tags || [],
                source: 'global',
                path: path
            });
        });
        
        if (availableTracks.length === 0) {
            throw new Error('No tracks available in library');
        }
        
        // Build messages array for AI
        let messages = [];
        
        // System prompt
        messages.push({
            role: 'system',
            content: `You are a music curator helping create a playlist based on a roleplay story. You will be given:
1. Information about the story (character, themes, emotions)
2. A list of available music tracks with their tags
3. Optional user notes

Your task is to suggest 8-15 tracks that best match the conversation's mood and context. Focus on:
- Matching the emotional tone
- Considering the story themes
- Creating a cohesive listening experience
- Respecting user notes if provided

CRITICAL: Respond with ONLY a JSON array of track names. Do not include any other text, explanations, or markdown code blocks. Just the raw JSON array. You MUST use the following format:

["Track Name 1", "Track Name 2", "Track Name 3"]

Use exact track names from the provided list.`
        });
        
        // Build context message
        let contextMessage = `Character: ${analysis.characterName || 'Unknown'}\n`;
        contextMessage += `User: ${analysis.userName}\n\n`;
        
        if (analysis.topEmotions.length > 0) {
            contextMessage += `Detected Emotions: ${analysis.topEmotions.join(', ')}\n`;
        }
        
        if (analysis.detectedThemes.length > 0) {
            contextMessage += `Detected Themes: ${analysis.detectedThemes.join(', ')}\n`;
        }
        
        contextMessage += `\nSuggested Tags: ${analysis.suggestedTags.join(', ')}\n`;
        
        if (userNotes) {
            contextMessage += `\nUser Notes: ${userNotes}\n`;
        }
        
        // Add recent messages
        if (analysis.recentMessages && analysis.recentMessages.length > 0) {
            contextMessage += `\nRecent story, (last ${analysis.recentMessages.length} messages):\n`;
            analysis.recentMessages.slice(0, 10).forEach(msg => {
                const speaker = msg.is_user ? analysis.userName : analysis.characterName;
                const preview = msg.mes.substring(0, 100);
                contextMessage += `${speaker}: ${preview}${msg.mes.length > 100 ? '...' : ''}\n`;
            });
        }
        
        messages.push({
            role: 'user',
            content: contextMessage
        });
        
        // Add available tracks
        let tracksMessage = `\nAvailable tracks (${availableTracks.length} total):\n`;
        availableTracks.forEach(t => {
            const tagStr = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
            tracksMessage += `- "${t.name}"${tagStr}\n`;
        });
        
        tracksMessage += '\n\nPlease read through the story provided and suggest 8-15 tracks that best match the evolution of the plot, as if it was a movie and you were creating its soundtrack.\n\nIMPORTANT: You must respond with ONLY the JSON array. No explanations, no markdown code blocks, no preamble. The format must be: ["Track 1", "Track 2", ...]';
        
        messages.push({
            role: 'user',
            content: tracksMessage
        });
        
        try {
            // Use SillyTavern's AI generation (same pattern as Character Crafter)
            const result = await this.generateRaw({
                prompt: messages,
                trimNames: false
            });
            
            if (!result || !result.trim()) {
                throw new Error('Empty response from AI');
            }
            
            this.debugLog('AI response received');
            this.debugLog('Raw response: ' + result.substring(0, 200));
            
            // Try to extract JSON from response more robustly
            let jsonText = result.trim();
            
            // Remove markdown code fences
            jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
            
            // Try to find JSON array in the text
            const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
            if (arrayMatch) {
                jsonText = arrayMatch[0];
            }
            
            // Remove any text before the opening bracket
            const firstBracket = jsonText.indexOf('[');
            if (firstBracket > 0) {
                jsonText = jsonText.substring(firstBracket);
            }
            
            // Remove any text after the closing bracket
            const lastBracket = jsonText.lastIndexOf(']');
            if (lastBracket !== -1 && lastBracket < jsonText.length - 1) {
                jsonText = jsonText.substring(0, lastBracket + 1);
            }
            
            this.debugLog('Cleaned JSON (first 200 chars): ' + jsonText.substring(0, 200));
            
            // Replace smart quotes with regular quotes
            jsonText = jsonText.replace(/[""]/g, '"');
            jsonText = jsonText.replace(/['']/g, "'");
            
            // Fix common issues: unescaped newlines in strings
            jsonText = jsonText.replace(/\n/g, ' ');
            jsonText = jsonText.replace(/\r/g, '');
            
            let suggestions;
            try {
                suggestions = JSON.parse(jsonText);
            } catch (parseError) {
                this.debugLog('JSON parse error: ' + parseError.message);
                this.debugLog('Attempted to parse: ' + jsonText);
                throw new Error(`Failed to parse AI response as JSON: ${parseError.message}`);
            }
            
            if (!Array.isArray(suggestions)) {
                throw new Error('AI response was not an array');
            }
            
            if (suggestions.length === 0) {
                throw new Error('AI returned empty array');
            }
            
            // Map track names to paths
            const suggestedTracks = [];
            suggestions.forEach(trackName => {
                const match = availableTracks.find(t => 
                    t.name.toLowerCase() === trackName.toLowerCase() ||
                    t.name.toLowerCase().includes(trackName.toLowerCase()) ||
                    trackName.toLowerCase().includes(t.name.toLowerCase())
                );
                
                if (match) {
                    suggestedTracks.push(match.path);
                }
            });
            
            this.debugLog(`AI suggested ${suggestedTracks.length} tracks`);
            
            return {
                tracks: suggestedTracks,
                rawSuggestions: suggestions
            };
            
        } catch (error) {
            console.error(DEBUG_PREFIX, 'AI suggestion failed:', error);
            throw error;
        }
    }
    
    /**
     * Open the playlist from chat creator modal
     */
    openModal() {
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
        
        // Analyze chat immediately
        const analysis = this.analyzeChat();
        
        const modal = $(`
            <div class="playlist-from-chat-modal">
                <h3 style="margin-top: 0;">Create Playlist from Chat</h3>
                
                <div style="margin-bottom: 1em;">
                    <label for="playlist_name_input" style="display: block; margin-bottom: 0.3em;">Playlist Name</label>
                    <input type="text" class="text_pole" id="playlist_name_input" value="${analysis.suggestedName}">
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label style="display: block; margin-bottom: 0.3em;">Auto-Detected Context</label>
                    <div style="padding: 0.75em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; font-size: 0.9em;">
                        <div><strong>Character:</strong> ${analysis.characterName || 'None'}</div>
                        ${analysis.topEmotions.length > 0 ? `<div><strong>Emotions:</strong> ${analysis.topEmotions.join(', ')}</div>` : ''}
                        ${analysis.detectedThemes.length > 0 ? `<div><strong>Themes:</strong> ${analysis.detectedThemes.join(', ')}</div>` : ''}
                        <div><strong>Messages analyzed:</strong> ${analysis.messageCount}</div>
                    </div>
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label for="suggested_tags_input" style="display: block; margin-bottom: 0.3em;">Suggested Tags (comma-separated)</label>
                    <input type="text" class="text_pole" id="suggested_tags_input" value="${analysis.suggestedTags.join(', ')}">
                    <small style="opacity: 0.7; font-size: 0.85em;">Edit these tags to fine-tune the playlist</small>
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label for="user_notes_input" style="display: block; margin-bottom: 0.3em;">Additional Notes for AI (optional)</label>
                    <textarea class="text_pole" id="user_notes_input" rows="3" placeholder="e.g., 'Focus on upbeat tracks' or 'Include battle music'"></textarea>
                    <small style="opacity: 0.7; font-size: 0.85em;">These notes will be sent to the AI when requesting suggestions</small>
                </div>
                
                <div id="ai_suggestions_area" style="display: none; margin-bottom: 1em;">
                    <label style="display: block; margin-bottom: 0.3em;">AI Suggested Tracks</label>
                    <div id="ai_suggested_tracks" style="max-height: 200px; overflow-y: auto; padding: 0.75em; background: rgba(81, 207, 102, 0.1); border: 1px solid rgba(81, 207, 102, 0.3); border-radius: 5px;">
                    </div>
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label style="display: block; margin-bottom: 0.5em;">Creation Options</label>
                    <div style="display: flex; gap: 0.5em; flex-wrap: wrap;">
                        <button class="menu_button" id="create_smart_playlist_btn" style="flex: 1; white-space: nowrap;">
                            <i class="fa-solid fa-magic"></i> Create Smart Playlist
                        </button>
                        <button class="menu_button" id="get_ai_suggestions_btn" style="flex: 1; white-space: nowrap;">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Get AI Suggestions
                        </button>
                    </div>
                    <small style="display: block; margin-top: 0.5em; opacity: 0.7; font-size: 0.85em;">
                        Smart Playlist: Auto-matches tracks by tags<br>
                        AI Suggestions: Let AI pick specific tracks
                    </small>
                </div>
                
                <div class="flex-container" style="gap: 0.5em;">
                    <button class="menu_button" id="cancel_playlist_from_chat" style="flex: 1;">
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
            'max-width': '600px',
            'width': '90%',
            'max-height': '90vh',
            'overflow-y': 'auto',
            'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
            'color': '#e0e0e0'
        });
        
        backdrop.append(modal);
        $('body').append(backdrop);
        
        let aiSuggestedTracks = [];
        
        // Create smart playlist - now with preview
        $('#create_smart_playlist_btn').on('click', () => {
            const name = $('#playlist_name_input').val().trim();
            const tagsInput = $('#suggested_tags_input').val().trim();
            
            if (!name) {
                alert('Please enter a playlist name');
                return;
            }
            
            const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];
            
            if (tags.length === 0) {
                alert('Please enter at least one tag');
                return;
            }
            
            // Find matching tracks
            const context = getContext();
            const matches = this.filterTracksByTags(tags, context.name2, true);
            
            if (matches.length === 0) {
                alert(`No tracks found matching tags: ${tags.join(', ')}`);
                return;
            }
            
            // Show preview with option to create
            const previewHtml = `
                <div style="margin-top: 1em; padding: 1em; background: rgba(81, 207, 102, 0.1); border: 1px solid rgba(81, 207, 102, 0.3); border-radius: 5px;">
                    <div style="margin-bottom: 0.5em;"><strong>Preview: ${matches.length} tracks found</strong></div>
                    <div style="max-height: 150px; overflow-y: auto; font-size: 0.9em;">
                        ${matches.map(path => {
                            const metadata = this.trackLibrary.metadata[path] || {};
                            const filename = path.split('/').pop();
                            return `<div style="padding: 0.2em 0;">• ${metadata.title || filename}</div>`;
                        }).join('')}
                    </div>
                    <div style="margin-top: 0.75em; display: flex; gap: 0.5em;">
                        <button class="menu_button" id="confirm_smart_playlist" style="flex: 1; background: rgba(81, 207, 102, 0.2);">
                            <i class="fa-solid fa-check"></i> Create & Play Smart Playlist
                        </button>
                        <button class="menu_button" id="cancel_smart_preview" style="flex: 1;">
                            <i class="fa-solid fa-times"></i> Cancel
                        </button>
                    </div>
                </div>
            `;
            
            // Add preview to modal
            $('#smart_playlist_preview').remove(); // Remove old preview if exists
            const $preview = $(previewHtml).attr('id', 'smart_playlist_preview');
            $preview.insertAfter($('#suggested_tags_input').closest('div'));
            
            // Bind confirm button
            $('#confirm_smart_playlist').on('click', () => {
                // Create smart playlist
                this.extension_settings.audio.playlists[name] = {
                    type: 'smart',
                    tags: tags,
                    emotion_mode: 'off',
                    emotion_override: null,
                    include_global: true
                };
                
                this.saveSettingsDebounced();
                
                // Update dropdown
                if (window.updatePlaylistDropdown) {
                    window.updatePlaylistDropdown();
                }
                
                // Switch to playlist mode and activate this playlist
                this.extension_settings.audio.mode = 'playlist';
                this.extension_settings.audio.active_playlist = name;
                $('#audio_mode').val('playlist');
                $('#audio_playlist_select').val(name);
                if (window.updateModeUI) {
                    window.updateModeUI();
                }
                
                // Enable audio if not already
                if (!this.extension_settings.audio.enabled) {
                    this.extension_settings.audio.enabled = true;
                    $('#audio_enabled').prop('checked', true);
                    if (window.updateMiniplayerVisibility) {
                        window.updateMiniplayerVisibility();
                    }
                }
                
                // Play the first track
                if (matches.length > 0 && window.playTrack) {
                    window.playTrack(matches[0]);
                }
                
                this.saveSettingsDebounced();
                
                alert(`Smart playlist "${name}" created with ${tags.length} tags (${matches.length} tracks) and now playing!`);
                backdrop.remove();
            });
            
            // Bind cancel button
            $('#cancel_smart_preview').on('click', () => {
                $('#smart_playlist_preview').remove();
            });
        });
        
        // Get AI suggestions
        $('#get_ai_suggestions_btn').on('click', async () => {
            const $btn = $('#get_ai_suggestions_btn');
            const originalHtml = $btn.html();
            $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Getting suggestions...');
            
            try {
                const userNotes = $('#user_notes_input').val().trim();
                const result = await this.getAISuggestions(analysis, userNotes);
                
                aiSuggestedTracks = result.tracks;
                
                if (aiSuggestedTracks.length === 0) {
                    alert('AI did not suggest any tracks. Try adjusting your notes or tags.');
                    $btn.prop('disabled', false).html(originalHtml);
                    return;
                }
                
                // Display suggested tracks
                const $suggestionsArea = $('#ai_suggestions_area');
                const $tracksList = $('#ai_suggested_tracks');
                
                $tracksList.empty();
                aiSuggestedTracks.forEach(path => {
                    const metadata = this.trackLibrary.metadata[path] || {};
                    const filename = path.split('/').pop();
                    const displayName = metadata.title || filename;
                    
                    $tracksList.append(`<div style="padding: 0.25em 0;">• ${displayName}</div>`);
                });
                
                $suggestionsArea.show();
                
                // Replace the "Get AI Suggestions" button with "Create Manual Playlist" button
                $btn.replaceWith(`
                    <button class="menu_button" id="create_manual_from_ai_btn" style="flex: 1; white-space: nowrap; background: rgba(81, 207, 102, 0.2);">
                        <i class="fa-solid fa-check"></i> Create & Play Manual Playlist
                    </button>
                `);
                
                // Bind new button
                $('#create_manual_from_ai_btn').on('click', () => {
                    const name = $('#playlist_name_input').val().trim();
                    
                    if (!name) {
                        alert('Please enter a playlist name');
                        return;
                    }
                    
                    // Create manual playlist with AI suggestions
                    this.extension_settings.audio.playlists[name] = {
                        type: 'manual',
                        tracks: aiSuggestedTracks
                    };
                    
                    this.saveSettingsDebounced();
                    
                    // Update dropdown
                    if (window.updatePlaylistDropdown) {
                        window.updatePlaylistDropdown();
                    }
                    
                    // Switch to playlist mode and activate this playlist
                    this.extension_settings.audio.mode = 'playlist';
                    this.extension_settings.audio.active_playlist = name;
                    $('#audio_mode').val('playlist');
                    $('#audio_playlist_select').val(name);
                    if (window.updateModeUI) {
                        window.updateModeUI();
                    }
                    
                    // Enable audio if not already
                    if (!this.extension_settings.audio.enabled) {
                        this.extension_settings.audio.enabled = true;
                        $('#audio_enabled').prop('checked', true);
                        if (window.updateMiniplayerVisibility) {
                            window.updateMiniplayerVisibility();
                        }
                    }
                    
                    // Play the first track
                    if (aiSuggestedTracks.length > 0 && window.playTrack) {
                        window.playTrack(aiSuggestedTracks[0]);
                    }
                    
                    this.saveSettingsDebounced();
                    
                    alert(`Manual playlist "${name}" created with ${aiSuggestedTracks.length} tracks and now playing!`);
                    backdrop.remove();
                });
                
            } catch (error) {
                console.error(DEBUG_PREFIX, 'Error getting AI suggestions:', error);
                alert(`Failed to get AI suggestions: ${error.message}`);
                $btn.prop('disabled', false).html(originalHtml);
            }
        });
        
        $('#cancel_playlist_from_chat').on('click', () => backdrop.remove());
        
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