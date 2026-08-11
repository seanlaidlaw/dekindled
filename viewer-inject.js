// DeKindled - compact, NON-BLOCKING control banner.
// Injected when the extension icon is clicked. It does not cover the reader, so
// you can turn the book to its first page yourself before starting a capture.
(function () {
    const DK_DEBUG = false;
    const _tag = '[DeKindled][viewer]';
    const dklog = (...a) => { if (DK_DEBUG) console.log(_tag, ...a); };
    const dkerr = (...a) => console.error(_tag, ...a);

    const dk = window.__dekindled;

    // Clear the interceptor driver's status banner (capture is done — this
    // control banner takes over for downloading).
    document.querySelectorAll('.dekindled-done-banner').forEach(b => b.remove());

    // Re-show if the banner is already present.
    const existing = document.getElementById('dekindled-viewer-overlay');
    if (existing) { existing.style.display = 'flex'; }

    const banner = existing || document.createElement('div');
    if (!existing) {
        banner.id = 'dekindled-viewer-overlay';
        banner.style.cssText = [
            'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:2147483646', 'background:#1976d2', 'color:#fff',
            'padding:10px 14px', 'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,.35)',
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
            'font-size:13px', 'display:flex', 'align-items:center', 'gap:10px', 'max-width:92vw'
        ].join(';');
        document.body.appendChild(banner);
    }

    function makeBtn(label, bg) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `background:${bg};color:#fff;border:none;padding:7px 12px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;`;
        return b;
    }

    function pageCount() { return (dk && dk.blobData) ? dk.blobData.size : 0; }

    // ---- Render the banner based on whether anything has been captured ----
    function render(customText) {
        banner.innerHTML = '';
        const text = document.createElement('span');
        text.id = 'dk-banner-text';
        text.style.cssText = 'display:flex;align-items:center;';
        banner.appendChild(text);

        const n = pageCount();

        if (customText) {
            text.innerHTML = customText;
        } else if (!dk) {
            text.innerHTML = '❌ Capture engine not found — reload the book page.';
        } else if (n > 0) {
            text.innerHTML = `📚 <strong style="margin:0 4px;">${n}</strong> pages captured`;
            const dl = makeBtn('⬇ Download Images', '#4caf50');
            dl.onclick = downloadImages;
            const clr = makeBtn('Clear', '#757575');
            clr.onclick = clearCache;
            banner.appendChild(dl);
            banner.appendChild(clr);
        } else {
            text.innerHTML = '📚 Turn the book to its <strong style="margin:0 4px;">first page</strong>, then →';
            const start = makeBtn('▶ Start Capture', '#4caf50');
            start.onclick = startCapture;
            banner.appendChild(start);

            // Single-column toggle — forces the reader's /renderer/render
            // requests to maxNumberColumns=1 so exported pages are one column.
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.id = 'dk-single-col';
            cb.checked = true;
            label.appendChild(cb);
            label.appendChild(document.createTextNode('Single-column'));
            banner.appendChild(label);
        }

        const close = makeBtn('✕', 'rgba(255,255,255,0.15)');
        close.style.padding = '7px 9px';
        close.title = 'Close';
        close.onclick = () => banner.remove();
        banner.appendChild(close);
    }

    // ---- Start: arm capture, then reload so the reader re-renders from the
    // current (first) page while we're capturing. The interceptor's driver then
    // forward-scans to the end. (Nothing is captured until this runs.) ----
    function startCapture() {
        if (!dk || !dk.blobData) {
            render('❌ Capture engine not found — reload the book page.');
            return;
        }
        const cb = document.getElementById('dk-single-col');
        const singleColumn = cb ? cb.checked : false;
        dklog('arming capture + reloading to capture from the current page (singleColumn=' + singleColumn + ')');
        render('🔄 Reloading to capture from this page…');
        try {
            sessionStorage.setItem('dekindled_armed', '1');
            sessionStorage.setItem('dekindled_autoscan', '1');
            if (singleColumn) sessionStorage.setItem('dekindled_single_column', '1');
            else sessionStorage.removeItem('dekindled_single_column');
        } catch (e) { dkerr('could not set flags:', e); }
        dk.blobData.clear();
        location.reload();
    }

    function clearCache() {
        let cleared = 0;
        if (dk) {
            cleared = pageCount();
            if (dk.blobData) dk.blobData.clear();
            if (Array.isArray(dk.blobs)) dk.blobs.length = 0;
            if (dk.stats) Object.keys(dk.stats).forEach(k => { dk.stats[k] = 0; });
            dk.capturing = false;
        }
        try { sessionStorage.removeItem('dekindled_armed'); sessionStorage.removeItem('dekindled_autoscan'); sessionStorage.removeItem('dekindled_single_column'); } catch (e) {}
        dklog(`cache cleared (${cleared} pages discarded)`);
        render();
    }

    // ---- Message bridge to the background service worker ----
    function sendMessageToBackground(message) {
        return new Promise((resolve, reject) => {
            const messageId = Math.random().toString(36).substr(2, 9);
            const handler = (event) => {
                if (event.detail.id === messageId) {
                    window.removeEventListener('dekindled-response', handler);
                    if (event.detail.error) reject(new Error(event.detail.error));
                    else resolve(event.detail.response);
                }
            };
            window.addEventListener('dekindled-response', handler);
            window.dispatchEvent(new CustomEvent('dekindled-message', { detail: { id: messageId, data: message } }));
            setTimeout(() => { window.removeEventListener('dekindled-response', handler); reject(new Error('Message timeout')); }, 15000);
        });
    }

    // ---- Bundle captured images into a ZIP via the background worker ----
    async function downloadImages() {
        if (!dk || pageCount() === 0) { render('Nothing captured yet.'); return; }
        const title = (document.title || 'DeKindled Book').replace(/\s*[-–]\s*Kindle.*$/i, '').trim() || 'DeKindled Book';

        try {
            render('📤 Preparing download…');

            const pagesData = Array.from(dk.blobData.entries()).map(([url, d], i) => ({
                index: i + 1, base64: d.base64, type: d.type, size: d.size, timestamp: d.timestamp
            }));

            const CHUNK = 5;
            const chunks = [];
            for (let i = 0; i < pagesData.length; i += CHUNK) chunks.push(pagesData.slice(i, i + CHUNK));

            const init = await sendMessageToBackground({
                action: 'initEpubConversion',
                totalPages: pagesData.length,
                totalChunks: chunks.length,
                bookTitle: title,
                bookAuthor: 'Unknown Author'
            });
            if (!init || !init.success) throw new Error((init && init.error) || 'init failed');
            const conversionId = init.conversionId;

            for (let i = 0; i < chunks.length; i++) {
                render(`📤 Sending pages ${i + 1}/${chunks.length}…`);
                const resp = await sendMessageToBackground({
                    action: 'sendPagesChunk', conversionId, chunkIndex: i, totalChunks: chunks.length, pages: chunks[i]
                });
                if (!resp || !resp.success) throw new Error((resp && resp.error) || `chunk ${i + 1} failed`);
                await new Promise(r => setTimeout(r, 80));
            }

            render('🗜️ Building ZIP…');
            const proc = await sendMessageToBackground({ action: 'startEpubProcessing', conversionId });
            if (!proc || !proc.success) throw new Error((proc && proc.error) || 'processing failed');
            // Completion handled by the dekindled-complete listener below.
        } catch (e) {
            dkerr('download error:', e);
            render(`❌ Download error: ${e.message}`);
            setTimeout(render, 4000);
        }
    }

    // ---- Progress / completion from the background ZIP builder ----
    window.addEventListener('dekindled-progress', (event) => {
        const { current, total } = event.detail;
        const t = banner.querySelector('#dk-banner-text');
        if (t) t.innerHTML = `🗜️ Zipping ${current}/${total}…`;
    });
    window.addEventListener('dekindled-complete', (event) => {
        const { success, filename, error } = event.detail;
        if (success) render(`✅ Downloaded: ${filename}`);
        else render(`❌ ${error || 'Download failed'}`);
        setTimeout(render, 5000);
    });

    render();
})();
