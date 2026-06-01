/* =========================================================================
   DynamicAudioRedux — ui.js
   ----------------------------------------------------------------------
   In-extension UI primitives that replace browser-native alert(),
   confirm(), and toastr usage. Everything here matches the `dar-` design
   system and uses `--dar-*` design tokens from style.css.

   Exports:
     darToast(message, type, opts?)  — fire-and-forget notification
     darToast.success(msg, opts?)
     darToast.error(msg, opts?)
     darToast.warn(msg, opts?)
     darToast.info(msg, opts?)
     darConfirm(message, opts?)      — returns Promise<boolean>

   Style classes live in style.css under "dar-toast-*" and "dar-confirm-*".
   ========================================================================= */

const TOAST_CONTAINER_ID = 'dar-toast-container';
const DEFAULT_TOAST_DURATION = 4000;

/* --------------------------- Toast container --------------------------- */
function getToastContainer() {
    let el = document.getElementById(TOAST_CONTAINER_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = TOAST_CONTAINER_ID;
        el.className = 'dar-toast-container';
        document.body.appendChild(el);
    }
    return el;
}

/* ------------------------------- Toast --------------------------------- */
/**
 * Show a toast notification.
 * @param {string} message   — text to display
 * @param {string} [type]    — 'info' | 'success' | 'error' | 'warn' (default: 'info')
 * @param {object} [opts]
 * @param {number} [opts.duration] — ms before auto-dismiss (default 4000, 0 = sticky)
 */
export function darToast(message, type = 'info', opts = {}) {
    const container = getToastContainer();
    const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_TOAST_DURATION;

    const toast = document.createElement('div');
    toast.className = `dar-toast dar-toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

    // Icon
    const iconMap = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        warn: 'fa-triangle-exclamation',
        info: 'fa-circle-info',
    };
    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${iconMap[type] || iconMap.info} dar-toast-icon`;
    toast.appendChild(iconEl);

    // Message
    const msgEl = document.createElement('div');
    msgEl.className = 'dar-toast-msg';
    msgEl.textContent = message;
    toast.appendChild(msgEl);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dar-toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    toast.appendChild(closeBtn);

    // Dismissal logic
    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        toast.classList.add('dar-toast--leaving');
        // Match CSS transition duration
        setTimeout(() => toast.remove(), 200);
    };
    closeBtn.addEventListener('click', dismiss);

    container.appendChild(toast);

    // Auto-dismiss
    if (duration > 0) {
        setTimeout(dismiss, duration);
    }

    return { dismiss };
}

darToast.success = (msg, opts) => darToast(msg, 'success', opts);
darToast.error   = (msg, opts) => darToast(msg, 'error',   opts);
darToast.warn    = (msg, opts) => darToast(msg, 'warn',    opts);
darToast.info    = (msg, opts) => darToast(msg, 'info',    opts);

/* ------------------------------ Confirm -------------------------------- */
/**
 * Show a modal confirmation dialog. Returns a promise resolving to true
 * (confirmed) or false (cancelled or closed).
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title]       — optional bold header above the message
 * @param {string} [opts.confirmText] — default "Confirm"
 * @param {string} [opts.cancelText]  — default "Cancel"
 * @param {boolean} [opts.danger]     — style the confirm button as destructive (red)
 * @returns {Promise<boolean>}
 */
export function darConfirm(message, opts = {}) {
    const {
        title = '',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        danger = false,
    } = opts;

    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'dar-confirm-backdrop';

        const dialog = document.createElement('div');
        dialog.className = 'dar-confirm';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        if (title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'dar-confirm-title';
            titleEl.textContent = title;
            dialog.appendChild(titleEl);
        }

        const msgEl = document.createElement('div');
        msgEl.className = 'dar-confirm-msg';
        msgEl.textContent = message;
        dialog.appendChild(msgEl);

        const actions = document.createElement('div');
        actions.className = 'dar-confirm-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'dar-confirm-btn dar-confirm-btn--cancel';
        cancelBtn.textContent = cancelText;

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = `dar-confirm-btn dar-confirm-btn--confirm${danger ? ' dar-confirm-btn--danger' : ''}`;
        confirmBtn.textContent = confirmText;

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        dialog.appendChild(actions);

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        // Focus confirm by default for keyboard users
        setTimeout(() => confirmBtn.focus(), 0);

        const cleanup = (result) => {
            document.removeEventListener('keydown', onKey);
            backdrop.classList.add('dar-confirm-backdrop--leaving');
            setTimeout(() => backdrop.remove(), 160);
            resolve(result);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
            else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
        };
        document.addEventListener('keydown', onKey);

        cancelBtn.addEventListener('click', () => cleanup(false));
        confirmBtn.addEventListener('click', () => cleanup(true));
        // Click backdrop (but not the dialog itself) cancels
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) cleanup(false);
        });
    });
}


