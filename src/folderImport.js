/*
 * folderImport.js — Folder import flow for Dynamic Audio Redux.
 *
 * Workflow:
 *   1. User pre-drops a folder of audio files into user/files/<folder>/ on disk.
 *   2. User clicks "Add Folder" in the Library tab → opens this modal.
 *   3. User picks the folder via webkitdirectory file input.
 *   4. We extract the folder name + audio file list from the selection.
 *   5. For each audio file, we HEAD /user/files/<folder>/<file> to verify
 *      it actually exists server-side (the webkitdirectory selection only
 *      sees the client's local copy — ST has no upload-folder endpoint).
 *   6. If all (or some) verify, register with dataStore:
 *      addFolder(name) + registerImportedTracks([...])
 *      then re-run scanTracks() so trackLibrary.imported reflects the change.
 *
 * The audio files themselves are NEVER uploaded by this module — they must be
 * present in user/files/<folder>/ on disk before the user runs the import.
 *
 * This module also acts as a lightweight folder manager: the same modal lists
 * already-registered folders with a remove button for each.
 */

import { getRequestHeaders } from '../../../../../script.js';
import {
    addFolder,
    registerImportedTracks,
    removeFolder,
    getFolders,
} from './dataStore.js';
import { scanTracks } from './scanner.js';
import { darToast } from './ui.js';
import { DEBUG_PREFIX, debugLog, debugError } from './state.js';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
const AUDIO_RE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

/**
 * Build the public URL for a track inside an imported folder. Path segments
 * are URI-encoded individually so spaces and special chars in filenames
 * don't break the request, but the slashes between segments are preserved.
 */
export function buildImportedTrackUrl(relativePath) {
    return '/user/files/' + relativePath
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/');
}

/**
 * Verify a URL points at an actual file under /user/files/. Returns true/false.
 *
 * Robustness layers (in order):
 *   1. HEAD request — cheap, works on most static file servers
 *   2. If HEAD returns 405 (method not allowed), retry with a ranged GET
 *      (Range: bytes=0-0) so we only pull a single byte
 *   3. On network errors or 5xx responses, retry once after a short delay
 *
 * 404 is treated as definitive (file genuinely missing) — no retry.
 * This matters because the original single-shot HEAD was silently dropping
 * tracks on transient errors.
 */
async function verifyFile(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await fetch(url, { method: 'HEAD', headers: getRequestHeaders() });
            if (r.ok) return true;
            if (r.status === 404) return false;
            if (r.status === 405) {
                // Server doesn't support HEAD; fall back to a 1-byte ranged GET
                try {
                    const g = await fetch(url, {
                        method: 'GET',
                        headers: { ...getRequestHeaders(), Range: 'bytes=0-0' },
                    });
                    return g.ok || g.status === 206;
                } catch {
                    return false;
                }
            }
            // 5xx or other — fall through to retry
        } catch {
            // Network error — fall through to retry
        }
        if (attempt === 0) await new Promise(res => setTimeout(res, 200));
    }
    return false;
}

/**
 * Verify a batch of audio files exist under user/files/. Returns
 *   { found: [...], missing: [...] }
 * Verification happens in chunks of 8 concurrent requests.
 */
async function verifyFolderContents(audioFiles) {
    const found = [];
    const missing = [];
    const CHUNK = 8;

    for (let i = 0; i < audioFiles.length; i += CHUNK) {
        const slice = audioFiles.slice(i, i + CHUNK);
        const results = await Promise.all(slice.map(async f => {
            const url = buildImportedTrackUrl(f.relativePath);
            const ok = await verifyFile(url);
            return { ...f, url, ok };
        }));
        for (const r of results) {
            const entry = { url: r.url, relativePath: r.relativePath, name: r.name };
            if (r.ok) found.push(entry);
            else      missing.push(entry);
        }
    }
    return { found, missing };
}

function _esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Open the folder import modal.
 */
