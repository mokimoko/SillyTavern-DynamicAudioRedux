/*
 * Dynamic Audio Extension - Tag-Based Rewrite v2
 * 
 * Enhancements:
 * - Track seeking/navigation with progress bar
 * - Manual playlist editing
 * - Smart playlist preview with track list
 * - Minimal miniplayer with position options
 * - Bulk track selection and tagging
 */

import { saveSettingsDebounced, getRequestHeaders, generateRaw } from '../../../../script.js';
import { getContext, extension_settings, ModuleWorkerWrapper } from '../../../extensions.js';
import { registerSlashCommand } from '../../../slash-commands.js';
import { PlaylistFromChat } from './src/playlistFromChat.js';
import { AutoTag } from './src/autoTag.js';

const MODULE_NAME = 'Audio';
const DEBUG_PREFIX = '<Audio Module>';
const UPDATE_INTERVAL = 1000;
const COMMAND_NAME = 'd-audio';

// Global debug logging
function debugLog(msg) {
    if (extension_settings.audio && extension_settings.audio.debug_mode) {
        console.log(DEBUG_PREFIX, msg);
    }
}

// Default emotion tags - matches SillyTavern character expressions
const EMOTION_TAGS = [
    'admiration',
    'amusement',
    'anger',
    'annoyance',
    'approval',
    'caring',
    'confusion',
    'curiosity',
    'desire',
    'disappointment',
    'disapproval',
    'disgust',
    'embarrassment',
    'excitement',
    'fear',
    'gratitude',
    'grief',
    'joy',
    'love',
    'nervousness',
    'optimism',
    'pride',
    'realization',
    'relief',
    'remorse',
    'sadness',
    'surprise',
    'neutral'
];

// Track Library - central storage for all discovered tracks
const trackLibrary = {
    global: [],      // Tracks from /assets/bgm/
    character: {},   // Tracks from /characters/<n>/bgm/
    metadata: {},    // Track metadata (tags, titles, etc)
};

// Playback state
let currentTrack = null;
let previousTrack = null;
let currentEmotion = 'neutral';
let playQueue = [];
let cooldownTimer = 0;
let lastSkipDirection = 'forward';
let isSeeking = false; // Track if user is currently seeking
let lastCharacterName = null; // Track character changes for auto-rescan

// Selection state for bulk operations
let selectedTracks = new Set();
let lastSelectedIndex = -1;

// Default settings
const defaultSettings = {
    enabled: false,
    mode: 'instrumental',
    
    bgm_volume: 50,
    bgm_muted: false,
    ambient_volume: 50,
    ambient_muted: false,
    
    emotion_detection: true,
    instrumental_only: true,
    instrumental_include_global: true,
    songs_emotion_filter: 'all',
    songs_include_global: true,
    cooldown: 30,
    loop_single: false,
    shuffle: false,
    
    miniplayer_enabled: false,
    miniplayer_position: 'top-right',
    
    show_global_tracks: true,
    show_only_current_character: false, 
    
    debug_mode: false,
    
    playlists: {},
    active_playlist: null,
    
    character_defaults: {},
};

function loadSettings() {
    if (!extension_settings.audio) {
        extension_settings.audio = {};
    }
    
    if (!extension_settings.audio.playlists) {
        extension_settings.audio.playlists = {};
    }
    if (!extension_settings.audio.track_metadata) {
        extension_settings.audio.track_metadata = {};
    }
    
    Object.keys(defaultSettings).forEach(key => {
        if (extension_settings.audio[key] === undefined) {
            extension_settings.audio[key] = defaultSettings[key];
        }
    });
    
    debugLog(`Loaded playlists: ${Object.keys(extension_settings.audio.playlists).length}`);
    
    $('#audio_enabled').prop('checked', extension_settings.audio.enabled);
    $('#audio_mode').val(extension_settings.audio.mode);
    $('#audio_emotion_detection').prop('checked', extension_settings.audio.emotion_detection);
    $('#audio_songs_emotion_filter').val(extension_settings.audio.songs_emotion_filter);
    $('#audio_cooldown').val(extension_settings.audio.cooldown);
    $('#audio_loop_single').prop('checked', extension_settings.audio.loop_single);
    $('#audio_shuffle').prop('checked', extension_settings.audio.shuffle);
    $('#audio_miniplayer_enabled').prop('checked', extension_settings.audio.miniplayer_enabled);
    $('#audio_miniplayer_position').val(extension_settings.audio.miniplayer_position);
    $('#audio_show_global_tracks').prop('checked', extension_settings.audio.show_global_tracks !== false);
    $('#audio_show_only_current_character').prop('checked', extension_settings.audio.show_only_current_character || false);
    $('#audio_songs_include_global').prop('checked', extension_settings.audio.songs_include_global !== false);
    $('#audio_instrumental_include_global').prop('checked', extension_settings.audio.instrumental_include_global !== false);
    
    $('#audio_bgm_volume_slider').val(extension_settings.audio.bgm_volume);
    $('#audio_bgm_volume').text(extension_settings.audio.bgm_volume);
    $('#audio_bgm')[0].volume = extension_settings.audio.bgm_volume * 0.01;
    
    updateModeUI();
    updateMiniplayerVisibility();
}

function updateModeUI() {
    const mode = extension_settings.audio.mode;
    
    $('#instrumental_controls').toggle(mode === 'instrumental');
    $('#songs_controls').toggle(mode === 'songs');
    $('#playlist_controls').toggle(mode === 'playlist');
}

// ============================================
// MINIPLAYER
// ============================================

function createMiniplayer() {
    if ($('#audio_miniplayer').length > 0) {
        return; // Already exists
    }
    
    const miniplayer = $(`
        <div id="audio_miniplayer">
            <div class="miniplayer-controls">
                <div class="miniplayer-volume-wrapper">
                    <div class="miniplayer-volume-popup">
                        <input type="range" id="miniplayer_volume" min="0" max="100" value="50" orient="vertical">
                    </div>
                    <button class="miniplayer-btn" id="miniplayer_mute" title="Volume">
                        <i class="fa-solid fa-volume-high" id="miniplayer_mute_icon"></i>
                    </button>
                </div>
                <div class="miniplayer-progress-wrapper">
                    <input type="range" id="miniplayer_progress" min="0" max="100" value="0" step="0.1">
                </div>
                <button class="miniplayer-btn" id="miniplayer_next" title="Next track">
                    <i class="fa-solid fa-forward"></i>
                </button>
            </div>
        </div>
    `);
    
    // Base miniplayer styles
    miniplayer.css({
        'position': 'fixed',
        'z-index': '9000',
        'background': 'rgba(0, 0, 0, 0.6)',
        'backdrop-filter': 'blur(6px)',
        'border': '1px solid rgba(255, 255, 255, 0.08)',
        'border-radius': '16px',
        'padding': '4px 8px',
        'width': '150px',
        'box-shadow': '0 2px 12px rgba(0, 0, 0, 0.2)',
        'opacity': '0.4',
        'transition': 'opacity 0.2s ease'
    });
    
    miniplayer.find('.miniplayer-controls').css({
        'display': 'flex',
        'align-items': 'center',
        'gap': '8px'
    });
    
    // Volume wrapper (contains button and popup)
    miniplayer.find('.miniplayer-volume-wrapper').css({
        'position': 'relative',
        'display': 'flex',
        'align-items': 'center'
    });
    
    // Volume popup (vertical slider)
    miniplayer.find('.miniplayer-volume-popup').css({
        'position': 'absolute',
        'bottom': '100%',
        'left': '50%',
        'transform': 'translateX(-50%)',
        'margin-bottom': '4px',
        'background': 'rgba(0, 0, 0, 0.9)',
        'backdrop-filter': 'blur(10px)',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '12px',
        'padding': '12px 8px',
        'opacity': '0',
        'pointer-events': 'none',
        'transition': 'opacity 0.15s ease 0.1s',
        'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.5)'
    });
    
    // Vertical volume slider
    miniplayer.find('#miniplayer_volume').css({
        'writing-mode': 'bt-lr',
        '-webkit-appearance': 'slider-vertical',
        'width': '6px',
        'height': '80px',
        'cursor': 'pointer',
        'background': 'rgba(255, 255, 255, 0.2)',
        'border-radius': '3px',
        'outline': 'none'
    });
    
    // Progress wrapper
    miniplayer.find('.miniplayer-progress-wrapper').css({
        'flex': '1',
        'display': 'flex',
        'align-items': 'center'
    });
    
    miniplayer.find('#miniplayer_progress').css({
        'width': '100%',
        'height': '4px',
        'cursor': 'pointer',
        'background': 'rgba(255, 255, 255, 0.15)',
        'border-radius': '2px',
        'outline': 'none',
        '-webkit-appearance': 'none'
    });
    
    miniplayer.find('.miniplayer-btn').css({
        'background': 'transparent',
        'border': 'none',
        'color': '#e0e0e0',
        'cursor': 'pointer',
        'padding': '6px',
        'border-radius': '50%',
        'transition': 'background 0.2s ease',
        'display': 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        'width': '28px',
        'height': '28px',
        'font-size': '14px'
    });
    
    // Hover effects
    miniplayer.on('mouseenter', function() {
        $(this).css('opacity', '1');
    });
    
    miniplayer.on('mouseleave', function() {
        $(this).css('opacity', '0.4');
    });
    
    // Volume popup hover
    let volumeHideTimeout;
    
    miniplayer.find('.miniplayer-volume-wrapper').on('mouseenter', function() {
        clearTimeout(volumeHideTimeout);
        $(this).find('.miniplayer-volume-popup').css({
            'opacity': '1',
            'pointer-events': 'auto'
        });
    });
    
    miniplayer.find('.miniplayer-volume-wrapper').on('mouseleave', function() {
        const popup = $(this).find('.miniplayer-volume-popup');
        volumeHideTimeout = setTimeout(() => {
            popup.css({
                'opacity': '0',
                'pointer-events': 'none'
            });
        }, 150);
    });
    
    miniplayer.find('.miniplayer-btn').on('mouseenter', function() {
        $(this).css('background', 'rgba(255, 255, 255, 0.15)');
    });
    
    miniplayer.find('.miniplayer-btn').on('mouseleave', function() {
        $(this).css('background', 'transparent');
    });
    
    // Event handlers
    miniplayer.find('#miniplayer_next').on('click', onSkipTrack);
    
    miniplayer.find('#miniplayer_mute').on('click', () => {
        extension_settings.audio.bgm_muted = !extension_settings.audio.bgm_muted;
        $('#audio_bgm')[0].muted = extension_settings.audio.bgm_muted;
        
        const icon = extension_settings.audio.bgm_muted ? 'fa-volume-mute' : 'fa-volume-high';
        $('#miniplayer_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass(icon);
        $('#audio_bgm_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass(icon);
        
        saveSettingsDebounced();
    });
    
    miniplayer.find('#miniplayer_volume').on('input', function() {
        const volume = parseInt($(this).val());
        extension_settings.audio.bgm_volume = volume;
        $('#audio_bgm')[0].volume = volume * 0.01;
        
        $('#audio_bgm_volume_slider').val(volume);
        $('#audio_bgm_volume').text(volume);
        
        // Update mute icon based on volume
        if (volume === 0) {
            $('#miniplayer_mute_icon').removeClass('fa-volume-high fa-volume-low').addClass('fa-volume-mute');
            $('#audio_bgm_mute_icon').removeClass('fa-volume-high fa-volume-low').addClass('fa-volume-mute');
        } else if (volume < 50) {
            $('#miniplayer_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass('fa-volume-low');
            $('#audio_bgm_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass('fa-volume-low');
        } else {
            $('#miniplayer_mute_icon').removeClass('fa-volume-low fa-volume-mute').addClass('fa-volume-high');
            $('#audio_bgm_mute_icon').removeClass('fa-volume-low fa-volume-mute').addClass('fa-volume-high');
        }
        
        saveSettingsDebounced();
    });
    
    // Progress seeking
    let miniplayerSeeking = false;
    
    miniplayer.find('#miniplayer_progress').on('mousedown touchstart', () => {
        miniplayerSeeking = true;
        isSeeking = true;
    });
    
    miniplayer.find('#miniplayer_progress').on('mouseup touchend', () => {
        miniplayerSeeking = false;
        isSeeking = false;
        
        const audio = $('#audio_bgm')[0];
        if (audio.duration) {
            const percent = parseFloat($('#miniplayer_progress').val());
            const newTime = (percent / 100) * audio.duration;
            audio.currentTime = newTime;
        }
    });
    
    $('body').append(miniplayer);
    
    updateMiniplayerPosition();
    updateMiniplayerContent();
}

function updateMiniplayerPosition() {
    const miniplayer = $('#audio_miniplayer');
    if (miniplayer.length === 0) return;
    
    const position = extension_settings.audio.miniplayer_position;
    
    // Reset all positions
    miniplayer.css({
        'top': 'auto',
        'bottom': 'auto',
        'left': 'auto',
        'right': 'auto'
    });
    
    // Apply new position
    const offset = '20px';
    const isTop = position.startsWith('top-');
    
    switch (position) {
        case 'top-right':
            miniplayer.css({ 'top': offset, 'right': offset });
            break;
        case 'top-left':
            miniplayer.css({ 'top': offset, 'left': offset });
            break;
        case 'bottom-right':
            miniplayer.css({ 'bottom': offset, 'right': offset });
            break;
        case 'bottom-left':
            miniplayer.css({ 'bottom': offset, 'left': offset });
            break;
    }
    
    // Update volume popup position based on whether we're at top or bottom
    const volumePopup = miniplayer.find('.miniplayer-volume-popup');
    if (isTop) {
        // Show below when at top
        volumePopup.css({
            'bottom': 'auto',
            'top': '100%',
            'margin-bottom': '0',
            'margin-top': '4px'
        });
    } else {
        // Show above when at bottom
        volumePopup.css({
            'top': 'auto',
            'bottom': '100%',
            'margin-top': '0',
            'margin-bottom': '4px'
        });
    }
}

function updateMiniplayerContent() {
    const miniplayer = $('#audio_miniplayer');
    if (miniplayer.length === 0) return;
    
    // Update volume slider to match current volume
    miniplayer.find('#miniplayer_volume').val(extension_settings.audio.bgm_volume);
    
    // Update mute icons (both miniplayer and extension settings)
    const volume = extension_settings.audio.bgm_volume;
    let icon;
    if (extension_settings.audio.bgm_muted || volume === 0) {
        icon = 'fa-volume-mute';
    } else if (volume < 50) {
        icon = 'fa-volume-low';
    } else {
        icon = 'fa-volume-high';
    }
    
    // Update both icons to stay in sync
    miniplayer.find('#miniplayer_mute_icon').removeClass('fa-volume-high fa-volume-low fa-volume-mute').addClass(icon);
    $('#audio_bgm_mute_icon').removeClass('fa-volume-high fa-volume-low fa-volume-mute').addClass(icon);
}

function updateMiniplayerProgress() {
    const miniplayer = $('#audio_miniplayer');
    if (miniplayer.length === 0 || isSeeking) return;
    
    const audio = $('#audio_bgm')[0];
    if (!audio || !audio.duration) {
        miniplayer.find('#miniplayer_progress').val(0);
        return;
    }
    
    const percent = (audio.currentTime / audio.duration) * 100;
    miniplayer.find('#miniplayer_progress').val(percent);
}

function updateMiniplayerVisibility() {
    const shouldShow = extension_settings.audio.miniplayer_enabled && extension_settings.audio.enabled;
    
    if (shouldShow) {
        if ($('#audio_miniplayer').length === 0) {
            createMiniplayer();
        }
        $('#audio_miniplayer').show();
    } else {
        $('#audio_miniplayer').hide();
    }
}

// ============================================
// TRACK LIBRARY MANAGEMENT
// ============================================

function cleanFilename(filename) {
    let cleaned = filename;
    
    // Remove file extension
    cleaned = cleaned.replace(/\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i, '');
    
    // Remove common junk patterns
    const patterns = [
        /\(from [^)]+\)/gi,           // (from whatever.com)
        /\[from [^\]]+\]/gi,          // [from whatever.com]
        /\(official[^)]*\)/gi,        // (official music video)
        /\[official[^\]]*\]/gi,       // [official audio]
        /\(hd\)/gi,                   // (HD)
        /\[hd\]/gi,                   // [HD]
        /\(4k\)/gi,                   // (4K)
        /\[4k\]/gi,                   // [4K]
        /\(lyrics?\)/gi,              // (lyrics) or (lyric)
        /\[lyrics?\]/gi,              // [lyrics] or [lyric]
        /\(audio\)/gi,                // (audio)
        /\[audio\]/gi,                // [audio]
        /\(music video\)/gi,          // (music video)
        /\[music video\]/gi,          // [music video]
        /\(full\)/gi,                 // (full)
        /\[full\]/gi,                 // [full]
        /\s+-\s+Topic$/,              // " - Topic" at end
        /\s+\d{4}$/,                  // Year at end (optional)
    ];
    
    patterns.forEach(pattern => {
        cleaned = cleaned.replace(pattern, '');
    });
    
    // Clean up multiple spaces and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    return cleaned;
}

