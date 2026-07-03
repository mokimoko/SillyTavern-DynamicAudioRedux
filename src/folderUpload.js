/*
 * folderUpload.js — Upload audio into user/files/ from within SillyTavern.
 *
 * This is the companion to folderImport.js. Where import *verifies* files the
 * user already placed on disk, upload *sends* files from the user's machine
 * into user/files/<folder>/ via the Nebula Loader server plugin, then registers
 * them with DAR exactly like an import would.
 *
 * Why a plugin and not core's /api/files/upload: core's endpoint rejects any
 * filename containing '/', so it can't create the subfolders DAR organizes
 * audio into. Nebula Loader exposes /api/plugins/nebula-loader/audio/upload,
 * which validates each path segment, creates real subfolders, and writes the
 * bytes — all scoped to the logged-in user's files/ directory.
 *
 * Availability: this whole feature is gated on the plugin being present. The
 * caller (audioModal) probes isAudioUploadAvailable() and only reveals the
 * Upload button when it resolves true, so a user without Nebula Loader never
 * sees a button that can't work.
 */

import { getRequestHeaders } from '../../../../../script.js';
import {
    addFolder,
    registerImportedTracks,
    getFolders,
} from './dataStore.js';
import { buildImportedTrackUrl } from './folderImport.js';
import { scanTracks } from './scanner.js';
import { darToast } from './ui.js';
import { DEBUG_PREFIX, debugLog, debugError } from './state.js';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

const NEBULA_BASE = '/api/plugins/nebula-loader';
// Cap mirrors the plugin's AUDIO_UPLOAD_MAX_FILES so we fail fast client-side
// with a clear message instead of eating a 400 from the server.
const MAX_FILES_PER_UPLOAD = 200;

// ============================================================
// Plugin availability probe
// ============================================================

// Cached features object from /info, so we don't re-hit it per modal open.
// null = not yet probed (or last probe was a transient failure worth retrying).
let _featuresCache = null;

/**
 * Fetch Nebula Loader's /info once and cache its features object. Returns the
 * features object on success, or null on any failure. A null result is NOT
 * cached (left as null) so a later call can retry after a transient hiccup;
 * a parseable response — even one lacking a given feature — is cached.
 */