export function openFolderImportModal() {
    const existing = document.querySelector('.dar-folder-import-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'dar-sub-backdrop dar-folder-import-backdrop';
    backdrop.innerHTML = `
        <div class="dar-sub-modal dar-sub-modal--lg" role="dialog" aria-label="Import Folder">
            <h3><i class="fa-solid fa-folder-plus"></i> Import Folder</h3>

            <div data-dar="folder-step-pick">
                <p class="dar-sub-note">
                    Drop your audio folder into <code>user/files/</code> on disk first
                    (so it lives at <code>SillyTavern/data/&lt;user&gt;/files/&lt;your-folder&gt;/</code>),
                    then pick it here. DAR verifies the files exist and registers them —
                    no upload happens.
                </p>

                <div class="dar-folder-existing" data-dar="folder-existing"></div>

                <div class="dar-folder-pick-row">
                    <input type="file" data-dar="folder-input" webkitdirectory directory multiple
                           style="display: none;">
                    <button type="button" class="dar-text-btn" data-dar="folder-browse">
                        <i class="fa-solid fa-folder-open"></i> Choose Folder…
                    </button>
                    <span class="dar-folder-pick-status" data-dar="folder-pick-status"></span>
                </div>
            </div>

            <div data-dar="folder-step-verify" hidden>
                <p class="dar-sub-note" data-dar="folder-verify-text">Verifying…</p>
                <div class="dar-folder-verify-list dar-sub-list" data-dar="folder-verify-list"></div>
            </div>

            <div class="dar-sub-actions">
                <button type="button" class="dar-text-btn" data-dar="folder-cancel">Cancel</button>
                <button type="button" class="dar-text-btn" data-dar="folder-confirm" hidden>
                    <i class="fa-solid fa-check"></i> Register
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const q = sel => backdrop.querySelector(`[data-dar="${sel}"]`);

    const $browse     = q('folder-browse');
    const $input      = q('folder-input');
    const $pickStatus = q('folder-pick-status');
    const $stepVerify = q('folder-step-verify');
    const $verifyList = q('folder-verify-list');
    const $verifyText = q('folder-verify-text');
    const $cancel     = q('folder-cancel');
    const $confirm    = q('folder-confirm');
    const $existing   = q('folder-existing');

    const close = () => backdrop.remove();
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });
    $cancel.addEventListener('click', close);

    renderExistingFolders($existing);

    $browse.addEventListener('click', () => $input.click());

    $input.addEventListener('change', async () => {
        const files = Array.from($input.files || []);
        if (files.length === 0) return;

        const firstRel = files[0].webkitRelativePath || files[0].name;
        const folderName = firstRel.split('/')[0];

        if (!folderName) {
            darToast.error('Could not determine folder name from selection.');
            return;
        }

        const audioFiles = files
            .filter(f => AUDIO_RE.test(f.name))
            .map(f => ({
                name: f.name,
                relativePath: f.webkitRelativePath || f.name,
            }));

        if (audioFiles.length === 0) {
            darToast.warn('No audio files found in that folder.');
            $pickStatus.textContent =
                `"${folderName}" contains no audio files (looked for ${AUDIO_EXTENSIONS.join(', ')}).`;
            return;
        }

        $pickStatus.textContent =
            `${audioFiles.length} audio file${audioFiles.length === 1 ? '' : 's'} in "${folderName}". Verifying…`;

        $stepVerify.hidden = false;
        $verifyText.textContent = `Checking that "${folderName}" exists under user/files/ on disk…`;
        $verifyList.innerHTML = `<div class="dar-folder-verify-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Verifying ${audioFiles.length} files…</div>`;

        const { found, missing } = await verifyFolderContents(audioFiles);

        $verifyList.innerHTML = renderVerifyResults(found, missing, folderName);

        if (found.length === 0) {
            $verifyText.textContent =
                `None of the audio files were found on disk. Make sure "${folderName}" is at user/files/${folderName}/ on the server, then try again.`;
            $confirm.hidden = true;
        } else {
            $verifyText.textContent = missing.length > 0
                ? `Register the ${found.length} verified track${found.length === 1 ? '' : 's'}? (${missing.length} skipped)`
                : `All ${found.length} track${found.length === 1 ? '' : 's'} verified.`;
            $confirm.hidden = false;
            $confirm.dataset.found = JSON.stringify(found);
            $confirm.dataset.folder = folderName;
        }
    });

    $confirm.addEventListener('click', async () => {
        const folderName = $confirm.dataset.folder;
        const found = JSON.parse($confirm.dataset.found || '[]');
        if (!folderName || found.length === 0) return;

        $confirm.disabled = true;
        $confirm.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Registering…`;

        try {
            addFolder(folderName);
            const tracks = found.map(f => {
                // relativePath = "TopFolder/Sub1/Sub2/song.mp3"
                // subfolder    = "Sub1/Sub2" (empty string if flat)
                const parts = f.relativePath.split('/');
                const subfolder = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
                return {
                    url: f.url,
                    originalName: f.name,
                    folder: folderName,
                    subfolder,
                };
            });
            const added = registerImportedTracks(tracks);
            debugLog(`Registered folder "${folderName}" with ${tracks.length} tracks (${added} new)`);

            darToast.success(`Registered "${folderName}" (${tracks.length} track${tracks.length === 1 ? '' : 's'})`);

            // Registration is already committed to the dataStore at this point,
            // so close the modal immediately for responsive UX. The library
            // rescan is a non-blocking refresh that doesn't need the modal open
            // and must not be able to hold it hostage if it hangs or throws.
            close();
            scanTracks().catch(err =>
                console.error(DEBUG_PREFIX, 'Post-register scanTracks failed:', err)
            );
        } catch (e) {
            debugError('Folder registration failed:', e);
            darToast.error(`Failed to register folder: ${e.message}`);
            $confirm.disabled = false;
            $confirm.innerHTML = `<i class="fa-solid fa-check"></i> Register`;
        }
    });
}

/**
 * Render the verification result panel (verified + missing sections).
 */
function renderVerifyResults(found, missing, folderName) {
    const SHOW_MAX = 10;

    const foundHtml = found.length > 0
        ? `<div class="dar-folder-section dar-folder-section--ok">
               <div class="dar-folder-section-title">
                   <i class="fa-solid fa-circle-check"></i> Verified: ${found.length}
               </div>
               <ul class="dar-folder-file-list">
                   ${found.slice(0, SHOW_MAX).map(f =>
                       `<li><i class="fa-solid fa-music"></i> ${_esc(f.name)}</li>`
                   ).join('')}
                   ${found.length > SHOW_MAX
                       ? `<li class="dar-folder-more">…and ${found.length - SHOW_MAX} more</li>`
                       : ''}
               </ul>
           </div>`
        : '';

    const missingHtml = missing.length > 0
        ? `<div class="dar-folder-section dar-folder-section--missing">
               <div class="dar-folder-section-title">
                   <i class="fa-solid fa-triangle-exclamation"></i> Missing on disk: ${missing.length}
               </div>
               <p class="dar-sub-note">
                   These files are in your local selection but ST can't find them.
                   Make sure the folder is copied to
                   <code>user/files/${_esc(folderName)}/</code> on the server.
               </p>
               <ul class="dar-folder-file-list">
                   ${missing.slice(0, SHOW_MAX).map(f =>
                       `<li><i class="fa-solid fa-xmark"></i> ${_esc(f.relativePath)}</li>`
                   ).join('')}
                   ${missing.length > SHOW_MAX
                       ? `<li class="dar-folder-more">…and ${missing.length - SHOW_MAX} more</li>`
                       : ''}
               </ul>
           </div>`
        : '';

    return foundHtml + missingHtml;
}

/**
 * Rescan an already-registered folder: re-pick the same directory on disk
 * and register any audio files that weren't already in the library. Existing
 * tracks keep their tags/metadata; only the new ones count toward the
 * "added" tally surfaced in the toast.
 *
 * Uses a transient hidden file input rather than going through the full
 * folder-import modal — this is a one-button shortcut.
 */
async function rescanFolder(folderName, $existingContainer) {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.directory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (files.length === 0) return;

        const firstRel = files[0].webkitRelativePath || files[0].name;
        const pickedName = firstRel.split('/')[0];

        let targetFolder = folderName;
        if (pickedName !== folderName) {
            const ok = confirm(
                `You picked "${pickedName}" but rescan was requested for "${folderName}".\n\n` +
                `Continue and register tracks under "${pickedName}" instead?`
            );
            if (!ok) return;
            targetFolder = pickedName;
        }

        const audioFiles = files
            .filter(f => AUDIO_RE.test(f.name))
            .map(f => ({
                name: f.name,
                relativePath: f.webkitRelativePath || f.name,
            }));

        if (audioFiles.length === 0) {
            darToast.warn('No audio files in selection.');
            return;
        }

        darToast.info(`Verifying ${audioFiles.length} file${audioFiles.length === 1 ? '' : 's'} in "${targetFolder}"…`);
        const { found, missing } = await verifyFolderContents(audioFiles);

        if (found.length === 0) {
            darToast.error(
                `Couldn't verify any files. Make sure "${targetFolder}" is at user/files/${targetFolder}/ on the server.`
            );
            return;
        }

        addFolder(targetFolder);
        const tracks = found.map(f => {
            const parts = f.relativePath.split('/');
            const subfolder = parts.length > 2 ? parts.slice(1, -1).join('/') : '';
            return {
                url: f.url,
                originalName: f.name,
                folder: targetFolder,
                subfolder,
            };
        });
        const added = registerImportedTracks(tracks);
        debugLog(`Rescanned folder "${targetFolder}": ${tracks.length} total, ${added} new`);

        const summary = added > 0
            ? `Rescanned "${targetFolder}": +${added} new (${tracks.length - added} already in library)`
            : `Rescanned "${targetFolder}": no new tracks (${tracks.length} already in library)`;

        if (missing.length > 0) {
            darToast.warn(`${summary}. ${missing.length} missing on disk.`);
        } else {
            darToast.success(summary);
        }

        await scanTracks();
        if ($existingContainer) renderExistingFolders($existingContainer);
    });

    input.click();
}