async function scanTracks() {
    debugLog('Scanning for tracks...');
    
    try {
        const globalTracks = await fetch('/api/assets/get', {
            method: 'POST',
            headers: getRequestHeaders(),
        }).then(r => r.json());
        
        trackLibrary.global = (globalTracks.bgm || []).filter(f => f !== '.placeholder');
        
        const context = getContext();
        if (context.name2) {
            const charTracks = await fetch(`/api/assets/character?name=${encodeURIComponent(context.name2)}&category=bgm`, {
                method: 'POST',
                headers: getRequestHeaders(),
            }).then(r => r.json());
            
            trackLibrary.character[context.name2] = charTracks || [];
        }
        
        debugLog(`Found tracks: global=${trackLibrary.global.length}, character=${Object.keys(trackLibrary.character).reduce((sum, k) => sum + trackLibrary.character[k].length, 0)}`);
        
        // Update last known character to prevent duplicate auto-scans
        lastCharacterName = context.name2;
        
        await loadMetadata();
        updateTrackList();
        
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error scanning tracks:', error);
    }
}

async function loadMetadata() {
    debugLog('Loading track metadata...');
    
    try {
        if (extension_settings.audio.track_metadata) {
            trackLibrary.metadata = extension_settings.audio.track_metadata;
            debugLog(`Loaded metadata from settings: ${Object.keys(trackLibrary.metadata).length} tracks`);
            return;
        }
        
        debugLog('No metadata found in settings, starting fresh');
        trackLibrary.metadata = {};
    } catch (error) {
        debugLog(`Error loading metadata: ${error}`);
        trackLibrary.metadata = {};
    }
}

async function saveMetadata() {
    debugLog('Saving track metadata...');
    
    try {
        extension_settings.audio.track_metadata = trackLibrary.metadata;
        saveSettingsDebounced();
        
        debugLog(`Metadata saved successfully: ${Object.keys(trackLibrary.metadata).length} tracks`);
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error saving metadata:', error);
    }
}

function clearSelection() {
    selectedTracks.clear();
    lastSelectedIndex = -1;
    updateTrackList();
    updateBulkActionBar();
}

function updateBulkActionBar() {
    const existingBar = $('#bulk_action_bar');
    
    if (selectedTracks.size === 0) {
        existingBar.remove();
        return;
    }
    
    if (existingBar.length > 0) {
        existingBar.find('.selection-count').text(`${selectedTracks.size} selected`);
        return;
    }
    
    const actionBar = $(`
        <div id="bulk_action_bar">
            <span class="selection-count">${selectedTracks.size} selected</span>
            <button class="menu_button" id="bulk_add_tags">
                <i class="fa-solid fa-tags"></i> Add Tags
            </button>
            <button class="menu_button" id="bulk_clear_selection">
                <i class="fa-solid fa-times"></i> Clear
            </button>
        </div>
    `);
    
    actionBar.css({
        'position': 'fixed',
        'bottom': '20px',
        'left': '50%',
        'transform': 'translateX(-50%)',
        'background': 'rgba(0, 0, 0, 0.9)',
        'backdrop-filter': 'blur(10px)',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '0.75em 1em',
        'display': 'flex',
        'align-items': 'center',
        'gap': '1em',
        'z-index': '9998',
        'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.5)',
        'animation': 'slideUp 0.2s ease'
    });
    
    actionBar.find('.selection-count').css({
        'font-weight': 'bold',
        'color': '#51cf66'
    });
    
    $('body').append(actionBar);
    
    $('#bulk_add_tags').on('click', openBulkTagEditor);
    $('#bulk_clear_selection').on('click', clearSelection);
}