async function probeFeatures() {
    if (_featuresCache !== null) return _featuresCache;
    try {
        const r = await fetch(`${NEBULA_BASE}/info`, {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (!r.ok) return null;
        const info = await r.json();
        _featuresCache = info?.features || {};
        return _featuresCache;
    } catch {
        // Plugin absent, server plugins disabled, or network hiccup — treat as
        // unavailable for now, but don't poison the cache so a later open retries.
        return null;
    }
}

/**
 * True if the plugin advertises the audioUpload feature (imported-folder upload
 * into user/files/). Resolves false when the plugin is absent or the feature
 * is missing, so the caller can keep the button hidden.
 */
export async function isAudioUploadAvailable() {
    const features = await probeFeatures();
    return Boolean(features?.audioUpload);
}

/**
 * True if the plugin advertises the bgmUpload feature (flat upload into the
 * global assets/bgm/ folder).
 */
export async function isBgmUploadAvailable() {
    const features = await probeFeatures();
    return Boolean(features?.bgmUpload);
}

// ============================================================
// Small helpers
// ============================================================

function _esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Sanitize a single path segment to the charset the Nebula plugin accepts
 * (alphanumeric, '_', '-', '.'). Mirrors DAR's existing safeBaseName approach
 * in playlists.js, applied per-segment. Returns '' if nothing usable remains.
 */
function sanitizeSegment(raw) {
    return String(raw)
        .trim()
        .replace(/[^\w.-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '');
}

/**
 * Sanitize a folder path that may contain '/' separators (e.g. a nested target
 * like "Combat/Bosses"). Each segment is cleaned independently; empty segments
 * are dropped. Returns a normalized "a/b/c" string, or '' if nothing remains.
 */
function sanitizeFolderPath(raw) {
    return String(raw)
        .split('/')
        .map(sanitizeSegment)
        .filter(Boolean)
        .join('/');
}

/**
 * Preserve a file's own subfolder structure from a webkitdirectory selection,
 * if present, while sanitizing each part. For a plain multi-file selection
 * (no webkitRelativePath beyond the bare name) this just returns the cleaned
 * filename. The top-level directory of a webkitdirectory pick is stripped,
 * because the user's chosen target folder replaces it.
 */
function relativeAudioPath(file) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    // Drop the top-level folder name from a directory pick; keep intermediate
    // subfolders. A flat selection has a single part (the filename).
    const meaningful = parts.length > 1 ? parts.slice(1) : parts;
    const cleaned = meaningful.map((p, i) =>
        i === meaningful.length - 1
            ? sanitizeFilename(p)
            : sanitizeSegment(p)
    ).filter(Boolean);
    return cleaned.join('/');
}

/**
 * Clean a filename while preserving its extension. The base is sanitized to the
 * accepted charset; the extension is lowercased. Returns '' if the base becomes
 * empty (caller treats that as "skip this file").
 */
function sanitizeFilename(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return sanitizeSegment(name);
    const base = sanitizeSegment(name.slice(0, dot));
    const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
    return base ? `${base}.${ext}` : '';
}

// ============================================================
// Upload transport
// ============================================================

/**
 * POST a batch of { name, data } files to the Nebula upload route.
 * `name` is a relative path under user/files/ (e.g. "Combat/boss.mp3").
 * Returns the parsed server response: { ok, written, failed, results }.
 * Throws on transport/HTTP error so the caller can surface it.
 */
async function postAudioBatch(files) {
    const response = await fetch(`${NEBULA_BASE}/audio/upload`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ files }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Upload failed (${response.status})${text ? `: ${text}` : ''}`);
    }
    return response.json();
}

// ============================================================
// Modal
// ============================================================

/**
 * Open the upload modal. Lets the user pick audio files, choose a destination
 * (an existing registered folder — optionally into a nested subpath — or a new
 * folder), upload them via the Nebula plugin, then register + rescan so the
 * tracks appear in the library immediately.
 */
export function openFolderUploadModal() {
    const existing = document.querySelector('.dar-folder-upload-backdrop');
    if (existing) existing.remove();

    const folders = getFolders();
    const hasFolders = folders.length > 0;

    const backdrop = document.createElement('div');
    backdrop.className = 'dar-sub-backdrop dar-folder-upload-backdrop';
    backdrop.innerHTML = `
        <div class="dar-sub-modal dar-sub-modal--lg" role="dialog" aria-label="Upload Audio">
            <h3><i class="fa-solid fa-upload"></i> Upload Audio</h3>

            <p class="dar-sub-note">
                Send audio files from your device straight into
                <code>user/files/</code> on the server — no need to copy them in
                by hand first. Files are organized into the folder you choose below.
            </p>

            <div class="dar-upload-dest">
                <div class="dar-upload-dest-title">Destination</div>

                <label class="dar-upload-radio">
                    <input type="radio" name="dar-upload-dest" value="new" checked>
                    <span>New folder</span>
                </label>
                <input type="text" class="dar-upload-text" data-dar="upload-new-name"
                       placeholder="e.g. Battle Themes" maxlength="120">

                <label class="dar-upload-radio ${hasFolders ? '' : 'dar-upload-radio--disabled'}">
                    <input type="radio" name="dar-upload-dest" value="existing" ${hasFolders ? '' : 'disabled'}>
                    <span>Existing folder${hasFolders ? '' : ' (none registered yet)'}</span>
                </label>
                <div class="dar-upload-existing-row" data-dar="upload-existing-row" hidden>
                    <select class="dar-upload-select" data-dar="upload-existing-select">
                        ${folders.map(f => `<option value="${_esc(f)}">${_esc(f)}</option>`).join('')}
                    </select>
                    <input type="text" class="dar-upload-text" data-dar="upload-subpath"
                           placeholder="optional subfolder, e.g. Bosses" maxlength="120">
                </div>
            </div>

            <div class="dar-folder-pick-row">
                <input type="file" data-dar="upload-input" accept="audio/*" multiple style="display:none;">
                <button type="button" class="dar-text-btn" data-dar="upload-browse">
                    <i class="fa-solid fa-music"></i> Choose Files…
                </button>
                <span class="dar-folder-pick-status" data-dar="upload-pick-status"></span>
            </div>

            <div class="dar-folder-verify-list dar-sub-list" data-dar="upload-file-list" hidden></div>

            <div class="dar-sub-actions">
                <button type="button" class="dar-text-btn" data-dar="upload-cancel">Cancel</button>
                <button type="button" class="dar-text-btn" data-dar="upload-confirm" hidden>
                    <i class="fa-solid fa-upload"></i> Upload
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const q = sel => backdrop.querySelector(`[data-dar="${sel}"]`);

    const $browse      = q('upload-browse');
    const $input       = q('upload-input');
    const $pickStatus  = q('upload-pick-status');
    const $fileList    = q('upload-file-list');
    const $cancel      = q('upload-cancel');
    const $confirm     = q('upload-confirm');
    const $newName     = q('upload-new-name');
    const $existingRow = q('upload-existing-row');
    const $existingSel = q('upload-existing-select');
    const $subpath     = q('upload-subpath');

    // Selected File objects (audio only), kept across re-renders.
    let picked = [];

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    $cancel.addEventListener('click', close);

    // Toggle the existing-folder row based on the chosen destination radio.
    backdrop.querySelectorAll('input[name="dar-upload-dest"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const mode = backdrop.querySelector('input[name="dar-upload-dest"]:checked').value;
            $existingRow.hidden = mode !== 'existing';
            $newName.disabled = mode !== 'new';
        });
    });

    $browse.addEventListener('click', () => $input.click());

    $input.addEventListener('change', () => {
        const all = Array.from($input.files || []);
        picked = all.filter(f => AUDIO_RE.test(f.name));
        const skipped = all.length - picked.length;

        if (picked.length === 0) {
            $pickStatus.textContent = all.length === 0
                ? ''
                : `No audio files in selection (looked for ${AUDIO_EXTENSIONS.join(', ')}).`;
            $fileList.hidden = true;
            $confirm.hidden = true;
            return;
        }

        if (picked.length > MAX_FILES_PER_UPLOAD) {
            $pickStatus.textContent =
                `${picked.length} files selected — please upload at most ${MAX_FILES_PER_UPLOAD} at a time.`;
            $fileList.hidden = true;
            $confirm.hidden = true;
            return;
        }

        $pickStatus.textContent =
            `${picked.length} audio file${picked.length === 1 ? '' : 's'} ready${skipped > 0 ? ` (${skipped} non-audio skipped)` : ''}.`;

        const SHOW_MAX = 12;
        $fileList.innerHTML = `
            <ul class="dar-folder-file-list">
                ${picked.slice(0, SHOW_MAX).map(f =>
                    `<li><i class="fa-solid fa-music"></i> ${_esc(f.name)}</li>`
                ).join('')}
                ${picked.length > SHOW_MAX
                    ? `<li class="dar-folder-more">…and ${picked.length - SHOW_MAX} more</li>`
                    : ''}
            </ul>`;
        $fileList.hidden = false;
        $confirm.hidden = false;
    });

    $confirm.addEventListener('click', async () => {
        if (picked.length === 0) return;

        // Resolve the destination folder path from the chosen mode.
        const mode = backdrop.querySelector('input[name="dar-upload-dest"]:checked').value;
        let folderPath;
        if (mode === 'existing') {
            const base = $existingSel.value || '';
            const sub = sanitizeFolderPath($subpath.value || '');
            folderPath = sub ? `${base}/${sub}` : base;
        } else {
            folderPath = sanitizeFolderPath($newName.value || '');
        }

        if (!folderPath) {
            darToast.warn('Please provide a valid destination folder name.');
            return;
        }

        // The registered folder is always the top-level segment, matching how
        // folderImport derives folder/subfolder from a relativePath.
        const topFolder = folderPath.split('/')[0];

        // Build the upload batch. Each file's name is the destination path plus
        // the file's own (sanitized) relative path within the selection.
        const batch = [];
        const skippedNames = [];
        for (const file of picked) {
            const rel = relativeAudioPath(file);
            if (!rel) { skippedNames.push(file.name); continue; }
            try {
                const data = await blobToBase64(file);
                batch.push({ name: `${folderPath}/${rel}`, data });
            } catch {
                skippedNames.push(file.name);
            }
        }

        if (batch.length === 0) {
            darToast.error('Could not read any of the selected files.');
            return;
        }

        $confirm.disabled = true;
        $browse.disabled = true;
        $confirm.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading ${batch.length}…`;

        let result;
        try {
            result = await postAudioBatch(batch);
        } catch (e) {
            debugError('Audio upload failed:', e);
            darToast.error(e.message || 'Upload failed.');
            $confirm.disabled = false;
            $browse.disabled = false;
            $confirm.innerHTML = `<i class="fa-solid fa-upload"></i> Upload`;
            return;
        }

        const written = result?.results?.filter(r => r.ok) || [];
        const failed = result?.results?.filter(r => !r.ok) || [];

        if (written.length === 0) {
            const why = failed[0]?.reason ? ` (${failed[0].reason})` : '';
            darToast.error(`No files were uploaded${why}.`);
            $confirm.disabled = false;
            $browse.disabled = false;
            $confirm.innerHTML = `<i class="fa-solid fa-upload"></i> Upload`;
            return;
        }

        // Register the successfully-written files with DAR. The server returns
        // each file's relative name (the path we sent); derive folder/subfolder
        // exactly like folderImport does so the library is consistent.
        addFolder(topFolder);
        const tracks = written.map(r => {
            const parts = r.name.split('/');
            const fileName = parts[parts.length - 1];
            const subfolder = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
            return {
                url: buildImportedTrackUrl(r.name),
                originalName: fileName,
                folder: topFolder,
                subfolder,
            };
        });
        const added = registerImportedTracks(tracks);
        debugLog(`Uploaded ${written.length} file(s) to "${folderPath}" (${added} new in library)`);

        const summary = `Uploaded ${written.length} file${written.length === 1 ? '' : 's'} to "${topFolder}"`
            + (added !== written.length ? ` (${added} new)` : '');
        if (failed.length > 0 || skippedNames.length > 0) {
            darToast.warn(`${summary}. ${failed.length + skippedNames.length} skipped.`);
        } else {
            darToast.success(summary);
        }

        // Close immediately (work is committed), refresh library in background —
        // same responsiveness fix applied to the import flow.
        close();
        scanTracks().catch(err =>
            console.error(DEBUG_PREFIX, 'Post-upload scanTracks failed:', err)
        );
    });
}


// ============================================================
// Global BGM upload modal
// ============================================================

/**
 * POST a batch of { name, data } files to the Nebula global-BGM route.
 * `name` is a bare filename (no path) written flat into assets/bgm/.
 * Returns the parsed server response: { ok, written, failed, results }.
 * Throws on transport/HTTP error so the caller can surface it.
 */
async function postBgmBatch(files) {
    const response = await fetch(`${NEBULA_BASE}/bgm/upload`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ files }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Upload failed (${response.status})${text ? `: ${text}` : ''}`);
    }
    return response.json();
}

