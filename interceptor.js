// DeKindled - Blob URL Interceptor
// Captures blob URLs and their base64 content for extraction
(function() {
    // --- Logging helpers (toggle with DK_DEBUG) ---
    const DK_DEBUG = false;
    const _tag = '[DeKindled][interceptor]';
    const dklog  = (...a) => { if (DK_DEBUG) console.log(_tag, ...a); };
    const dkwarn = (...a) => console.warn(_tag, ...a);
    const dkerr  = (...a) => console.error(_tag, ...a);

    const _frame = (window.top === window) ? 'TOP frame' : 'IFRAME';
    dklog(`script running in ${_frame}:`, location.href, '| readyState:', document.readyState);

    // Guard against multiple script injection
    if (window.__dekindled && window.__dekindled._initialized) {
        dklog('interceptor already initialized, skipping duplicate injection');
        return;
    }

    // Create storage for blob data
    window.__dekindled = window.__dekindled || {
        blobs: [],
        blobData: new Map(), // Store actual blob content
        _initialized: true, // Mark as initialized
        // Nothing is stored until capture is explicitly armed (by clicking the
        // extension and starting a capture). Page turns still increment
        // stats.createCalls so the scanner can detect book boundaries even
        // while disarmed.
        capturing: false,
        stats: { createCalls: 0, blobCaptured: 0, nonBlob: 0, readErrors: 0, revoked: 0, skipped: 0 }
    };

    dklog('initializing blob interceptor...');
    
    // Logging function
    function logBlob(type, details) {
        // Store in array for viewing
        window.__dekindled.blobs.push({ 
            type, 
            details, 
            timestamp: new Date().toISOString() 
        });
        
        // Visual indicator for blob creation — only while capture is armed,
        // so nothing flashes on screen during normal reading.
        // Guard on document.body — during the armed reload the reader creates
        // blobs at document_start when body is still null; appending then throws.
        if (type === 'Blob URL Created' && document.body && window.__dekindled && window.__dekindled.capturing) {
            [...document.getElementsByClassName('dekindled-indicator')].forEach(indicator => indicator.remove());
            const indicator = document.createElement('div');
            indicator.className = 'dekindled-indicator';
            indicator.style.cssText = 'position:fixed;top:10px;left:10px;background:#d32f2f;color:white;padding:10px;z-index:999999;font-family:monospace;font-size:12px;border-radius:4px;box-shadow:0 2px 5px rgba(0,0,0,0.3);';
            indicator.textContent = '📚 DeKindled: Captured ' + (details.type || 'blob') + ' ✓';
            document.body.appendChild(indicator);
            setTimeout(() => indicator.remove(), 3000);
        }
    }
    
    // Function to read blob as base64
    async function readBlobAsBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Read the reader's footer readout: "Page 17 of 297 ● 6%".
    // The ".text-div" holding it is light-DOM (slotted into ion-title's shadow
    // root), so textContent reaches it without piercing any shadow boundary.
    // NOTE: due to the reader pre-buffering a window of pages around the current
    // position, the footer (what's *visible*) usually lags the page whose blob
    // is being created — so this is best-effort metadata, not an exact label.
    function readFooter() {
        try {
            const cands = [
                ...document.querySelectorAll('ion-title[item-i-d="reader-footer-title"] .text-div, .text-div'),
                ...document.querySelectorAll('ion-footer, [class*="footer"], [class*="location"]')
            ];
            for (const n of cands) {
                const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
                const m = t.match(/Page\s+(\d+)\s+of\s+(\d+)/i);
                if (m) {
                    const pm = t.match(/(\d+)\s*%/);
                    return { page: +m[1], total: +m[2], pct: pm ? +pm[1] : null, raw: t.slice(0, 60) };
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }
    
    // Check if URL.createObjectURL is already overridden
    if (URL.createObjectURL._dekindledOverridden) {
        dklog('URL.createObjectURL already overridden, skipping');
        return;
    }

    // Store original functions
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    // Override createObjectURL
    URL.createObjectURL = function(object) {
        const url = originalCreateObjectURL.apply(this, arguments);
        window.__dekindled.stats.createCalls++;

        try {
            const objectType = object?.constructor?.name || 'Unknown';
            const isBlob = object instanceof Blob;
            const details = {
                url: url,
                objectType: objectType,
                size: object?.size || 0,
                type: object?.type || 'Unknown',
                timestamp: new Date().toISOString(),
                stored: false
            };

            dklog(`createObjectURL #${window.__dekindled.stats.createCalls}`, {
                objectType, isBlob, mime: details.type, size: details.size
            });

            // Only STORE blobs while capture is armed. When disarmed we do
            // nothing but count, so merely opening/reading a book captures nothing.
            if (isBlob && !window.__dekindled.capturing) {
                window.__dekindled.stats.skipped++;
                // (quiet — this fires a lot during normal reading)
            } else if (isBlob) {
                readBlobAsBase64(object).then(base64Data => {
                    // Store the base64 data
                    window.__dekindled.blobData.set(url, {
                        base64: base64Data,
                        type: object.type,
                        size: object.size,
                        timestamp: details.timestamp
                    });

                    details.stored = true;
                    window.__dekindled.stats.blobCaptured++;
                    dklog(`captured blob #${window.__dekindled.stats.blobCaptured} (total stored: ${window.__dekindled.blobData.size})`, {
                        type: object.type,
                        size: object.size,
                        dataLength: base64Data.length
                    });

                    // Update the visual indicator
                    const indicators = document.querySelectorAll('div[style*="DeKindled: Captured"]');
                    const latestIndicator = indicators[indicators.length - 1];
                    if (latestIndicator) {
                        latestIndicator.textContent = '📚 DeKindled: Captured ' + (object.type || 'blob') + ' ✓';
                        latestIndicator.style.background = '#2e7d32';
                    }
                }).catch(error => {
                    window.__dekindled.stats.readErrors++;
                    dkerr('failed to read blob as base64:', error);
                });
            } else {
                // Kindle may render pages via MediaSource / canvas rather than image Blobs.
                // These are NOT captured — logging them tells us if that's why nothing shows up.
                window.__dekindled.stats.nonBlob++;
                dkwarn(`createObjectURL for NON-Blob object "${objectType}" — not captured (nonBlob count: ${window.__dekindled.stats.nonBlob})`);
            }

            logBlob('Blob URL Created', details);
        } catch (e) {
            // Log only — no DOM fallback here. This runs on every createObjectURL
            // call, including at document_start when document.body is null, so a
            // DOM append would throw uncaught and spam the console (and could
            // interrupt the reader's own load).
            dkerr('error in createObjectURL override:', e);
        }
        
        return url;
    };
    
    // Mark the override to prevent double-overriding
    URL.createObjectURL._dekindledOverridden = true;
    
    // Override revokeObjectURL
    URL.revokeObjectURL = function(url) {
        const hadData = window.__dekindled.blobData.has(url);
        window.__dekindled.stats.revoked++;
        logBlob('Blob URL Revoked', {
            url: url,
            timestamp: new Date().toISOString(),
            hadData: hadData
        });

        dklog(`revoked ${url} — had stored data: ${hadData} (we keep our copy)`);

        return originalRevokeObjectURL.apply(this, arguments);
    };
    
    // Ensure overrides are set on window object
    window.URL = URL;
    if (window.webkitURL) {
        window.webkitURL = URL;
    }

    // Run a callback once <body> exists. The interceptor executes at
    // document_start, so on some readers document.body is still null here and
    // any appendChild would throw — deferring keeps the override installed
    // early (to catch preloads) while touching the DOM only when it's safe.
    function whenBodyReady(fn) {
        if (document.body) { fn(); return; }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
            return;
        }
        const obs = new MutationObserver(() => {
            if (document.body) { obs.disconnect(); fn(); }
        });
        obs.observe(document.documentElement || document, { childList: true, subtree: true });
    }

    // Create a visible indicator that script is running
    whenBodyReady(() => {
        const statusDiv = document.createElement('div');
        statusDiv.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#1976d2;color:white;padding:5px 10px;z-index:999999;font-size:10px;border-radius:4px;';
        statusDiv.textContent = '📚 DeKindled Active';
        document.body.appendChild(statusDiv);
    });

    dklog('content extraction ready — capturing base64 blob data');

    // Expose a quick diagnostic helper you can call from the console:
    //   window.__dekindled.debugDump()
    window.__dekindled.debugDump = function() {
        const s = window.__dekindled.stats;
        console.log(`${_tag} DUMP`, {
            frame: _frame,
            url: location.href,
            storedPages: window.__dekindled.blobData.size,
            stats: s,
            overrideInstalled: !!URL.createObjectURL._dekindledOverridden
        });
        return { storedPages: window.__dekindled.blobData.size, stats: s };
    };

    // Periodic heartbeat so we can see capture progress without manual polling
    if (DK_DEBUG) {
        setInterval(() => {
            const s = window.__dekindled.stats;
            dklog(`heartbeat — stored:${window.__dekindled.blobData.size} createCalls:${s.createCalls} blobs:${s.blobCaptured} nonBlob:${s.nonBlob} readErrors:${s.readErrors}`);
        }, 5000);
    }

    // ---- Post-reload capture driver --------------------------------------
    // The reader only creates a page's blob when it FIRST renders that page and
    // does NOT recreate it on revisit. So the only reliable way to capture the
    // whole book is: arm capture from page load (to catch the reader's initial
    // preload), then step forward so the reader renders/preloads the rest.
    //
    // The overlay's "Capture Whole Book" button navigates to page 1, sets these
    // sessionStorage flags, and reloads. After the reload we (the interceptor,
    // which runs at document_start) pick the flags up here and do the work — the
    // overlay doesn't survive the reload, but this does.
    function armedFromStorage(key) {
        try { return sessionStorage.getItem(key) === '1'; } catch (e) { return false; }
    }
    function clearStorage(key) {
        try { sessionStorage.removeItem(key); } catch (e) {}
    }

    // ---- Optional: force single-column page rendering during capture ------
    // The newer "Kindle for Web" reader fetches each page from
    //   /renderer/render?...&maxNumberColumns=N...
    // where N is the column count. Rewriting that parameter to 1 makes every
    // rendered page a single column — much easier to read as exported images.
    // Because the capture flow reloads with dekindled_armed set BEFORE the
    // reader issues any render request, even the initial preload comes back
    // single-column. Only active when the user chose the single-column option,
    // so it never affects normal reading.
    function rewriteRenderUrl(url) {
        try {
            if (typeof url !== 'string') return url;
            if (url.indexOf('/renderer/render') === -1) return url;
            if (!/[?&]maxNumberColumns=\d+/.test(url)) return url;
            const out = url.replace(/([?&]maxNumberColumns=)\d+/, (m, p1) => p1 + '1');
            if (out !== url) dklog('single-column: rewrote render request maxNumberColumns→1');
            return out;
        } catch (e) { dkerr('rewriteRenderUrl failed:', e); return url; }
    }
    function installSingleColumnRewrite() {
        if (window.__dekindled._singleColInstalled) return;
        window.__dekindled._singleColInstalled = true;

        // Bind to window so the native fetch is always invoked with the correct
        // receiver. Webpack chunk loading often calls a destructured `fetch`
        // (this !== window); forwarding that `this` throws "Illegal invocation"
        // and surfaces as a ChunkLoadError that breaks the reader's own bundle.
        const origFetch = window.fetch.bind(window);
        if (typeof window.fetch === 'function') {
            window.fetch = function(input, init) {
                try {
                    if (typeof input === 'string') {
                        input = rewriteRenderUrl(input);
                    } else if (input && typeof input.url === 'string') {
                        const nu = rewriteRenderUrl(input.url);
                        if (nu !== input.url) input = new Request(nu, input);
                    }
                } catch (e) { dkerr('fetch single-column rewrite error:', e); }
                return origFetch(input, init);
            };
        }

        const OrigOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            try { if (typeof url === 'string') arguments[1] = rewriteRenderUrl(url); } catch (e) {}
            return OrigOpen.apply(this, arguments);
        };
        dklog('single-column render rewrite installed');
    }

    // Install the rewrite as early as possible when the capture opted into it.
    if (armedFromStorage('dekindled_single_column')) {
        installSingleColumnRewrite();
    }

    // Only the top frame has the reader UI / creates the page blobs.
    if (window.top === window) {
        const armed = armedFromStorage('dekindled_armed');
        const autoscan = armedFromStorage('dekindled_autoscan');
        const singleCol = armedFromStorage('dekindled_single_column');
        dklog(`post-reload flags: armed=${armed} autoscan=${autoscan} singleColumn=${singleCol}`);
        if (armed) {
            window.__dekindled.capturing = true;
            dklog('resumed ARMED capture after reload (catching the reader preload from page load)');
        }
        if (autoscan) {
            // Defer until <body> exists — at document_start it may not, and the
            // driver appends a status panel + queries the reader DOM.
            whenBodyReady(startCaptureDriver);
        }
    }

    function startCaptureDriver() {
        dklog('capture driver starting (forward capture from current page to end)');
        const NEXT = ['.kr-chevron-container-right', '#kr-chevron-right',
                      '[aria-label="Next page"]', '[aria-label="Next Page"]',
                      '[class*="chevron-container-right"]'];
        const firstEl = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
        const fireKey = (t, key, kc) => {
            // Wrap each dispatch: the reader's own keydown handler runs
            // synchronously here, and if the reader is in a bad state its
            // handler can throw — we don't want that to abort our turn/tick.
            const o = { key, code: key, keyCode: kc, which: kc, bubbles: true, cancelable: true };
            try { t.dispatchEvent(new KeyboardEvent('keydown', o)); } catch (e) {}
            try { t.dispatchEvent(new KeyboardEvent('keyup', o)); } catch (e) {}
        };
        const turn = () => {
            const el = firstEl(NEXT);
            [el, document, document.body].filter(Boolean).forEach(t => fireKey(t, 'ArrowRight', 39));
            if (el) { try { el.click(); } catch (e) {} }
        };
        const pageNum = () => { const f = readFooter(); return f ? (f.page + '/' + f.total) : null; };
        const scr = () => { const b = document.querySelector('#kr-scrubber-bar'); return b ? b.value : null; };
        const scrFrac = () => { const b = document.querySelector('#kr-scrubber-bar'); if (!b || b.max == null) return null; const v = Number(b.value), m = Number(b.max); return m ? v / m : null; };
        const isUnavailable = (el) => {
            if (!el) return true;
            if (el.disabled) return true;
            try { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return true; } catch (e) {}
            return false;
        };
        // We're at the end only when there's POSITIVE evidence: the scrubber is
        // ~100%, or a next-page control exists but is now disabled/hidden. A
        // *missing* control is NOT evidence of the end — the newer "Kindle for
        // Web" reader has no .kr-chevron at all, so treating absence as "end"
        // used to make the scan quit on tick 1. When there's no signal we let
        // the stable-count fallback (STABLE_STOP) decide instead.
        const atEnd = () => {
            const f = scrFrac();
            if (f != null && f >= 0.995) return true;
            // Footer says we're on the last page (works on the new reader).
            const ft = readFooter();
            if (ft && ft.total && ft.page >= ft.total) return true;
            const nextEl = firstEl(NEXT);
            if (nextEl && isUnavailable(nextEl)) return true;
            return false;
        };

        const TICK = 800;
        const STABLE_STOP = 14;   // ~11s of no progress => treat as end of book (fallback)
        const MAX_TICKS = 10000;
        const START_DELAY = 2500; // let the reader settle + do its initial preload

        // ---- status panel with a live count + Stop button ----
        const panel = document.createElement('div');
        panel.className = 'dekindled-done-banner';
        panel.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#1976d2;color:#fff;padding:10px 14px;z-index:2147483647;border-radius:8px;font-family:-apple-system,sans-serif;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;gap:12px;';
        const txt = document.createElement('span');
        txt.textContent = '📚 DeKindled: preparing to capture…';
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '■ Stop';
        stopBtn.style.cssText = 'background:#f44336;color:#fff;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600;';
        panel.appendChild(txt);
        panel.appendChild(stopBtn);
        document.body.appendChild(panel);

        let iv = null;
        stopBtn.onclick = () => { if (iv) { clearInterval(iv); iv = null; } finish('stopped'); };

        // One-time probe: log which page-turn controls this reader exposes, so
        // we can adapt navigation to the newer "Kindle for Web" DOM if needed.
        setTimeout(() => {
            try {
                const found = NEXT.map(s => `${s}:${document.querySelectorAll(s).length}`).join('  ');
                dklog('nav-probe — NEXT selector hit counts:', found,
                      '| scrubber:', !!document.querySelector('#kr-scrubber-bar'),
                      '| stored so far:', window.__dekindled.blobData.size);
            } catch (e) { dkerr('nav-probe failed:', e); }
        }, START_DELAY - 200);

        setTimeout(() => {
            let tick = 0, stable = 0, lastSig = null;
            iv = setInterval(() => {
                try {
                    tick++;
                    if (tick > MAX_TICKS) { clearInterval(iv); iv = null; finish('safety cap'); return; }

                    // Log BEFORE turn() so a tick is always visible even if the
                    // reader's key handler misbehaves during navigation.
                    const n = window.__dekindled.blobData.size;
                    const ft = readFooter();
                    if (tick % 3 === 0) txt.textContent = `📚 DeKindled: capturing… ${n} images${ft ? ` (footer p.${ft.page}/${ft.total})` : ''}`;
                    dklog(`driver tick ${tick} footer=${ft ? ft.page + '/' + ft.total : '?'} storedImages=${n} stable=${stable}`);

                    turn();

                    const sig = (pageNum() || '?') + '|' + scr() + '|' + window.__dekindled.blobData.size;
                    if (sig === lastSig) stable++; else stable = 0;
                    lastSig = sig;

                    if (atEnd() || stable >= STABLE_STOP) { clearInterval(iv); iv = null; finish(atEnd() ? 'reached end of book' : 'no more new pages'); }
                } catch (e) {
                    dkerr('driver tick error:', e);
                }
            }, TICK);
        }, START_DELAY);

        function finish(reason) {
            if (iv) { clearInterval(iv); iv = null; }
            window.__dekindled.capturing = false;
            clearStorage('dekindled_armed');
            clearStorage('dekindled_autoscan');
            const n = window.__dekindled.blobData.size;
            dklog(`driver finished (${reason}) — ${n} pages captured. Click the DeKindled icon to download.`);
            if (stopBtn.parentNode) stopBtn.remove();
            txt.textContent = `📚 DeKindled: captured ${n} pages — click the extension icon, then “Download Images”`;
            panel.style.background = '#2e7d32';
        }
    }
})();