/* ======================= Volume Popup ================================== */
/*
 * Shared hover-activated volume slider. A single popup element attached to
 * document.body with position:fixed so it escapes any overflow:hidden
 * containers (miniplayer, modal). Call showVolumePopup(anchorEl, opts) on
 * mouseenter and hideVolumePopup() on mouseleave.
 *
 * Custom div-based vertical slider — no native <input type="range">, no
 * rotation hacks, no Chromium pseudo-element quirks.
 */

let _volumePopup = null;
let _volumeHideTimer = null;
let _volumeOnChange = null;

function getOrCreateVolumePopup() {
    if (_volumePopup) return _volumePopup;

    const el = document.createElement('div');
    el.className = 'dar-volume-popup';
    el.innerHTML = `
        <div class="dar-volume-slider-wrap">
            <div class="dar-volume-slider-track">
                <div class="dar-volume-slider-fill"></div>
            </div>
            <div class="dar-volume-slider-thumb"></div>
        </div>
        <span class="dar-volume-popup-label">50</span>
    `;
    document.body.appendChild(el);

    const wrap  = el.querySelector('.dar-volume-slider-wrap');
    const fill  = el.querySelector('.dar-volume-slider-fill');
    const thumb = el.querySelector('.dar-volume-slider-thumb');
    const label = el.querySelector('.dar-volume-popup-label');

    // Internal volume state lives on the popup element
    el._darVolume = 50;

    function setVolume(vol) {
        vol = Math.max(0, Math.min(100, Math.round(vol)));
        el._darVolume = vol;
        const pct = vol + '%';
        fill.style.height = pct;
        thumb.style.bottom = pct;
        label.textContent = vol;
        if (_volumeOnChange) _volumeOnChange(vol);
    }

    function volFromY(clientY) {
        const rect = wrap.getBoundingClientRect();
        // Bottom of track = 0%, top = 100%
        return ((rect.bottom - clientY) / rect.height) * 100;
    }

    // Click + drag
    wrap.addEventListener('mousedown', (e) => {
        e.preventDefault();
        setVolume(volFromY(e.clientY));
        const onMove = (e2) => { e2.preventDefault(); setVolume(volFromY(e2.clientY)); };
        const onUp   = ()   => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // Scroll wheel for fine adjustment
    wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.deltaY < 0 ? 2 : -2;   // scroll up = louder
        setVolume(el._darVolume + step);
    }, { passive: false });

    // Keep popup visible when the cursor moves into it
    el.addEventListener('mouseenter', () => clearTimeout(_volumeHideTimer));
    el.addEventListener('mouseleave', () => hideVolumePopup());

    _volumePopup = el;
    return el;
}

/**
 * Show the volume popup anchored to a button.
 *
 * @param {HTMLElement} anchorEl — the button to anchor to
 * @param {object} opts
 * @param {number}  opts.value       — current volume 0–100
 * @param {(v:number)=>void} opts.onChange — called on every slider input
 * @param {boolean} opts.preferBelow — force popup below the anchor (for the
 *     modal where the button is at the top). Default false = auto-detect
 *     based on available viewport space (good for the miniplayer).
 */
export function showVolumePopup(anchorEl, { value = 50, onChange = null, preferBelow = false } = {}) {
    clearTimeout(_volumeHideTimer);
    const popup = getOrCreateVolumePopup();

    const fill  = popup.querySelector('.dar-volume-slider-fill');
    const thumb = popup.querySelector('.dar-volume-slider-thumb');
    const label = popup.querySelector('.dar-volume-popup-label');
    const pct = value + '%';
    fill.style.height = pct;
    thumb.style.bottom = pct;
    label.textContent = value;
    popup._darVolume = value;
    _volumeOnChange = onChange;

    popup.style.display = 'flex';

    // Position using viewport coords (fixed positioning).
    const rect = anchorEl.getBoundingClientRect();
    const popupW = popup.offsetWidth;
    const popupH = popup.offsetHeight;

    // Horizontal — center on the anchor, clamp to viewport edges
    let left = rect.left + rect.width / 2 - popupW / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - popupW - 4));

    // Vertical — decide above vs below
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    let top;

    if (preferBelow) {
        // Modal mode: always below
        top = rect.bottom + 6;
    } else {
        // Miniplayer mode: pick whichever side has more room
        if (spaceAbove >= popupH + 8) {
            top = rect.top - popupH - 6;
        } else if (spaceBelow >= popupH + 8) {
            top = rect.bottom + 6;
        } else {
            // Tight on both sides — favour whichever has more
            top = spaceAbove > spaceBelow
                ? rect.top - popupH - 6
                : rect.bottom + 6;
        }
    }

    // Final clamp so nothing goes off-screen
    top = Math.max(4, Math.min(top, window.innerHeight - popupH - 4));

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
}

/**
 * Hide the volume popup (with a short delay so the cursor can travel to it).
 */
export function hideVolumePopup() {
    _volumeHideTimer = setTimeout(() => {
        if (_volumePopup) _volumePopup.style.display = 'none';
    }, 200);
}