/**
 * Open the global-BGM upload modal. Simpler than the imported-folder version:
 * no destination chooser, because ST's global library scans assets/bgm/ flat
 * (one level deep). Files are sent straight into bgm/, then a library rescan
 * makes them appear under the Global source. No dataStore registration — global
 * tracks are discovered by the scan, not tracked in dar_library.json.
 */
export function openBgmUploadModal() {
    const existing = document.querySelector('.dar-bgm-upload-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'dar-sub-backdrop dar-bgm-upload-backdrop';
    backdrop.innerHTML = `
        <div class="dar-sub-modal dar-sub-modal--lg" role="dialog" aria-label="Upload to Global Library">
            <h3><i class="fa-solid fa-upload"></i> Upload to Global Library</h3>

            <p class="dar-sub-note">
                Send audio files straight into your global BGM folder
                (<code>assets/bgm/</code>) — the same library the
                <strong>Refresh</strong> button scans. Files are added directly;
                the global library is a single flat folder, so there are no
                subfolders here.
            </p>

            <div class="dar-folder-pick-row">
                <input type="file" data-dar="bgm-input" accept="audio/*" multiple style="display:none;">
                <button type="button" class="dar-text-btn" data-dar="bgm-browse">
                    <i class="fa-solid fa-music"></i> Choose Files…
                </button>
                <span class="dar-folder-pick-status" data-dar="bgm-pick-status"></span>
            </div>

            <div class="dar-folder-verify-list dar-sub-list" data-dar="bgm-file-list" hidden></div>

            <div class="dar-sub-actions">
                <button type="button" class="dar-text-btn" data-dar="bgm-cancel">Cancel</button>
                <button type="button" class="dar-text-btn" data-dar="bgm-confirm" hidden>
                    <i class="fa-solid fa-upload"></i> Upload
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const q = sel => backdrop.querySelector(`[data-dar="${sel}"]`);

    const $browse     = q('bgm-browse');
    const $input      = q('bgm-input');
    const $pickStatus = q('bgm-pick-status');
    const $fileList   = q('bgm-file-list');
    const $cancel     = q('bgm-cancel');
    const $confirm    = q('bgm-confirm');

    let picked = [];

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    $cancel.addEventListener('click', close);

    $browse.addEventListener('click', () => $input.click());

    $input.addEventListener('change', () => {
        const all = Array.from($input.files || []);
        picked = all.filter(f => AUDIO_RE.test(f.name));
        const skipped = all.length - picked.length;

        if (picked.length === 0) {
            $pickStatus.textContent = all.length === 0
                ? ''
                : `No audio files in selection (looked for ${AUDIO_EXTENSIONS.join(', ')}).`;
            $fileList.hidden = true;
            $confirm.hidden = true;
            return;
        }

        if (picked.length > MAX_FILES_PER_UPLOAD) {
            $pickStatus.textContent =
                `${picked.length} files selected — please upload at most ${MAX_FILES_PER_UPLOAD} at a time.`;
            $fileList.hidden = true;
            $confirm.hidden = true;
            return;
        }

        $pickStatus.textContent =
            `${picked.length} audio file${picked.length === 1 ? '' : 's'} ready${skipped > 0 ? ` (${skipped} non-audio skipped)` : ''}.`;

        const SHOW_MAX = 12;
        $fileList.innerHTML = `
            <ul class="dar-folder-file-list">
                ${picked.slice(0, SHOW_MAX).map(f =>
                    `<li><i class="fa-solid fa-music"></i> ${_esc(f.name)}</li>`
                ).join('')}
                ${picked.length > SHOW_MAX
                    ? `<li class="dar-folder-more">…and ${picked.length - SHOW_MAX} more</li>`
                    : ''}
            </ul>`;
        $fileList.hidden = false;
        $confirm.hidden = false;
    });

    $confirm.addEventListener('click', async () => {
        if (picked.length === 0) return;

        // Build the batch: each file uploaded under its own (sanitized) bare
        // filename. Files whose names sanitize to nothing are skipped.
        const batch = [];
        const skippedNames = [];
        for (const file of picked) {
            const name = sanitizeFilename(file.name);
            if (!name) { skippedNames.push(file.name); continue; }
            try {
                const data = await blobToBase64(file);
                batch.push({ name, data });
            } catch {
                skippedNames.push(file.name);
            }
        }

        if (batch.length === 0) {
            darToast.error('Could not read any of the selected files.');
            return;
        }

        $confirm.disabled = true;
        $browse.disabled = true;
        $confirm.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Uploading ${batch.length}…`;

        let result;
        try {
            result = await postBgmBatch(batch);
        } catch (e) {
            debugError('BGM upload failed:', e);
            darToast.error(e.message || 'Upload failed.');
            $confirm.disabled = false;
            $browse.disabled = false;
            $confirm.innerHTML = `<i class="fa-solid fa-upload"></i> Upload`;
            return;
        }

        const written = result?.results?.filter(r => r.ok) || [];
        const failed = result?.results?.filter(r => !r.ok) || [];

        if (written.length === 0) {
            const why = failed[0]?.reason ? ` (${failed[0].reason})` : '';
            darToast.error(`No files were uploaded${why}.`);
            $confirm.disabled = false;
            $browse.disabled = false;
            $confirm.innerHTML = `<i class="fa-solid fa-upload"></i> Upload`;
            return;
        }

        debugLog(`Uploaded ${written.length} file(s) to global BGM`);

        const summary = `Uploaded ${written.length} file${written.length === 1 ? '' : 's'} to the global library`;
        const skipTotal = failed.length + skippedNames.length;
        if (skipTotal > 0) {
            darToast.warn(`${summary}. ${skipTotal} skipped.`);
        } else {
            darToast.success(summary);
        }

        // Close immediately; rescan in the background so the new global tracks
        // show up. scanTracks() re-reads /api/assets/get, which now includes them.
        close();
        scanTracks().catch(err =>
            console.error(DEBUG_PREFIX, 'Post-BGM-upload scanTracks failed:', err)
        );
    });
}