function openBulkTagEditor() {
    if (selectedTracks.size === 0) return;
    
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
    
    // Find common tags across all selected tracks
    const trackPaths = Array.from(selectedTracks);
    const allTags = trackPaths.map(path => {
        const metadata = trackLibrary.metadata[path] || {};
        return new Set(metadata.tags || []);
    });
    
    // Tags present in ALL selected tracks
    const commonTags = allTags.length > 0 ? 
        [...allTags[0]].filter(tag => allTags.every(set => set.has(tag))) : [];
    
    const emotionCheckboxes = EMOTION_TAGS.map(emotion => {
        const isCommon = commonTags.includes(emotion);
        return `
            <label class="checkbox_label" style="display: flex; align-items: center; width: 32%; margin: 0.15em 0; font-size: 0.9em; gap: 0.3em;">
                <input type="checkbox" class="bulk-emotion-checkbox" value="${emotion}" ${isCommon ? 'checked' : ''} style="margin: 0;">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${emotion}</span>
            </label>
        `;
    }).join('');
    
    const isInstrumentalCommon = commonTags.includes('instrumental');
    const otherCommonTags = commonTags.filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));
    
    const editor = $(`
        <div class="bulk-tag-editor-modal">
            <h3 style="margin-top: 0;">Bulk Add Tags</h3>
            <div style="margin-bottom: 1em; opacity: 0.8;">Adding tags to ${selectedTracks.size} track(s)</div>
            
            <div style="margin-bottom: 1em;">
                <label class="checkbox_label" for="bulk_instrumental">
                    <input type="checkbox" id="bulk_instrumental" ${isInstrumentalCommon ? 'checked' : ''}>
                    <span>Instrumental (no vocals)</span>
                </label>
            </div>
            
            <div style="margin-bottom: 1em;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em;">
                    <label style="margin: 0;">Emotions</label>
                    <button class="menu_button menu_button_icon" id="bulk_toggle_emotions" title="Show/hide emotions">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="bulk_emotion_selector" style="display: none; padding: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; max-height: 200px; overflow-y: auto;">
                    <div style="display: flex; flex-wrap: wrap; gap: 0.25em;">
                        ${emotionCheckboxes}
                    </div>
                </div>
            </div>
            
            <div style="margin-bottom: 1em;">
                <label for="bulk_other_tags" style="display: block; margin-bottom: 0.3em;">Other Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="bulk_other_tags" value="${otherCommonTags.join(', ')}" placeholder="e.g. action, ambient, battle">
            </div>
            
            <div style="margin-bottom: 1em; padding: 0.75em; background: rgba(81, 207, 102, 0.1); border: 1px solid rgba(81, 207, 102, 0.3); border-radius: 5px;">
                <div style="font-size: 0.9em; margin-bottom: 0.5em;"><strong>Note:</strong></div>
                <div style="font-size: 0.85em; opacity: 0.9;">Tags will be <strong>added</strong> to existing tags. Checked tags already present on all tracks. Unchecking won't remove existing tags.</div>
            </div>
            
            <div class="flex-container" style="gap: 0.5em; margin-top: 1em;">
                <button class="menu_button" id="save_bulk_tags">
                    <i class="fa-solid fa-save"></i> Add Tags
                </button>
                <button class="menu_button" id="cancel_bulk_tags">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);
    
    editor.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '500px',
        'width': '90%',
        'max-height': '90vh',
        'overflow-y': 'auto',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    backdrop.append(editor);
    $('body').append(backdrop);
    
    // Toggle emotion selector
    $('#bulk_toggle_emotions').on('click', (e) => {
        e.preventDefault();
        const selector = $('#bulk_emotion_selector');
        const icon = $('#bulk_toggle_emotions i');
        
        if (selector.is(':visible')) {
            selector.slideUp(200);
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        } else {
            selector.slideDown(200);
            icon.removeClass('fa-chevron-down').addClass('fa-chevron-up');
        }
    });
    
    $('#save_bulk_tags').on('click', () => {
        const isInstrumental = $('#bulk_instrumental').is(':checked');
        
        // Collect checked emotions
        const emotions = [];
        $('.bulk-emotion-checkbox:checked').each(function() {
            emotions.push($(this).val());
        });
        
        // Collect other tags
        const otherTags = $('#bulk_other_tags').val().split(',').map(t => t.trim()).filter(Boolean);
        
        // Build new tags to add
        const newTags = [];
        if (isInstrumental) newTags.push('instrumental');
        newTags.push(...emotions);
        newTags.push(...otherTags);
        
        // Apply to all selected tracks
        selectedTracks.forEach(path => {
            const metadata = trackLibrary.metadata[path] || { tags: [], title: '' };
            const existingTags = new Set(metadata.tags || []);
            
            // Add new tags (avoiding duplicates)
            newTags.forEach(tag => existingTags.add(tag));
            
            trackLibrary.metadata[path] = {
                ...metadata,
                tags: Array.from(existingTags)
            };
        });
        
        saveMetadata();
        updateTrackList();
        clearSelection();
        backdrop.remove();
    });
    
    $('#cancel_bulk_tags').on('click', () => backdrop.remove());
    
    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            backdrop.remove();
        }
    });
    
    editor.on('click', (e) => {
        e.stopPropagation();
    });
}

function openExpandedTrackList() {
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
        <div class="expanded-track-list-modal">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1em;">
                <h3 style="margin: 0;">Track Library</h3>
                <button class="menu_button menu_button_icon" id="close_expanded_tracks">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            
            <div style="margin-bottom: 1em;">
                <input type="text" class="text_pole" id="track_search" placeholder="Search tracks by name or tag...">
            </div>
            
            <div style="display: flex; gap: 0.5em; margin-bottom: 1em; flex-wrap: wrap;">
                <button class="menu_button filter-btn active" data-filter="all">All</button>
                <button class="menu_button filter-btn" data-filter="global">Global Only</button>
                <button class="menu_button filter-btn" data-filter="character">Character Only</button>
                <button class="menu_button filter-btn" data-filter="instrumental">Instrumental</button>
                <button class="menu_button filter-btn" data-filter="tagged">Tagged Only</button>
            </div>
            
            <div id="expanded_track_list" style="max-height: 500px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px; margin-bottom: 1em;"></div>
            
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span id="expanded_track_count" style="opacity: 0.7; font-size: 0.9em;"></span>
            </div>
        </div>
    `);
    
    modal.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '800px',
        'width': '90%',
        'max-height': '90vh',
        'overflow-y': 'auto',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    backdrop.append(modal);
    $('body').append(backdrop);
    
    let currentFilter = 'all';
    let searchQuery = '';
    
    // Store update function reference so it can be called from other handlers
    window._expandedTrackListUpdate = updateExpandedList;
    
    function updateExpandedList() {
        const list = $('#expanded_track_list');
        list.empty();
        
        let allTracks = [];
        const context = getContext();
        const currentCharacter = context.name2;
        
        // Get all tracks
        Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
            allTracks.push(...tracks.map(t => ({ path: t, source: char })));
        });
        allTracks.push(...trackLibrary.global.map(t => ({ path: t, source: 'global' })));
        
        // Apply filters
        let filteredTracks = allTracks.filter(({ path, source }) => {
            // Source filter
            if (currentFilter === 'global' && source !== 'global') return false;
            if (currentFilter === 'character' && source === 'global') return false;
            
            // Instrumental filter
            if (currentFilter === 'instrumental') {
                const metadata = trackLibrary.metadata[path] || {};
                if (!(metadata.tags || []).includes('instrumental')) return false;
            }
            
            // Tagged filter
            if (currentFilter === 'tagged') {
                const metadata = trackLibrary.metadata[path] || {};
                if (!metadata.tags || metadata.tags.length === 0) return false;
            }
            
            // Search filter
            if (searchQuery) {
                const metadata = trackLibrary.metadata[path] || {};
                const filename = path.split('/').pop();
                const title = (metadata.title || filename).toLowerCase();
                const tags = (metadata.tags || []).join(' ').toLowerCase();
                const query = searchQuery.toLowerCase();
                
                if (!title.includes(query) && !tags.includes(query)) return false;
            }
            
            return true;
        });
        
        $('#expanded_track_count').text(`${filteredTracks.length} tracks`);
        
        if (filteredTracks.length === 0) {
            list.append('<div style="padding: 2em; text-align: center; opacity: 0.6;">No tracks match your filters</div>');
            return;
        }
        
        filteredTracks.forEach(({ path, source }, index) => {
            const filename = path.split('/').pop();
            const metadata = trackLibrary.metadata[path] || {};
            const allTags = metadata.tags || [];
            
            const displayTags = allTags.filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));
            
            const isCurrentTrack = (currentTrack === path);
            const isSelected = selectedTracks.has(path);
            
            const item = $(`
                <div class="track-item ${isCurrentTrack ? 'current-track' : ''} ${isSelected ? 'selected-track' : ''}" data-path="${path}" data-index="${index}">
                    <input type="checkbox" class="track-checkbox" ${isSelected ? 'checked' : ''}>
                    <div class="track-content">
                        <div class="track-title" data-path="${path}" style="cursor: pointer;">${metadata.title || filename}</div>
                        <div class="track-source">${source}</div>
                        <div class="track-tags">
                            ${displayTags.map(t => `<span class="tag">${t}</span>`).join('')}
                        </div>
                    </div>
                    <button class="menu_button menu_button_icon edit-track" data-path="${path}">
                        <i class="fa-solid fa-edit"></i>
                    </button>
                </div>
            `);
            
            item.css({
                'display': 'flex',
                'align-items': 'center',
                'gap': '0.5em',
                'padding': '0.5em',
                'border-bottom': '1px solid rgba(255, 255, 255, 0.1)',
                'transition': 'background-color 0.2s ease'
            });
            
            if (isSelected) {
                item.css({
                    'background-color': 'rgba(88, 101, 242, 0.2)',
                    'border-left': '3px solid #5865f2'
                });
            }
            
            if (isCurrentTrack) {
                item.css({
                    'background-color': 'rgba(81, 207, 102, 0.2)',
                    'border-left': '3px solid #51cf66'
                });
            }
            
            item.find('.track-checkbox').css({
                'cursor': 'pointer',
                'margin': '0'
            });
            
            item.find('.track-content').css({
                'flex': '1',
                'min-width': '0'
            });
            
            item.find('.track-title').css({
                'font-weight': 'bold',
                'overflow': 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
                'transition': 'color 0.2s ease',
                'color': isCurrentTrack ? '#51cf66' : ''
            });
            
            item.find('.track-title').on('mouseenter', function() {
                $(this).css('color', '#51cf66');
            });
            
            item.find('.track-title').on('mouseleave', function() {
                $(this).css('color', isCurrentTrack ? '#51cf66' : '');
            });
            
            item.find('.track-source').css({
                'font-size': '0.85em',
                'opacity': '0.7',
                'margin-top': '0.1em'
            });
            
            item.find('.track-tags').css({
                'margin-top': '0.25em',
                'display': 'flex',
                'flex-wrap': 'wrap',
                'gap': '0.25em'
            });
            
            item.find('.tag').css({
                'background': 'rgba(88, 101, 242, 0.3)',
                'padding': '0.1em 0.4em',
                'border-radius': '3px',
                'font-size': '0.75em',
                'display': 'inline-block'
            });
            
            item.find('.edit-track').css({
                'flex-shrink': '0'
            });
            
            list.append(item);
        });
        
        attachTrackListHandlers('#expanded_track_list', true); // true = updates both lists
    }
    
    // Filter buttons
    $('.filter-btn').on('click', function() {
        $('.filter-btn').removeClass('active');
        $(this).addClass('active');
        currentFilter = $(this).data('filter');
        updateExpandedList();
    });
    
    // Search input
    $('#track_search').on('input', function() {
        searchQuery = $(this).val();
        updateExpandedList();
    });
    
    $('#close_expanded_tracks').on('click', () => {
        delete window._expandedTrackListUpdate;
        backdrop.remove();
    });
    
    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            delete window._expandedTrackListUpdate;
            backdrop.remove();
        }
    });
    
    modal.on('click', (e) => {
        e.stopPropagation();
    });
    
    updateExpandedList();
}

function updateTrackList() {
    const list = $('#track_list');
    list.empty();
    
    list.css({
        'max-height': '300px',
        'overflow-y': 'auto',
        'border': '1px solid rgba(255, 255, 255, 0.1)',
        'border-radius': '5px',
        'margin-top': '0.5em'
    });
    
    let allTracks = [];
    const context = getContext();
    const currentCharacter = context.name2;
    
    const showGlobal = extension_settings.audio.show_global_tracks !== false;
    const showOnlyCurrentChar = extension_settings.audio.show_only_current_character || false;
    
    // Add character tracks based on filter settings
    if (showOnlyCurrentChar && currentCharacter) {
        // Only show current character's tracks
        if (trackLibrary.character[currentCharacter]) {
            allTracks.push(...trackLibrary.character[currentCharacter].map(t => ({ path: t, source: currentCharacter })));
        }
    } else {
        // Show all character tracks
        Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
            allTracks.push(...tracks.map(t => ({ path: t, source: char })));
        });
    }
    
    // Add global tracks if setting is enabled
    if (showGlobal) {
        allTracks.push(...trackLibrary.global.map(t => ({ path: t, source: 'global' })));
    }
    
    if (allTracks.length === 0) {
        let message = 'No tracks found. Add music files to /assets/bgm/ or /characters/&lt;name&gt;/bgm/';
        if (showOnlyCurrentChar && !currentCharacter) {
            message = 'No character selected. Select a character or disable "Current Character Only".';
        } else if (showOnlyCurrentChar && currentCharacter) {
            message = `No tracks found for ${currentCharacter}. Add music to /characters/${currentCharacter}/bgm/`;
        }
        list.append(`<div style="padding: 1em; text-align: center; opacity: 0.6;">${message}</div>`);
        return;
    }
    
    allTracks.forEach(({ path, source }, index) => {
        const filename = path.split('/').pop();
        const metadata = trackLibrary.metadata[path] || {};
        const allTags = metadata.tags || [];
        
        // Filter out instrumental and emotion tags - only show custom tags
        const displayTags = allTags.filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));
        
        const isCurrentTrack = (currentTrack === path);
        const isSelected = selectedTracks.has(path);
        
        const item = $(`
            <div class="track-item ${isCurrentTrack ? 'current-track' : ''} ${isSelected ? 'selected-track' : ''}" data-path="${path}" data-index="${index}">
                <input type="checkbox" class="track-checkbox" ${isSelected ? 'checked' : ''}>
                <div class="track-content">
                    <div class="track-title" data-path="${path}" style="cursor: pointer;">${metadata.title || filename}</div>
                    <div class="track-source">${source}</div>
                    <div class="track-tags">
                        ${displayTags.map(t => `<span class="tag">${t}</span>`).join('')}
                    </div>
                </div>
                <button class="menu_button menu_button_icon edit-track" data-path="${path}">
                    <i class="fa-solid fa-edit"></i>
                </button>
            </div>
        `);
        
        item.css({
            'display': 'flex',
            'align-items': 'center',
            'gap': '0.5em',
            'padding': '0.5em',
            'border-bottom': '1px solid rgba(255, 255, 255, 0.1)',
            'transition': 'background-color 0.2s ease'
        });
        
        // Highlight selected tracks
        if (isSelected) {
            item.css({
                'background-color': 'rgba(88, 101, 242, 0.2)',
                'border-left': '3px solid #5865f2'
            });
        }
        
        // Highlight current track
        if (isCurrentTrack) {
            item.css({
                'background-color': 'rgba(81, 207, 102, 0.2)',
                'border-left': '3px solid #51cf66'
            });
        }
        
        item.find('.track-checkbox').css({
            'cursor': 'pointer',
            'margin': '0'
        });
        
        item.find('.track-content').css({
            'flex': '1',
            'min-width': '0'
        });
        
        item.find('.track-title').css({
            'font-weight': 'bold',
            'overflow': 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            'transition': 'color 0.2s ease',
            'color': isCurrentTrack ? '#51cf66' : ''
        });
        
        // Add hover effect
        item.find('.track-title').on('mouseenter', function() {
            $(this).css('color', '#51cf66');
        });
        
        item.find('.track-title').on('mouseleave', function() {
            $(this).css('color', isCurrentTrack ? '#51cf66' : '');
        });
        
        item.find('.track-source').css({
            'font-size': '0.85em',
            'opacity': '0.7',
            'margin-top': '0.1em'
        });
        
        item.find('.track-tags').css({
            'margin-top': '0.25em',
            'display': 'flex',
            'flex-wrap': 'wrap',
            'gap': '0.25em'
        });
        
        item.find('.tag').css({
            'background': 'rgba(88, 101, 242, 0.3)',
            'padding': '0.1em 0.4em',
            'border-radius': '3px',
            'font-size': '0.75em',
            'display': 'inline-block'
        });
        
        item.find('.edit-track').css({
            'flex-shrink': '0'
        });
        
        list.append(item);
    });
    
    attachTrackListHandlers('#track_list');
}

