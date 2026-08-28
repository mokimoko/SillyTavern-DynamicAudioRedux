// src/hostAdapter.js — dual-target backend adapter for Dynamic Audio Redux.
//
// DAR was written for SillyTavern's HTTP API (/api/assets/get,
// /api/assets/character, and the nebula-loader upload plugin). TauriTavern has
// no Node backend and does NOT expose those HTTP routes — it exposes the same
// capabilities as Tauri `invoke` commands instead. This adapter detects the
// host once and routes asset listing + upload through the right transport.
//
// Confirmed against a live TauriTavern probe (2026-08):
//   • origin is http://tauri.localhost with a real internal HTTP server, so
//     RELATIVE audio URLs like "assets/bgm/x.ogg" and "/user/files/..." load
//     fine in <audio> on both hosts — no URL rewriting needed.
//   • invoke('get_assets_library') -> { ambient, bgm, blip, character, ... }
//     where bgm is an array of "assets/bgm/<file>" paths (same shape ST's
//     /api/assets/get returns).
//   • invoke('get_character_assets', { name }) -> character asset list.
//   • invoke('upload_user_file', { name, dataBase64 }) writes into user/files/.
//
// On real SillyTavern, everything below falls back to the original HTTP paths,
// so DAR behaves exactly as before there.

import { getRequestHeaders } from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Host detection (once, cached)
// ---------------------------------------------------------------------------

function tauriInvoke() {
    // Both shapes seen in the wild: the internals object and the public core API.
    const w = (typeof window !== 'undefined') ? window : {};
    if (w.__TAURI_INTERNALS__ && typeof w.__TAURI_INTERNALS__.invoke === 'function') {
        return w.__TAURI_INTERNALS__.invoke.bind(w.__TAURI_INTERNALS__);
    }
    if (w.__TAURI__ && w.__TAURI__.core && typeof w.__TAURI__.core.invoke === 'function') {
        return w.__TAURI__.core.invoke.bind(w.__TAURI__.core);
    }
    return null;
}

function detectHost() {
    return tauriInvoke() ? 'tauri' : 'server';
}

let _host = null;
export function getHost() {
    if (_host === null) _host = detectHost();
    return _host;
}
export function isTauri() { return getHost() === 'tauri'; }

// ---------------------------------------------------------------------------
// Asset listing (replaces /api/assets/get and /api/assets/character)
// ---------------------------------------------------------------------------

/**
 * Return the global asset library grouped by category ({ bgm, ambient, ... }).
 * server: POST /api/assets/get. tauri: invoke('get_assets_library').
 * Never throws — returns {} on failure so the caller can carry on.
 */
export async function getAssetsLibrary() {
    try {
        if (isTauri()) {
            const inv = tauriInvoke();
            const lib = await inv('get_assets_library', {});
            return lib && typeof lib === 'object' ? lib : {};
        }
        const res = await fetch('/api/assets/get', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!res.ok) return {};
        return await res.json();
    } catch {
        return {};
    }
}

/**
 * Return the bgm asset list for a specific character.
 * server: POST /api/assets/character?name=&category=bgm.
 * tauri: invoke('get_character_assets', { name, category }).
 * Never throws — returns [] on failure.
 */
export async function getCharacterBgm(name) {
    if (!name) return [];
    try {
        if (isTauri()) {
            const inv = tauriInvoke();
            const out = await inv('get_character_assets', { name, category: 'bgm' });
            return Array.isArray(out) ? out : (out?.bgm ?? []);
        }
        const res = await fetch(
            `/api/assets/character?name=${encodeURIComponent(name)}&category=bgm`,
            { method: 'POST', headers: getRequestHeaders() },
        );
        if (!res.ok) return [];
        return await res.json();
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Upload (replaces the nebula-loader /audio/upload and /bgm/upload endpoints)
// ---------------------------------------------------------------------------

/**
 * Is folder/subfolder audio upload available on this host?
 * server: only if the nebula-loader plugin advertises audioUpload (probed by
 *         folderUpload.js). tauri: always — upload_user_file handles subpaths.
 */
export function uploadAvailableSync() {
    return isTauri(); // server path keeps its own async plugin probe
}

/**
 * Upload one file into user/files/ (name may contain '/' for subfolders).
 * tauri only — server uses postAudioBatch to the plugin. Returns a per-file
 * result object shaped like the plugin's results entries.
 */
export async function tauriUploadUserFile(name, dataBase64) {
    const inv = tauriInvoke();
    if (!inv) return { name, ok: false, reason: 'no-invoke' };
    try {
        await inv('upload_user_file', { name, dataBase64 });
        return { name, ok: true };
    } catch (e) {
        return { name, ok: false, reason: String(e && e.message || e) };
    }
}

/**
 * Upload a batch of { name, data(base64) } files on TauriTavern, returning the
 * same { ok, written, failed, results } shape the nebula plugin returned so
 * folderUpload.js can consume it unchanged.
 */
export async function tauriUploadBatch(files) {
    const results = [];
    for (const f of files) {
        results.push(await tauriUploadUserFile(f.name, f.data));
    }
    const written = results.filter(r => r.ok).length;
    return { ok: written === results.length, written, failed: results.length - written, results };
}
