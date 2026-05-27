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