function attachTrackListHandlers(containerSelector = '#track_list', updateBothLists = false) {
    // Click track title to play (no modifiers)
    $(`${containerSelector} .track-title`).off('click').on('click', function(e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        
        const path = $(this).data('path');
        
        // Enable audio if not already enabled
        if (!extension_settings.audio.enabled) {
            extension_settings.audio.enabled = true;
            $('#audio_enabled').prop('checked', true);
            updateMiniplayerVisibility();
            saveSettingsDebounced();
        }
        
        // Play the selected track
        playTrack(path);
        
        // Visual feedback
        const title = $(this);
        title.css('color', '#51cf66');
        setTimeout(() => {
            title.css('color', '');
        }, 300);
    });
    
    // Checkbox selection
    $(`${containerSelector} .track-checkbox`).off('change').on('change', function(e) {
        const item = $(this).closest('.track-item');
        const path = item.data('path');
        const index = item.data('index');
        
        if ($(this).is(':checked')) {
            selectedTracks.add(path);
            lastSelectedIndex = index;
        } else {
            selectedTracks.delete(path);
        }
        
        // Sync both lists
        if (updateBothLists) {
            updateTrackList();
            if (window._expandedTrackListUpdate) {
                window._expandedTrackListUpdate();
            }
        } else {
            updateTrackList();
            if (window._expandedTrackListUpdate && containerSelector === '#track_list') {
                window._expandedTrackListUpdate();
            }
        }
        
        updateBulkActionBar();
    });
    
    // Ctrl+click on track row to toggle selection
    $(`${containerSelector} .track-item`).off('click').on('click', function(e) {
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
        if ($(e.target).hasClass('track-checkbox')) return; // Already handled
        if ($(e.target).hasClass('track-title') || $(e.target).closest('.track-title').length) return;
        if ($(e.target).hasClass('edit-track') || $(e.target).closest('.edit-track').length) return;
        
        e.preventDefault();
        const path = $(this).data('path');
        const index = $(this).data('index');
        const checkbox = $(this).find('.track-checkbox');
        
        if (e.shiftKey) {
            // Shift+click for range selection
            if (lastSelectedIndex === -1) {
                // No previous selection, just select this one
                selectedTracks.add(path);
                lastSelectedIndex = index;
            } else {
                // Select range from lastSelectedIndex to currentIndex
                const start = Math.min(lastSelectedIndex, index);
                const end = Math.max(lastSelectedIndex, index);
                
                $(`${containerSelector} .track-item`).each(function() {
                    const idx = $(this).data('index');
                    if (idx >= start && idx <= end) {
                        const itemPath = $(this).data('path');
                        selectedTracks.add(itemPath);
                    }
                });
            }
        } else {
            // Ctrl+click to toggle
            if (selectedTracks.has(path)) {
                selectedTracks.delete(path);
                checkbox.prop('checked', false);
            } else {
                selectedTracks.add(path);
                checkbox.prop('checked', true);
                lastSelectedIndex = index;
            }
        }
        
        // Sync both lists
        if (updateBothLists) {
            updateTrackList();
            if (window._expandedTrackListUpdate) {
                window._expandedTrackListUpdate();
            }
        } else {
            updateTrackList();
            if (window._expandedTrackListUpdate && containerSelector === '#track_list') {
                window._expandedTrackListUpdate();
            }
        }
        
        updateBulkActionBar();
    });
    
    $(`${containerSelector} .edit-track`).off('click').on('click', function() {
        const path = $(this).data('path');
        openTrackEditor(path);
    });
}

// ============================================
// METADATA MIGRATION
// ============================================