/**
 * Paint the "already registered" list inside the picker step.
 */
function renderExistingFolders($container) {
    const folders = getFolders();
    if (folders.length === 0) {
        $container.innerHTML = '';
        return;
    }
    const items = folders.map(name =>
        `<div class="dar-folder-existing-item">
             <i class="fa-solid fa-folder"></i>
             <span class="dar-folder-existing-name">${_esc(name)}</span>
             <button type="button" class="dar-icon-btn" data-folder-rescan="${_esc(name)}" title="Rescan — pick this folder again to add any new audio files">
                 <i class="fa-solid fa-arrows-rotate"></i>
             </button>
             <button type="button" class="dar-icon-btn" data-folder-remove="${_esc(name)}" title="Remove this folder from DAR">
                 <i class="fa-solid fa-trash"></i>
             </button>
         </div>`
    ).join('');

    $container.innerHTML = `
        <div class="dar-folder-existing-title">Already registered</div>
        ${items}
    `;

    $container.querySelectorAll('[data-folder-rescan]').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.dataset.folderRescan;
            rescanFolder(name, $container);
        });
    });

    $container.querySelectorAll('[data-folder-remove]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.folderRemove;
            const ok = confirm(
                `Remove "${name}" from DAR?\n\nAll tracks from this folder will be deregistered. ` +
                `The files on disk are NOT deleted.`
            );
            if (!ok) return;

            const removed = removeFolder(name);
            darToast.success(`Removed "${name}" (${removed} track${removed === 1 ? '' : 's'})`);
            await scanTracks();
            renderExistingFolders($container);
        });
    });
}
