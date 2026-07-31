// DeKindled - Inject blob interceptor script as early as possible

// --- Logging helpers (toggle with DK_DEBUG) ---
const DK_DEBUG = false;
const _tag = '[DeKindled][inject]';
const dklog  = (...a) => { if (DK_DEBUG) console.log(_tag, ...a); };
const dkwarn = (...a) => console.warn(_tag, ...a);
const dkerr  = (...a) => console.error(_tag, ...a);

const _frame = (window.top === window) ? 'TOP frame' : 'IFRAME';
dklog(`content script loaded in ${_frame}:`, location.href, '| readyState:', document.readyState);

// Inject script tag with chrome-extension:// URL (CSP-safe)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('interceptor.js');
script.type = 'text/javascript';
script.onload = () => dklog('interceptor.js <script> loaded and executed');
script.onerror = (e) => dkerr('interceptor.js <script> FAILED to load — check web_accessible_resources / CSP', e);

// Inject the script as early as possible
if (document.documentElement) {
    document.documentElement.appendChild(script);
    dklog('interceptor <script> tag appended');
} else {
    // If documentElement doesn't exist yet, wait for it
    dkwarn('documentElement not ready yet, waiting via MutationObserver...');
    const observer = new MutationObserver((mutations, obs) => {
        if (document.documentElement) {
            document.documentElement.appendChild(script);
            dklog('interceptor <script> tag appended (delayed)');
            obs.disconnect();
        }
    });
    observer.observe(document, { childList: true, subtree: true });
}

// Message bridge: Listen for custom events from main world and forward to background
window.addEventListener('dekindled-message', async (event) => {
    const { data } = event.detail;
    dklog('forwarding message to background:', data?.action, data);

    try {
        const response = await chrome.runtime.sendMessage(data);
        dklog('background responded to', data?.action, ':', response);

        // Send response back to main world
        window.dispatchEvent(new CustomEvent('dekindled-response', {
            detail: {
                id: event.detail.id,
                response: response
            }
        }));
    } catch (error) {
        dkerr('error forwarding message', data?.action, ':', error);

        // Send error back to main world
        window.dispatchEvent(new CustomEvent('dekindled-response', {
            detail: {
                id: event.detail.id,
                error: error.message
            }
        }));
    }
});

// Listen for progress messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'conversionProgress') {
        dklog(`progress from background: ${message.current}/${message.total}`);
        // Forward progress update to main world
        window.dispatchEvent(new CustomEvent('dekindled-progress', {
            detail: {
                current: message.current,
                total: message.total
            }
        }));
    } else if (message.action === 'conversionComplete') {
        dklog('completion from background:', message.success ? `success (${message.filename})` : `FAILED (${message.error})`);
        // Forward completion notification to main world
        window.dispatchEvent(new CustomEvent('dekindled-complete', {
            detail: {
                success: message.success,
                filename: message.filename,
                error: message.error
            }
        }));
    }
});

// Fallback: Use chrome.scripting API if main injection fails
setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'injectInterceptor' }, (response) => {
        if (chrome.runtime.lastError) {
            dkwarn('fallback injection message error:', chrome.runtime.lastError.message);
            return;
        }
        if (response && response.success) {
            dklog('interceptor injected via scripting API fallback');
        }
    });
}, 100);