function fuzzyMatch(str1, str2) {
    // Simple similarity score based on character overlap
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    // Check if one contains the other
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;
    
    // Count common characters
    const set1 = new Set(s1.split(''));
    const set2 = new Set(s2.split(''));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

function migrateMetadata() {
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
    
    // Show migration UI
    showMigrationUI(suggestions, orphanedMetadata);
    return '';
}

function showMigrationUI(suggestions, orphanedMetadata) {
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
    
    const migrationUI = $(`
        <div class="migration-modal">
            <h3 style="margin-top: 0;">Migrate Track Metadata</h3>
            <p style="opacity: 0.8; margin-bottom: 1em;">
                Found ${suggestions.length} potential matches for renamed tracks. 
                Review and confirm the migrations below.
            </p>
            
            <div id="migration_list" style="max-height: 400px; overflow-y: auto; margin-bottom: 1em;"></div>
            
            <div class="flex-container" style="gap: 0.5em;">
                <button class="menu_button" id="migrate_selected" style="flex: 1;">
                    <i class="fa-solid fa-check"></i> Migrate Selected
                </button>
                <button class="menu_button" id="cancel_migration" style="flex: 1;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);
    
    migrationUI.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '700px',
        'width': '90%',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    const list = migrationUI.find('#migration_list');
    
    suggestions.forEach((suggestion, index) => {
        const tags = suggestion.metadata.tags || [];
        const title = suggestion.metadata.title || '';
        const confidence = Math.round(suggestion.score * 100);
        
        const item = $(`
            <div class="migration-item" style="padding: 0.75em; margin-bottom: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.1);">
                <div style="display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em;">
                    <input type="checkbox" class="migration-checkbox" data-index="${index}" checked style="cursor: pointer;">
                    <div style="flex: 1;">
                        <div style="font-size: 0.85em; opacity: 0.7;">
                            <span style="color: #ff6b6b;">${suggestion.oldFilename}</span> → <span style="color: #51cf66;">${suggestion.newFilename}</span>
                        </div>
                        <div style="font-size: 0.75em; opacity: 0.5; margin-top: 0.2em;">
                            Match confidence: ${confidence}%
                        </div>
                    </div>
                </div>
                ${title ? `<div style="font-size: 0.85em; margin-left: 1.5em;"><strong>Title:</strong> ${title}</div>` : ''}
                ${tags.length > 0 ? `<div style="font-size: 0.85em; margin-left: 1.5em;"><strong>Tags:</strong> ${tags.join(', ')}</div>` : ''}
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
            updateTrackList();
            alert(`Successfully migrated metadata for ${migratedCount} track(s)!`);
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

function openTrackEditor(trackPath) {
    const metadata = trackLibrary.metadata[trackPath] || { tags: [], title: '' };
    const filename = trackPath.split('/').pop();
    
    // Separate instrumental, emotions, and other tags
    const isInstrumental = (metadata.tags || []).includes('instrumental');
    const emotionTags = (metadata.tags || []).filter(t => EMOTION_TAGS.includes(t));
    const otherTags = (metadata.tags || []).filter(t => t !== 'instrumental' && !EMOTION_TAGS.includes(t));
    
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
    
    const emotionCheckboxes = EMOTION_TAGS.map(emotion => {
        const checked = emotionTags.includes(emotion);
        return `
            <label class="checkbox_label" style="display: flex; align-items: center; width: 32%; margin: 0.15em 0; font-size: 0.9em; gap: 0.3em;">
                <input type="checkbox" class="emotion-checkbox" value="${emotion}" ${checked ? 'checked' : ''} style="margin: 0;">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${emotion}</span>
            </label>
        `;
    }).join('');
    
    const editor = $(`
        <div class="track-editor-modal">
            <h3 style="margin-top: 0;">Edit Track</h3>
            <div style="margin-bottom: 1em; font-style: italic; opacity: 0.7;">File: ${filename}</div>
            
            <div style="margin-bottom: 1em;">
                <label for="track_title" style="display: block; margin-bottom: 0.3em;">Display Name</label>
                <div style="display: flex; gap: 0.5em;">
                    <input type="text" class="text_pole" id="track_title" value="${metadata.title || ''}" placeholder="Custom display name (leave empty to use filename)" style="flex: 1;">
                    <button class="menu_button menu_button_icon" id="clean_filename" title="Auto-clean filename">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
                </div>
                <small style="opacity: 0.7; font-size: 0.85em;">This is how the track will appear in lists and the miniplayer</small>
            </div>
            
            <div style="margin-bottom: 1em;">
                <label class="checkbox_label" for="track_instrumental">
                    <input type="checkbox" id="track_instrumental" ${isInstrumental ? 'checked' : ''}>
                    <span>Instrumental (no vocals)</span>
                </label>
            </div>
            
            <div style="margin-bottom: 1em;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em;">
                    <label style="margin: 0;">Emotions (select all that apply)</label>
                    <button class="menu_button menu_button_icon" id="toggle_emotions" title="Show/hide emotions">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="emotion_selector" style="display: none; padding: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; max-height: 200px; overflow-y: auto;">
                    <div style="display: flex; flex-wrap: wrap; gap: 0.25em;">
                        ${emotionCheckboxes}
                    </div>
                </div>
                <div id="selected_emotions" style="margin-top: 0.5em; font-size: 0.85em; opacity: 0.8;">
                    ${emotionTags.length > 0 ? `Selected: ${emotionTags.join(', ')}` : 'No emotions selected'}
                </div>
            </div>
            
            <div style="margin-bottom: 1em;">
                <label for="track_tags" style="display: block; margin-bottom: 0.3em;">Other Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="track_tags" value="${otherTags.join(', ')}" placeholder="e.g. action, ambient, battle, romance">
                <small style="opacity: 0.7; font-size: 0.85em;">For non-emotion descriptors</small>
            </div>
            
            <div class="flex-container" style="gap: 0.5em; margin-top: 1em;">
                <button class="menu_button" id="save_track">
                    <i class="fa-solid fa-save"></i> Save
                </button>
                <button class="menu_button" id="cancel_track">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);
    
    editor.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '500px',
        'width': '90%',
        'max-height': '90vh',
        'overflow-y': 'auto',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
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
        updateTrackList();
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

// ============================================
// PLAYLIST MANAGEMENT
// ============================================

function openPlaylistManager() {
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
    
    const manager = $(`
        <div class="playlist-manager-modal">
            <h3 style="margin-top: 0;">Manage Playlists</h3>
            
            <div id="playlist_list" style="max-height: 300px; overflow-y: auto; margin-bottom: 1em;"></div>
            
            <div class="flex-container flexFlowColumn" style="gap: 0.5em;">
                <button class="menu_button" id="create_smart_playlist" style="width: 100%;">
                    <i class="fa-solid fa-magic"></i> New Smart Playlist
                </button>
                <button class="menu_button" id="create_manual_playlist" style="width: 100%;">
                    <i class="fa-solid fa-list"></i> New Manual Playlist
                </button>
            </div>
            
            <div class="flex-container" style="gap: 0.5em; margin-top: 1em;">
                <button class="menu_button" id="close_playlist_manager">
                    <i class="fa-solid fa-times"></i> Close
                </button>
            </div>
        </div>
    `);
    
    manager.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '600px',
        'width': '90%',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    backdrop.append(manager);
    $('body').append(backdrop);
    
    updatePlaylistList();
    
    $('#create_smart_playlist').on('click', () => createSmartPlaylist());
    $('#create_manual_playlist').on('click', () => createManualPlaylist());
    $('#close_playlist_manager').on('click', () => backdrop.remove());
    
    backdrop.on('click', (e) => {
        if (e.target === backdrop[0]) {
            e.stopPropagation();
            backdrop.remove();
        }
    });
    
    manager.on('click', (e) => {
        e.stopPropagation();
    });
}

function updatePlaylistList() {
    const list = $('#playlist_list');
    list.empty();
    
    const playlists = extension_settings.audio.playlists || {};
    const playlistNames = Object.keys(playlists);
    
    if (playlistNames.length === 0) {
        list.append('<div style="padding: 1em; text-align: center; opacity: 0.6;">No playlists yet. Create one!</div>');
        return;
    }
    
    playlistNames.forEach(name => {
        const playlist = playlists[name];
        const typeLabel = playlist.type === 'smart' ? '✨ Smart' : '📋 Manual';
        let trackCount;
        
        if (playlist.type === 'manual') {
            trackCount = (playlist.tracks || []).length;
        } else {
            let tags = [...(playlist.tags || [])];
            
            // Add emotion tag based on mode (same logic as preview/playback)
            if (playlist.emotion_mode === 'auto') {
                tags.push(currentEmotion);
            } else if (playlist.emotion_mode === 'manual' && playlist.emotion_override) {
                tags.push(playlist.emotion_override);
            }
            
            const includeGlobal = playlist.include_global !== false;
            const matches = filterTracksByTags(tags, null, includeGlobal);
            trackCount = matches.length;
        }
        
        const globalLabel = (playlist.include_global === false) ? ' • Character only' : '';
        
        const item = $(`
            <div class="playlist-item" style="display: flex; align-items: center; gap: 0.5em; padding: 0.5em; border-bottom: 1px solid rgba(255, 255, 255, 0.1);">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: bold;">${name}</div>
                    <div style="font-size: 0.85em; opacity: 0.7;">${typeLabel} • ${trackCount} tracks${globalLabel}</div>
                </div>
                <button class="menu_button menu_button_icon edit-playlist" data-name="${name}">
                    <i class="fa-solid fa-edit"></i>
                </button>
                <button class="menu_button menu_button_icon delete-playlist" data-name="${name}">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `);
        
        list.append(item);
    });
    
    $('.edit-playlist').on('click', function() {
        const name = $(this).data('name');
        editPlaylist(name);
    });
    
    $('.delete-playlist').on('click', function() {
        const name = $(this).data('name');
        if (confirm(`Delete playlist "${name}"?`)) {
            delete extension_settings.audio.playlists[name];
            if (extension_settings.audio.active_playlist === name) {
                extension_settings.audio.active_playlist = null;
            }
            saveSettingsDebounced();
            updatePlaylistList();
            updatePlaylistDropdown();
        }
    });
}

function createSmartPlaylist() {
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
    
    const editor = $(`
        <div class="smart-playlist-editor">
            <h3 style="margin-top: 0;">Create Smart Playlist</h3>
            
            <div style="margin-bottom: 1em;">
                <label for="smart_playlist_name" style="display: block; margin-bottom: 0.3em;">Playlist Name</label>
                <input type="text" class="text_pole" id="smart_playlist_name" placeholder="e.g. Alice's Revenge Arc">
            </div>
            
            <div style="margin-bottom: 1em;">
                <label for="smart_playlist_tags" style="display: block; margin-bottom: 0.3em;">Base Tags (comma-separated)</label>
                <input type="text" class="text_pole" id="smart_playlist_tags" placeholder="e.g. character:alice, arc:revenge, instrumental">
            </div>

            <div style="margin-bottom: 1em;">
                <label class="checkbox_label" for="smart_include_global">
                    <input type="checkbox" id="smart_include_global" checked>
                    <span>Include Global Tracks</span>
                </label>
            </div>
            
            <div style="margin-bottom: 1em;">
                <label style="display: block; margin-bottom: 0.5em;">Emotion Filter</label>
                <div style="margin-left: 1em;">
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
            
            <div id="smart_preview" style="margin-bottom: 1em; padding: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; font-size: 0.85em;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em;">
                    <strong>Preview:</strong>
                    <span id="preview_count">Enter tags to preview</span>
                    <button id="toggle_preview_list" class="menu_button menu_button_icon" style="display: none;">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div id="preview_track_list" style="display: none; height: 130px; overflow-y: auto; padding-top: 0.5em; border-top: 1px solid rgba(255, 255, 255, 0.1);"></div>
            </div>
            
            <div class="flex-container" style="gap: 0.5em;">
                <button class="menu_button" id="save_smart_playlist" style="flex: 1;">
                    <i class="fa-solid fa-save"></i> Create
                </button>
                <button class="menu_button" id="cancel_smart_playlist" style="flex: 1;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);
    
    editor.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '500px',
        'width': '90%',
        'max-height': '90vh',
        'overflow-y': 'auto',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    backdrop.append(editor);
    $('body').append(backdrop);
    
    setTimeout(() => $('#smart_playlist_name').focus(), 100);
    
    // Preview updates
    function updateSmartPreview() {
        const tagsInput = $('#smart_playlist_tags').val().trim();
        const emotionMode = $('input[name="emotion_mode"]:checked').val();
        const emotionOverride = $('#emotion_override').val();
        const includeGlobal = $('#smart_include_global').is(':checked');
        
        let tags = [];
        if (tagsInput) {
            tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
        }
        
        // Add emotion tag based on mode (simulating what will happen during playback)
        if (emotionMode === 'auto') {
            tags.push(currentEmotion); // Use current detected emotion for preview
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
            
            // Build track list
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
    
    // Initial preview
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
            alert('Please enter a playlist name');
            return;
        }
        
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];
        
        // Validate: need either base tags OR an emotion mode that adds tags
        if (tags.length === 0 && emotionMode === 'off') {
            alert('Please enter at least one tag or enable emotion filtering');
            return;
        }
        
        extension_settings.audio.playlists[name] = {
            type: 'smart',
            tags: tags,
            emotion_mode: emotionMode,
            emotion_override: emotionMode === 'manual' ? emotionOverride : null,
            include_global: $('#smart_include_global').is(':checked')
        };
        
        if (extension_settings.audio.debug_mode) {
            debugLog('Created smart playlist:', name, extension_settings.audio.playlists[name]);
        }
        saveSettingsDebounced();
        updatePlaylistList();
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

function createManualPlaylist() {
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
    
    const context = getContext();
    const characterName = context.name2;
    
    const editor = $(`
        <div class="manual-playlist-editor">
            <h3 style="margin-top: 0;">Create Manual Playlist</h3>
            
            <div style="margin-bottom: 1em;">
                <label for="manual_playlist_name" style="display: block; margin-bottom: 0.3em;">Playlist Name</label>
                <input type="text" class="text_pole" id="manual_playlist_name" placeholder="e.g. My Favorites">
            </div>
            
            <div style="margin-bottom: 0.5em;">
                <label class="checkbox_label" for="manual_show_global">
                    <input type="checkbox" id="manual_show_global" checked>
                    <span>Show Global Tracks</span>
                </label>
            </div>
            
            <div style="margin-bottom: 1em;">
                <label style="display: block; margin-bottom: 0.3em;">Select Tracks</label>
                <div id="manual_track_list" style="max-height: 300px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px;">
                </div>
            </div>
            
            <div class="flex-container" style="gap: 0.5em;">
                <button class="menu_button" id="save_manual_playlist" style="flex: 1; white-space: nowrap;">
                    <i class="fa-solid fa-save"></i> Create
                </button>
                <button class="menu_button" id="cancel_manual_playlist" style="flex: 1; white-space: nowrap;">
                    <i class="fa-solid fa-times"></i> Cancel
                </button>
            </div>
        </div>
    `);
    
    editor.css({
        'background': '#1a1a1a',
        'border': '1px solid rgba(255, 255, 255, 0.2)',
        'border-radius': '10px',
        'padding': '1.5em',
        'max-width': '500px',
        'width': '90%',
        'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
        'color': '#e0e0e0'
    });
    
    backdrop.append(editor);
    $('body').append(backdrop);
    
    function updateManualTrackList() {
        const showGlobal = $('#manual_show_global').is(':checked');
        let allTracks = [];
        
        // Add character tracks
        Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
            allTracks.push(...tracks.map(t => ({ path: t, source: char })));
        });
        
        // Add global tracks if enabled
        if (showGlobal) {
            allTracks.push(...trackLibrary.global.map(t => ({ path: t, source: 'global' })));
        }
        
        const trackListHtml = allTracks.map(({ path, source }) => {
            const filename = path.split('/').pop();
            const metadata = trackLibrary.metadata[path] || {};
            return `
                <div style="display: flex; align-items: center; padding: 0.5em; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                    <input type="checkbox" value="${path}" style="margin-right: 0.5em;">
                    <span style="flex: 1;">${metadata.title || filename}</span>
                    <small style="opacity: 0.7;">${source}</small>
                </div>
            `;
        }).join('');
        
        $('#manual_track_list').html(trackListHtml);
    }
    
    updateManualTrackList();
    
    $('#manual_show_global').on('change', updateManualTrackList);
    
    $('#save_manual_playlist').on('click', () => {
        const name = $('#manual_playlist_name').val().trim();
        const selectedTracks = [];
        $('#manual_track_list input:checked').each(function() {
            selectedTracks.push($(this).val());
        });
        
        if (!name) {
            alert('Please enter a playlist name');
            return;
        }
        
        if (selectedTracks.length === 0) {
            alert('Please select at least one track');
            return;
        }
        
        extension_settings.audio.playlists[name] = {
            type: 'manual',
            tracks: selectedTracks
        };
        
        if (extension_settings.audio.debug_mode) {
            debugLog('Created manual playlist:', name, extension_settings.audio.playlists[name]);
        }
        saveSettingsDebounced();
        updatePlaylistList();
        updatePlaylistDropdown();
        backdrop.remove();
    });
    
    $('#cancel_manual_playlist').on('click', () => backdrop.remove());
    
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

function editPlaylist(name) {
    const playlist = extension_settings.audio.playlists[name];
    
    if (playlist.type === 'smart') {
        // Edit smart playlist
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
        
        const editor = $(`
            <div class="smart-playlist-editor">
                <h3 style="margin-top: 0;">Edit Smart Playlist</h3>
                
                <div style="margin-bottom: 1em;">
                    <label for="edit_smart_playlist_name" style="display: block; margin-bottom: 0.3em;">Playlist Name</label>
                    <input type="text" class="text_pole" id="edit_smart_playlist_name" value="${name}">
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label for="edit_smart_playlist_tags" style="display: block; margin-bottom: 0.3em;">Base Tags (comma-separated)</label>
                    <input type="text" class="text_pole" id="edit_smart_playlist_tags" value="${(playlist.tags || []).join(', ')}">
                </div>

                <div style="margin-bottom: 1em;">
                    <label class="checkbox_label" for="edit_smart_include_global">
                        <input type="checkbox" id="edit_smart_include_global" ${playlist.include_global !== false ? 'checked' : ''}>
                        <span>Include Global Tracks</span>
                    </label>
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label style="display: block; margin-bottom: 0.5em;">Emotion Filter</label>
                    <div style="margin-left: 1em;">
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
                
                <div id="edit_smart_preview" style="margin-bottom: 1em; padding: 0.5em; background: rgba(255, 255, 255, 0.05); border-radius: 5px; font-size: 0.85em;">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em;">
                        <strong>Preview:</strong>
                        <span id="edit_preview_count"></span>
                        <button id="edit_toggle_preview_list" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-chevron-down"></i>
                        </button>
                    </div>
                    <div id="edit_preview_track_list" style="display: none; height: 130px; overflow-y: auto; padding-top: 0.5em; border-top: 1px solid rgba(255, 255, 255, 0.1);"></div>
                </div>
                
                <div class="flex-container" style="gap: 0.5em;">
                    <button class="menu_button" id="update_smart_playlist" style="flex: 1; white-space: nowrap;">
                        <i class="fa-solid fa-save"></i> Save Changes
                    </button>
                    <button class="menu_button" id="cancel_edit_smart_playlist" style="flex: 1; white-space: nowrap;">
                        <i class="fa-solid fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        `);
        
        editor.css({
            'background': '#1a1a1a',
            'border': '1px solid rgba(255, 255, 255, 0.2)',
            'border-radius': '10px',
            'padding': '1.5em',
            'max-width': '500px',
            'width': '90%',
            'max-height': '90vh',
            'overflow-y': 'auto',
            'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
            'color': '#e0e0e0'
        });
        
        backdrop.append(editor);
        $('body').append(backdrop);
        
        setTimeout(() => $('#edit_smart_playlist_name').focus(), 100);

        $('input[name="edit_emotion_mode"]').on('change', updateEditPreview);
        $('#edit_emotion_override').on('change', updateEditPreview);
        $('#edit_smart_include_global').on('change', updateEditPreview);
        
        function updateEditPreview() {
            const tagsInput = $('#edit_smart_playlist_tags').val().trim();
            const emotionMode = $('input[name="edit_emotion_mode"]:checked').val();
            const emotionOverride = $('#edit_emotion_override').val();
            const includeGlobal = $('#edit_smart_include_global').is(':checked');
            
            let tags = [];
            if (tagsInput) {
                tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
            }
            
            // Add emotion tag based on mode
            if (emotionMode === 'auto') {
                tags.push(currentEmotion);
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
                alert('Please enter a playlist name');
                return;
            }
            
            // Check if renaming to an existing playlist
            if (newName !== name && extension_settings.audio.playlists[newName]) {
                alert(`A playlist named "${newName}" already exists`);
                return;
            }
            
            const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];
            
            // Validate: need either base tags OR an emotion mode that adds tags
            if (tags.length === 0 && emotionMode === 'off') {
                alert('Please enter at least one tag or enable emotion filtering');
                return;
            }
            
            const playlistData = {
                type: 'smart',
                tags: tags,
                emotion_mode: emotionMode,
                emotion_override: emotionMode === 'manual' ? emotionOverride : null,
                include_global: $('#edit_smart_include_global').is(':checked')
            };
            
            // Handle rename if name changed
            if (newName !== name) {
                delete extension_settings.audio.playlists[name];
                
                // Update active playlist reference if needed
                if (extension_settings.audio.active_playlist === name) {
                    extension_settings.audio.active_playlist = newName;
                    $('#audio_playlist_select').val(newName);
                }
            }
            
            extension_settings.audio.playlists[newName] = playlistData;
            
            saveSettingsDebounced();
            updatePlaylistList();
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
        
    } else {
        // Edit manual playlist
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
        
        const currentTracks = playlist.tracks || [];
        
        const editor = $(`
            <div class="manual-playlist-editor">
                <h3 style="margin-top: 0;">Edit Manual Playlist</h3>
                
                <div style="margin-bottom: 1em;">
                    <label for="edit_manual_playlist_name" style="display: block; margin-bottom: 0.3em;">Playlist Name</label>
                    <input type="text" class="text_pole" id="edit_manual_playlist_name" value="${name}">
                </div>
                
                <div style="margin-bottom: 0.5em;">
                    <label class="checkbox_label" for="edit_manual_show_global">
                        <input type="checkbox" id="edit_manual_show_global" checked>
                        <span>Show Global Tracks</span>
                    </label>
                </div>
                
                <div style="margin-bottom: 1em;">
                    <label style="display: block; margin-bottom: 0.3em;">Select Tracks</label>
                    <div id="edit_manual_track_list" style="max-height: 300px; overflow-y: auto; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px;">
                    </div>
                </div>
                
                <div class="flex-container" style="gap: 0.5em;">
                    <button class="menu_button" id="update_manual_playlist" style="flex: 1; white-space: nowrap;">
                        <i class="fa-solid fa-save"></i> Save Changes
                    </button>
                    <button class="menu_button" id="cancel_edit_manual_playlist" style="flex: 1; white-space: nowrap;">
                        <i class="fa-solid fa-times"></i> Cancel
                    </button>
                </div>
            </div>
        `);
        
        editor.css({
            'background': '#1a1a1a',
            'border': '1px solid rgba(255, 255, 255, 0.2)',
            'border-radius': '10px',
            'padding': '1.5em',
            'max-width': '500px',
            'width': '90%',
            'box-shadow': '0 8px 32px rgba(0, 0, 0, 0.5)',
            'color': '#e0e0e0'
        });
        
        backdrop.append(editor);
        $('body').append(backdrop);
        
        function updateEditManualTrackList() {
            const showGlobal = $('#edit_manual_show_global').is(':checked');
            let allTracks = [];
            
            // Add character tracks
            Object.entries(trackLibrary.character).forEach(([char, tracks]) => {
                allTracks.push(...tracks.map(t => ({ path: t, source: char })));
            });
            
            // Add global tracks if enabled
            if (showGlobal) {
                allTracks.push(...trackLibrary.global.map(t => ({ path: t, source: 'global' })));
            }
            
            const trackListHtml = allTracks.map(({ path, source }) => {
                const filename = path.split('/').pop();
                const metadata = trackLibrary.metadata[path] || {};
                const checked = currentTracks.includes(path) ? 'checked' : '';
                return `
                    <div style="display: flex; align-items: center; padding: 0.5em; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                        <input type="checkbox" value="${path}" ${checked} style="margin-right: 0.5em;">
                        <span style="flex: 1;">${metadata.title || filename}</span>
                        <small style="opacity: 0.7;">${source}</small>
                    </div>
                `;
            }).join('');
            
            $('#edit_manual_track_list').html(trackListHtml);
        }
        
        updateEditManualTrackList();
        
        $('#edit_manual_show_global').on('change', updateEditManualTrackList);
        
        $('#update_manual_playlist').on('click', () => {
            const newName = $('#edit_manual_playlist_name').val().trim();
            
            if (!newName) {
                alert('Please enter a playlist name');
                return;
            }
            
            // Check if renaming to an existing playlist
            if (newName !== name && extension_settings.audio.playlists[newName]) {
                alert(`A playlist named "${newName}" already exists`);
                return;
            }
            
            const selectedTracks = [];
            $('#edit_manual_track_list input:checked').each(function() {
                selectedTracks.push($(this).val());
            });
            
            if (selectedTracks.length === 0) {
                alert('Please select at least one track');
                return;
            }
            
            const playlistData = {
                type: 'manual',
                tracks: selectedTracks
            };
            
            // Handle rename if name changed
            if (newName !== name) {
                delete extension_settings.audio.playlists[name];
                
                // Update active playlist reference if needed
                if (extension_settings.audio.active_playlist === name) {
                    extension_settings.audio.active_playlist = newName;
                    $('#audio_playlist_select').val(newName);
                }
            }
            
            extension_settings.audio.playlists[newName] = playlistData;
            
            debugLog('Updated manual playlist: ' + newName);
            saveSettingsDebounced();
            updatePlaylistList();
            updatePlaylistDropdown();
            backdrop.remove();
        });
        
        $('#cancel_edit_manual_playlist').on('click', () => backdrop.remove());
        
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
}

function updatePlaylistDropdown() {
    const dropdown = $('#audio_playlist_select');
    dropdown.empty();
    
    const playlists = extension_settings.audio.playlists || {};
    const playlistNames = Object.keys(playlists);
    
    if (playlistNames.length === 0) {
        dropdown.append('<option value="">-- No playlists yet --</option>');
    } else {
        dropdown.append('<option value="">-- Select Playlist --</option>');
        playlistNames.forEach(name => {
            const selected = extension_settings.audio.active_playlist === name ? 'selected' : '';
            dropdown.append(`<option value="${name}" ${selected}>${name}</option>`);
        });
    }
}

// Make globally accessible for playlist-from-chat module
window.updatePlaylistDropdown = updatePlaylistDropdown;
window.playTrack = playTrack;
window.updateMiniplayerVisibility = updateMiniplayerVisibility;
window.updateTrackList = updateTrackList;
window.updateModeUI = updateModeUI;

// ============================================
// PLAYLIST CREATION HELPERS (for playlist-from-chat)
// ============================================

function createSmartPlaylistFromTags(name, tags, characterName = null) {
    if (!name || tags.length === 0) {
        console.error(DEBUG_PREFIX, 'Invalid playlist parameters');
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
    
    debugLog( `Created smart playlist: ${name}`);
    return true;
}

function createManualPlaylistFromTracks(name, tracks) {
    if (!name || !tracks || tracks.length === 0) {
        console.error(DEBUG_PREFIX, 'Invalid playlist parameters');
        return false;
    }
    
    extension_settings.audio.playlists[name] = {
        type: 'manual',
        tracks: tracks
    };
    
    saveSettingsDebounced();
    updatePlaylistDropdown();
    
    debugLog( `Created manual playlist: ${name} with ${tracks.length} tracks`);
    return true;
}

// Expose globally for playlist-from-chat module
window.audioExtension = {
    createSmartPlaylistFromTags,
    createManualPlaylistFromTracks,
};

// ============================================
// PLAYBACK ENGINE
// ============================================

function filterTracksByTags(tags, characterName = null, includeGlobal = true) {
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
    
    const matches = tracks.filter(path => {
        const metadata = trackLibrary.metadata[path];
        if (!metadata || !metadata.tags) {
            return false;
        }
        
        const hasAllTags = tags.every(tag => metadata.tags.includes(tag));
        return hasAllTags;
    });
    
    return matches;
}

function selectTrack(skipForward = false) {
    const mode = extension_settings.audio.mode;
    const context = getContext();
    const characterName = context.name2;
    
    let candidates = [];
    
    if (mode === 'instrumental') {
        const tags = ['instrumental'];
        const includeGlobal = extension_settings.audio.instrumental_include_global !== false;
        
        if (extension_settings.audio.emotion_detection) {
            tags.push(currentEmotion);
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
                    tags.push(currentEmotion);
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
    
    if (skipForward && currentTrack) {
        const currentIndex = candidates.indexOf(currentTrack);
        
        if (currentIndex !== -1) {
            const nextIndex = (currentIndex + 1) % candidates.length;
            return candidates[nextIndex];
        } else {
            return candidates[0];
        }
    }
    
    if (extension_settings.audio.shuffle) {
        const availableCandidates = candidates.filter(t => t !== currentTrack);
        const finalCandidates = availableCandidates.length > 0 ? availableCandidates : candidates;
        return finalCandidates[Math.floor(Math.random() * finalCandidates.length)];
    } else {
        const availableCandidates = candidates.filter(t => t !== currentTrack);
        if (availableCandidates.length > 0) {
            return availableCandidates[0];
        }
        return candidates[0];
    }
}

async function playTrack(trackPath) {
    if (!trackPath) return;
    
    debugLog(`Playing track: ${trackPath}`);
    
    if (currentTrack && currentTrack !== trackPath) {
        previousTrack = currentTrack;
    }
    
    const previousCurrentTrack = currentTrack;
    currentTrack = trackPath;
    
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
        updateNowPlaying();
        updateMiniplayerContent();
        updateTrackList(); 
    } catch (error) {
        console.error(DEBUG_PREFIX, 'Error playing track:', error);
        
        const nextTrack = selectTrack(true);
        
        if (nextTrack && nextTrack !== trackPath) {
            setTimeout(() => playTrack(nextTrack), 100);
        } else {
            audio.pause();
            currentTrack = null;
        }
    }
}

function updateNowPlaying() {
    if (!currentTrack) {
        $('#now_playing').text('Nothing playing');
        return;
    }
    
    const metadata = trackLibrary.metadata[currentTrack] || {};
    const filename = currentTrack.split('/').pop();
    $('#now_playing').text(metadata.title || filename);
}

function updateProgressBar() {
    if (isSeeking) return; // Don't update while user is seeking
    
    const audio = $('#audio_bgm')[0];
    
    if (!audio || !audio.duration) {
        $('#audio_progress').val(0);
        $('#audio_current_time').text('0:00');
        $('#audio_duration').text('0:00');
        return;
    }
    
    const percent = (audio.currentTime / audio.duration) * 100;
    $('#audio_progress').val(percent);
    
    $('#audio_current_time').text(formatTime(audio.currentTime));
    $('#audio_duration').text(formatTime(audio.duration));
}

function formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function detectEmotion() {
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
        'remorseful': 'remorse'
    };
    
    return emotionMap[expressionName] || 'neutral';
}

// ============================================
// MODULE WORKER
// ============================================

async function moduleWorker() {
    if (!extension_settings.audio.enabled) return;
    
    // Check if character changed and auto-rescan
    const context = getContext();
    const currentCharacter = context.name2;
    if (currentCharacter && currentCharacter !== lastCharacterName) {
        debugLog(`Character changed to: ${currentCharacter} - Auto-rescanning tracks...`);
        lastCharacterName = currentCharacter;
        await scanTracks();
    }
    
    if (cooldownTimer > 0) {
        cooldownTimer -= UPDATE_INTERVAL;
    }
    
    // Update progress bars
    updateProgressBar();
    updateMiniplayerProgress();
    
    const newEmotion = detectEmotion();
    if (newEmotion !== currentEmotion) {
        currentEmotion = newEmotion;
        debugLog(`Emotion changed to: ${currentEmotion}`);
        
        if (cooldownTimer <= 0 && !extension_settings.audio.loop_single) {
            const track = selectTrack();
            if (track && track !== currentTrack) {
                await playTrack(track);
                cooldownTimer = extension_settings.audio.cooldown * 1000;
            }
        }
    }
}

// ============================================
// SLASH COMMANDS
// ============================================

function handleAudioCommand(args, value) {
    // Action commands (no arguments)
    if (value) {
        const action = value.toLowerCase().trim();
        
        switch (action) {
            case 'on':
                extension_settings.audio.enabled = true;
                $('#audio_enabled').prop('checked', true);
                const track = selectTrack();
                if (track) playTrack(track);
                updateMiniplayerVisibility();
                saveSettingsDebounced();
                return 'Audio enabled';
                
            case 'off':
                extension_settings.audio.enabled = false;
                $('#audio_enabled').prop('checked', false);
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
                
            case 'status':
                const status = [];
                status.push(`Enabled: ${extension_settings.audio.enabled ? 'Yes' : 'No'}`);
                status.push(`Mode: ${extension_settings.audio.mode}`);
                status.push(`Volume: ${extension_settings.audio.bgm_volume}%`);
                if (extension_settings.audio.mode === 'playlist' && extension_settings.audio.active_playlist) {
                    status.push(`Active Playlist: ${extension_settings.audio.active_playlist}`);
                }
                if (currentTrack) {
                    const metadata = trackLibrary.metadata[currentTrack] || {};
                    const filename = currentTrack.split('/').pop();
                    status.push(`Now Playing: ${metadata.title || filename}`);
                }
                status.push(`Emotion Detection: ${extension_settings.audio.emotion_detection ? 'On' : 'Off'}`);
                if (extension_settings.audio.emotion_detection) {
                    status.push(`Current Emotion: ${currentEmotion}`);
                }
                status.push(`Shuffle: ${extension_settings.audio.shuffle ? 'On' : 'Off'}`);
                status.push(`Loop: ${extension_settings.audio.loop_single ? 'On' : 'Off'}`);
                status.push(`Miniplayer: ${extension_settings.audio.miniplayer_enabled ? 'On' : 'Off'}`);
                if (extension_settings.audio.miniplayer_enabled) {
                    status.push(`Miniplayer Position: ${extension_settings.audio.miniplayer_position}`);
                }
                return status.join('\n');
                
            case 'nowplaying':
                if (!currentTrack) return '';
                const metadata = trackLibrary.metadata[currentTrack] || {};
                const filename = currentTrack.split('/').pop();
                return metadata.title || filename;
        }
    }
    
    // Handle track addition to playlist
    // /d-audio "track-name" playlist="My Playlist"
    if (value && args.playlist) {
        const trackQuery = value.trim();
        const playlistName = args.playlist;
        
        // Find track by name or title
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
            // Get current mode
            return extension_settings.audio.mode;
        } else if (['instrumental', 'songs', 'playlist'].includes(args.mode)) {
            extension_settings.audio.mode = args.mode;
            $('#audio_mode').val(args.mode);
            updateModeUI();
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
        const playlistValue = args.playlist || value; // Support both /d-audio playlist and /d-audio playlist="name"
        
        if (!playlistValue || playlistValue === '') {
            // Get current playlist
            return extension_settings.audio.active_playlist || '';
        } else {
            if (extension_settings.audio.playlists[playlistValue]) {
                extension_settings.audio.active_playlist = playlistValue;
                $('#audio_playlist_select').val(playlistValue);
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
            $('#audio_songs_emotion_filter').val(args.emotion);
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
            $('#audio_emotion_detection').prop('checked', enabled);
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
            $('#audio_shuffle').prop('checked', enabled);
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
            $('#audio_loop_single').prop('checked', enabled);
            $('#audio_bgm')[0].loop = enabled;
            if (enabled) {
                $('#audio_loop_single').addClass('redOverlayGlow');
            } else {
                $('#audio_loop_single').removeClass('redOverlayGlow');
            }
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
                $('#audio_bgm_volume_slider').val(vol);
                $('#audio_bgm_volume').text(vol);
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
            $('#audio_miniplayer_enabled').prop('checked', enabled);
            updateMiniplayerVisibility();
            hasChanges = true;
            results.push(`Miniplayer: ${enabled ? 'on' : 'off'}`);
        }
    }
    
    // Position
    if ('position' in args) {
        if (args.position === '') {
            return extension_settings.audio.miniplayer_position;
        } else if (['top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(args.position)) {
            extension_settings.audio.miniplayer_position = args.position;
            $('#audio_miniplayer_position').val(args.position);
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
                $('#audio_cooldown').val(cd);
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

// ============================================
// EVENT HANDLERS
// ============================================

function onEnabledClick() {
    extension_settings.audio.enabled = $('#audio_enabled').is(':checked');
    
    if (extension_settings.audio.enabled) {
        const track = selectTrack();
        if (track) playTrack(track);
    } else {
        $('#audio_bgm')[0].pause();
    }
    
    updateMiniplayerVisibility();
    saveSettingsDebounced();
}

function onModeChange() {
    extension_settings.audio.mode = $('#audio_mode').val();
    updateModeUI();
    
    if (extension_settings.audio.enabled) {
        const track = selectTrack();
        if (track) playTrack(track);
    }
    
    saveSettingsDebounced();
}

function onVolumeChange() {
    extension_settings.audio.bgm_volume = parseInt($('#audio_bgm_volume_slider').val());
    $('#audio_bgm_volume').text(extension_settings.audio.bgm_volume);
    $('#audio_bgm')[0].volume = extension_settings.audio.bgm_volume * 0.01;
    
    // Update miniplayer volume slider
    $('#miniplayer_volume').val(extension_settings.audio.bgm_volume);
    
    // Update icons
    updateMiniplayerContent();
    
    saveSettingsDebounced();
}

function onMuteClick() {
    extension_settings.audio.bgm_muted = !extension_settings.audio.bgm_muted;
    $('#audio_bgm')[0].muted = extension_settings.audio.bgm_muted;
    
    const icon = extension_settings.audio.bgm_muted ? 'fa-volume-mute' : 'fa-volume-high';
    $('#audio_bgm_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass(icon);
    $('#miniplayer_mute_icon').removeClass('fa-volume-high fa-volume-mute').addClass(icon);
    
    saveSettingsDebounced();
}

function onSkipTrack() {
    const track = selectTrack(true);
    if (track) {
        playTrack(track);
        cooldownTimer = extension_settings.audio.cooldown * 1000;
    }
}

function onPreviousTrack() {
    if (previousTrack) {
        const temp = currentTrack;
        playTrack(previousTrack);
        previousTrack = temp;
    }
}

function onProgressInput() {
    const audio = $('#audio_bgm')[0];
    if (!audio.duration) return;
    
    const percent = parseFloat($('#audio_progress').val());
    const newTime = (percent / 100) * audio.duration;
    audio.currentTime = newTime;
    
    updateProgressBar();
}

// ============================================
// INITIALIZATION
// ============================================

jQuery(async () => {
    debugLog('Loading Dynamic Audio Redux...');
    
    const emotionOptionsHtml = EMOTION_TAGS.map(tag => 
        `<option value="${tag}">${tag.charAt(0).toUpperCase() + tag.slice(1)}</option>`
    ).join('');
    
    const settingsHtml = `
    <div id="audio_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Dynamic Audio Redux</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                
                <div class="flex-container">
                    <label class="checkbox_label" for="audio_enabled">
                        <input type="checkbox" id="audio_enabled">
                        <span>Enabled</span>
                    </label>
                </div>
                
                <div class="flex-container flexFlowColumn">
                    <label for="audio_mode"><b>Mode</b></label>
                    <select id="audio_mode" class="text_pole">
                        <option value="instrumental">Instrumental</option>
                        <option value="songs">Songs</option>
                        <option value="playlist">Playlist</option>
                    </select>
                </div>
                
                <!-- Instrumental Mode Controls -->
                <div id="instrumental_controls" style="display: none;">
                    <div class="flex-container" style="gap: 1em;">
                        <label class="checkbox_label" for="audio_emotion_detection">
                            <input type="checkbox" id="audio_emotion_detection">
                            <span>Auto-switch based on emotion</span>
                        </label>
                        <label class="checkbox_label" for="audio_instrumental_include_global">
                            <input type="checkbox" id="audio_instrumental_include_global">
                            <span>Include Global</span>
                        </label>
                    </div>
                </div>
                
                <!-- Songs Mode Controls -->
                <div id="songs_controls" style="display: none;">
                    <div class="flex-container flexFlowColumn">
                        <label for="audio_songs_emotion_filter">Filter by Emotion</label>
                        <select id="audio_songs_emotion_filter" class="text_pole">
                            <option value="all">All Songs</option>
                            ${emotionOptionsHtml}
                        </select>
                    </div>
                    <div class="flex-container" style="gap: 1em; margin-top: 0.5em;">
                        <label class="checkbox_label" for="audio_shuffle">
                            <input type="checkbox" id="audio_shuffle">
                            <span>Shuffle</span>
                        </label>
                        <label class="checkbox_label" for="audio_songs_include_global">
                            <input type="checkbox" id="audio_songs_include_global">
                            <span>Include Global</span>
                        </label>
                    </div>
                </div>
                
                <!-- Playlist Controls -->
                <div id="playlist_controls" style="display: none;">
                    <div class="flex-container flexFlowColumn">
                        <label for="audio_playlist_select">Active Playlist</label>
                        <select id="audio_playlist_select" class="text_pole">
                            <option value="">-- Select Playlist --</option>
                        </select>
                    </div>
                    <button id="audio_playlist_manage" class="menu_button" style="width: 100%; margin-top: 0.5em;">
                        <i class="fa-solid fa-list"></i> Manage Playlists
                    </button>
                </div>
                
                <hr>
                
                <!-- Miniplayer Settings -->
                <div class="flex-container flexFlowColumn">
                    <h4>Miniplayer</h4>
                    <label class="checkbox_label" for="audio_miniplayer_enabled">
                        <input type="checkbox" id="audio_miniplayer_enabled">
                        <span>Enable Miniplayer</span>
                    </label>
                    <div class="flex-container flexFlowColumn" style="margin-top: 0.5em;">
                        <label for="audio_miniplayer_position">Position</label>
                        <select id="audio_miniplayer_position" class="text_pole">
                            <option value="top-right">Top Right</option>
                            <option value="top-left">Top Left</option>
                            <option value="bottom-right">Bottom Right</option>
                            <option value="bottom-left">Bottom Left</option>
                        </select>
                    </div>
                </div>
                
                <hr>
                
                <div class="flex-container flexFlowColumn">
                    <h4>Now Playing</h4>
                    <div id="now_playing" style="font-style: italic; margin-bottom: 0.5em;">Nothing playing</div>
                    
                    <!-- Progress Bar -->
                    <div style="display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em;">
                        <span id="audio_current_time" style="font-size: 0.85em; min-width: 3em;">0:00</span>
                        <input type="range" id="audio_progress" min="0" max="100" value="0" step="0.1" style="flex: 1; cursor: pointer;">
                        <span id="audio_duration" style="font-size: 0.85em; min-width: 3em; text-align: right;">0:00</span>
                    </div>
                    
                    <!-- Volume Control -->
                    <div class="flex-container alignItemsCenter" style="margin-bottom: 0.5em;">
                        <button id="audio_bgm_mute" class="menu_button menu_button_icon">
                            <i class="fa-solid fa-volume-high" id="audio_bgm_mute_icon"></i>
                        </button>
                        <input type="range" id="audio_bgm_volume_slider" min="0" max="100" value="50" style="flex: 1;">
                        <span id="audio_bgm_volume" style="min-width: 3em; text-align: right;">50</span>%
                    </div>
                    
                    <!-- Playback Controls -->
                    <div class="flex-container" style="gap: 0.5em;">
                        <button id="audio_previous" class="menu_button">
                            <i class="fa-solid fa-backward"></i> Previous
                        </button>
                        <button id="audio_skip" class="menu_button">
                            <i class="fa-solid fa-forward"></i> Skip
                        </button>
                        <button id="audio_loop_single" class="menu_button">
                            <i class="fa-solid fa-repeat-1"></i> Loop
                        </button>
                    </div>
                    <audio id="audio_bgm" style="display: none;"></audio>
                </div>
                
                <hr>
                
                <div class="flex-container flexFlowColumn">
                    <label for="audio_cooldown">Cooldown between auto-switches (seconds)</label>
                    <input id="audio_cooldown" class="text_pole" type="number" value="30" min="0">
                </div>
                
                <hr>
                
                <div class="flex-container flexFlowColumn">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5em;">
                        <h4 style="margin: 0;">Track Library</h4>
                        <button id="audio_expand_tracks" class="menu_button menu_button_icon" title="Expand track list">
                            <i class="fa-solid fa-expand"></i>
                        </button>
                    </div>
                    <button id="audio_scan_tracks" class="menu_button" style="width: 100%;">
                        <i class="fa-solid fa-refresh"></i> Scan for Tracks
                    </button>
                    <button id="audio_auto_tag" class="menu_button" style="width: 100%; margin-top: 0.3em;">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Auto-Tag Untagged Tracks
                    </button>
                    <div class="flex-container flexFlowColumn" style="margin-top: 0.5em; gap: 0.3em;">
                        <label class="checkbox_label" for="audio_show_global_tracks">
                            <input type="checkbox" id="audio_show_global_tracks">
                            <span>Show Global Tracks</span>
                        </label>
                        <label class="checkbox_label" for="audio_show_only_current_character">
                            <input type="checkbox" id="audio_show_only_current_character">
                            <span>Current Character Only</span>
                        </label>
                    </div>
                    <div id="track_list" style="max-height: 300px; overflow-y: auto;"></div>
                </div>
                
            </div>
        </div>
    </div>
    `;
    
    $('#audio_settings').remove();
    $('#extensions_settings').append(settingsHtml);
    
    loadSettings();
    
    // Event handlers
    $('#audio_enabled').on('click', onEnabledClick);
    $('#audio_mode').on('change', onModeChange);
    $('#audio_bgm_volume_slider').on('input', onVolumeChange);
    $('#audio_bgm_mute').on('click', onMuteClick);
    $('#audio_previous').on('click', onPreviousTrack);
    $('#audio_skip').on('click', onSkipTrack);
    $('#audio_scan_tracks').on('click', scanTracks);
    
    $('#audio_auto_tag').on('click', () => {
        const autoTag = new AutoTag(trackLibrary, extension_settings, saveMetadata, EMOTION_TAGS, generateRaw);
        autoTag.openModal();
    });
    
    $('#audio_expand_tracks').on('click', openExpandedTrackList);
    
    // Miniplayer settings
    $('#audio_miniplayer_enabled').on('change', () => {
        extension_settings.audio.miniplayer_enabled = $('#audio_miniplayer_enabled').is(':checked');
        updateMiniplayerVisibility();
        saveSettingsDebounced();
    });
    
    $('#audio_miniplayer_position').on('change', () => {
        extension_settings.audio.miniplayer_position = $('#audio_miniplayer_position').val();
        updateMiniplayerPosition();
        saveSettingsDebounced();
    });
    
    // Progress bar seeking
    $('#audio_progress').on('mousedown touchstart', () => {
        isSeeking = true;
    });
    
    $('#audio_progress').on('mouseup touchend', () => {
        isSeeking = false;
        onProgressInput();
    });
    
    $('#audio_progress').on('input', () => {
        if (isSeeking) {
            const audio = $('#audio_bgm')[0];
            if (audio.duration) {
                const percent = parseFloat($('#audio_progress').val());
                const newTime = (percent / 100) * audio.duration;
                $('#audio_current_time').text(formatTime(newTime));
            }
        }
    });
    
    $('#audio_loop_single').on('click', () => {
        extension_settings.audio.loop_single = !extension_settings.audio.loop_single;
        $('#audio_bgm')[0].loop = extension_settings.audio.loop_single;
        $('#audio_loop_single').toggleClass('redOverlayGlow');
        saveSettingsDebounced();
    });
    
    $('#audio_shuffle').on('change', () => {
        extension_settings.audio.shuffle = $('#audio_shuffle').is(':checked');
        saveSettingsDebounced();
    });
    
    $('#audio_songs_include_global').on('change', () => {
        extension_settings.audio.songs_include_global = $('#audio_songs_include_global').is(':checked');
        saveSettingsDebounced();
        
        // If audio is playing in songs mode, select new track with updated filter
        if (extension_settings.audio.enabled && extension_settings.audio.mode === 'songs') {
            const track = selectTrack();
            if (track) playTrack(track);
        }
    });
    
    $('#audio_emotion_detection').on('change', () => {
        extension_settings.audio.emotion_detection = $('#audio_emotion_detection').is(':checked');
        saveSettingsDebounced();
    });
    
    $('#audio_instrumental_include_global').on('change', () => {
        extension_settings.audio.instrumental_include_global = $('#audio_instrumental_include_global').is(':checked');
        saveSettingsDebounced();
        
        // If audio is playing in instrumental mode, select new track with updated filter
        if (extension_settings.audio.enabled && extension_settings.audio.mode === 'instrumental') {
            const track = selectTrack();
            if (track) playTrack(track);
        }
    });
    
    $('#audio_songs_emotion_filter').on('change', () => {
        extension_settings.audio.songs_emotion_filter = $('#audio_songs_emotion_filter').val();
        saveSettingsDebounced();
        
        if (extension_settings.audio.enabled && extension_settings.audio.mode === 'songs') {
            const track = selectTrack();
            if (track) playTrack(track);
        }
    });
    
    $('#audio_playlist_select').on('change', () => {
        extension_settings.audio.active_playlist = $('#audio_playlist_select').val();
        saveSettingsDebounced();
        
        if (extension_settings.audio.enabled && extension_settings.audio.mode === 'playlist') {
            const track = selectTrack();
            if (track) playTrack(track);
        }
    });
    
    $('#audio_playlist_manage').on('click', () => {
        openPlaylistManager();
    });
    
    $('#audio_cooldown').on('input', () => {
        extension_settings.audio.cooldown = parseInt($('#audio_cooldown').val());
        saveSettingsDebounced();
    });
    
    
    $('#audio_show_global_tracks').on('change', () => {
        extension_settings.audio.show_global_tracks = $('#audio_show_global_tracks').is(':checked');
        saveSettingsDebounced();
        updateTrackList();
    });

    $('#audio_show_only_current_character').on('change', () => {
        extension_settings.audio.show_only_current_character = $('#audio_show_only_current_character').is(':checked');
        saveSettingsDebounced();
        updateTrackList();
    });
    
    // Track ended handler
    $('#audio_bgm').on('ended', () => {
        if (!extension_settings.audio.loop_single) {
            const track = selectTrack(true);
            if (track) playTrack(track);
        }
    });
    
    // Audio metadata loaded
    $('#audio_bgm').on('loadedmetadata', () => {
        updateProgressBar();
        updateMiniplayerProgress();
    });
    
    // Initial scan
    const context = getContext();
    lastCharacterName = context.name2;
    
    await scanTracks();
    
    updatePlaylistDropdown();
    
    const totalTracks = trackLibrary.global.length + 
        Object.values(trackLibrary.character).reduce((sum, tracks) => sum + tracks.length, 0);
    const totalMetadata = Object.keys(trackLibrary.metadata).length;
    
    debugLog(`Loaded ${totalTracks} tracks with ${totalMetadata} tagged`);
    
    if (totalTracks === 0) {
        $('#track_list').html(`
            <div style="padding: 1em; text-align: center; opacity: 0.6;">
                <p>No tracks found!</p>
                <p style="font-size: 0.85em; margin-top: 0.5em;">
                    Add music files to:<br>
                    <code>/data/&lt;user&gt;/assets/bgm/</code><br>
                    or<br>
                    <code>/data/&lt;user&gt;/characters/&lt;name&gt;/bgm/</code>
                </p>
            </div>
        `);
    }
    
    const wrapper = new ModuleWorkerWrapper(moduleWorker);
    setInterval(wrapper.update.bind(wrapper), UPDATE_INTERVAL);
    
    // Add extensions menu link for playlist from chat
    const $extensionsMenu = $('#extensionsMenu');
    if ($extensionsMenu.length > 0) {
        const $playlistMenuItem = $(`
            <div class="list-group-item flex-container flexGap5 interactable" id="audio_playlist_from_chat_btn">
                <i class="fa-solid fa-music"></i>
                <span>Create Playlist from Chat</span>
            </div>
        `);
        
        $extensionsMenu.append($playlistMenuItem);
        
        $playlistMenuItem.on('click', () => {
            const playlistFromChat = new PlaylistFromChat(trackLibrary, extension_settings, saveSettingsDebounced, generateRaw);
            playlistFromChat.openModal();
        });
    }
    
    // Register slash command using the simple API
    registerSlashCommand(
        COMMAND_NAME,
        handleAudioCommand,
        [],
        `<div>
            <strong>/d-audio</strong> - Control Dynamic Audio Redux
            <br><br>
            <strong>Actions:</strong> on, off, skip, prev, scan, migrate, status, nowplaying
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