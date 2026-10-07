// ==UserScript==
// @name         Facebook Reel Resolver DEV
// @namespace    iniotakis-tools
// @version      0.1.0
// @description  DEV prototype: discover Reel URLs on Facebook Pages, open a Reel in the background, capture its direct media URLs, and return them through Tampermonkey storage.
// @updateURL    https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/dev/tampermonkey/facebook-reel-resolver-dev.user.js
// @downloadURL  https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/dev/tampermonkey/facebook-reel-resolver-dev.user.js
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_info
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = String(GM_info.script.version || '0.1.0');
    const VERSION_KEY = VERSION.replace(/[^0-9A-Za-z]+/g, '_');
    const AUTO_HASH = '#fbwp-resolve-dev';
    const REEL_MATCH = location.pathname.match(/^\/reel\/(\d+)/i);
    const REEL_ID = REEL_MATCH ? REEL_MATCH[1] : '';

    function resultKey(id) {
        return `fbwp_reel_resolver_dev_${VERSION_KEY}_${id}`;
    }

    function emptyResult(id) {
        return {
            resolverVersion: VERSION,
            reelId: String(id || ''),
            reelUrl: id ? `https://www.facebook.com/reel/${id}` : '',
            capturedAt: '',
            poster: '',
            progressive: null,
            video: null,
            audio: null,
            streams: []
        };
    }

    function loadResult(id) {
        try {
            const raw = GM_getValue(resultKey(id), '');
            if (!raw) return emptyResult(id);
            const parsed = JSON.parse(String(raw));
            return parsed && typeof parsed === 'object'
                ? { ...emptyResult(id), ...parsed }
                : emptyResult(id);
        } catch (_) {
            return emptyResult(id);
        }
    }

    function saveResult(result) {
        result.capturedAt = new Date().toISOString();
        GM_setValue(resultKey(result.reelId), JSON.stringify(result));
    }

    function decodeEfg(value) {
        if (!value) return null;

        try {
            let normalized = String(value)
                .replace(/-/g, '+')
                .replace(/_/g, '/');

            while (normalized.length % 4) normalized += '=';

            const binary = atob(normalized);
            const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_) {
            return null;
        }
    }

    function parseMediaUrl(rawUrl) {
        try {
            const u = new URL(String(rawUrl || ''), location.href);
            if (!/\.mp4(?:$|\?)/i.test(u.href)) return null;
            if (!/\.fbcdn\.net$/i.test(u.hostname) && !/fbcdn\.net$/i.test(u.hostname)) {
                return null;
            }

            const meta = decodeEfg(u.searchParams.get('efg')) || {};
            const tag = String(
                meta.vencode_tag ||
                u.searchParams.get('tag') ||
                ''
            );

            let kind = 'video';

            if (/audio/i.test(tag)) {
                kind = 'audio';
            } else if (/compressed_source|progressive/i.test(tag)) {
                kind = 'progressive';
            }

            return {
                url: u.href,
                kind,
                tag,
                videoId: meta.video_id != null
                    ? String(meta.video_id)
                    : '',
                assetId: meta.xpv_asset_id != null
                    ? String(meta.xpv_asset_id)
                    : '',
                bitrate: Number(meta.bitrate || 0),
                duration: Number(meta.duration_s || 0),
                meta
            };
        } catch (_) {
            return null;
        }
    }

    function streamIdentity(stream) {
        try {
            const u = new URL(stream.url);
            return `${stream.kind}|${stream.tag}|${u.origin}${u.pathname}`;
        } catch (_) {
            return `${stream.kind}|${stream.tag}|${stream.url}`;
        }
    }

    function betterStream(current, incoming) {
        if (!current) return incoming;
        if (Number(incoming.bitrate || 0) > Number(current.bitrate || 0)) {
            return incoming;
        }
        return current;
    }

    function captureReelMedia(rawUrl) {
        if (!REEL_ID) return;

        const stream = parseMediaUrl(rawUrl);
        if (!stream) return;

        /*
         * DASH URLs expose video_id in the efg metadata. Only accept those when
         * they match the Reel currently open. Progressive URLs sometimes omit
         * video_id, so they are kept only as unverified candidates on this
         * dedicated Reel page.
         */
        if (stream.videoId && stream.videoId !== REEL_ID) return;

        const result = loadResult(REEL_ID);
        const identity = streamIdentity(stream);
        const index = result.streams.findIndex(
            item => streamIdentity(item) === identity
        );

        if (index === -1) {
            result.streams.push(stream);
        } else {
            result.streams[index] = betterStream(result.streams[index], stream);
        }

        if (stream.kind === 'progressive') {
            result.progressive = betterStream(result.progressive, stream);
        } else if (stream.kind === 'audio') {
            result.audio = betterStream(result.audio, stream);
        } else {
            result.video = betterStream(result.video, stream);
        }

        saveResult(result);
        console.log('[FBWP Reel DEV] Captured', stream.kind, stream.tag, stream.url);
    }

    function requestUrl(input) {
        try {
            if (typeof input === 'string') return input;
            if (input instanceof URL) return input.href;
            if (input && typeof input.url === 'string') return input.url;
        } catch (_) {}
        return '';
    }

    function installPageNetworkHooks() {
        if (!REEL_ID) return;

        try {
            const pageWindow = typeof unsafeWindow !== 'undefined'
                ? unsafeWindow
                : window;

            if (!pageWindow.__fbwpReelResolverFetchHook) {
                const originalFetch = pageWindow.fetch;

                if (typeof originalFetch === 'function') {
                    const wrappedFetch = function(...args) {
                        try {
                            captureReelMedia(requestUrl(args[0]));
                        } catch (_) {}

                        return originalFetch.apply(this, args);
                    };

                    try {
                        Object.defineProperty(wrappedFetch, 'name', {
                            value: originalFetch.name || 'fetch'
                        });
                    } catch (_) {}

                    pageWindow.fetch = wrappedFetch;
                    pageWindow.__fbwpReelResolverFetchHook = true;
                }
            }

            const xhrProto = pageWindow.XMLHttpRequest?.prototype;

            if (xhrProto && !xhrProto.__fbwpReelResolverOpenHook) {
                const originalOpen = xhrProto.open;

                xhrProto.open = function(method, url, ...rest) {
                    try {
                        captureReelMedia(requestUrl(url));
                    } catch (_) {}

                    return originalOpen.call(this, method, url, ...rest);
                };

                Object.defineProperty(xhrProto, '__fbwpReelResolverOpenHook', {
                    configurable: true,
                    value: true
                });
            }
        } catch (e) {
            console.error('[FBWP Reel DEV] Network hook failed:', e);
        }
    }

    function capturePoster() {
        if (!REEL_ID) return;

        const video = document.querySelector('video');
        const poster = String(video?.poster || '').trim();
        if (!poster) return;

        const result = loadResult(REEL_ID);
        if (result.poster === poster) return;

        result.poster = poster;
        saveResult(result);
    }

    function resolutionComplete(result) {
        return Boolean(
            result?.progressive?.url ||
            (result?.video?.url && result?.audio?.url)
        );
    }

    function startReelMode() {
        installPageNetworkHooks();

        const timer = setInterval(() => {
            capturePoster();

            const result = loadResult(REEL_ID);
            if (!resolutionComplete(result)) return;

            console.log('[FBWP Reel DEV] Resolution complete:', result);

            if (location.hash === AUTO_HASH) {
                clearInterval(timer);
                setTimeout(() => {
                    try {
                        window.close();
                    } catch (_) {}
                }, 1000);
            }
        }, 400);

        setTimeout(() => {
            clearInterval(timer);
            capturePoster();
            console.log('[FBWP Reel DEV] Final result:', loadResult(REEL_ID));
        }, 30000);
    }

    function canonicalReel(value) {
        try {
            const u = new URL(String(value || ''), location.href);
            const match = u.pathname.match(/^\/reel\/(\d+)/i);
            if (!match) return null;

            return {
                id: match[1],
                url: `https://www.facebook.com/reel/${match[1]}`
            };
        } catch (_) {
            return null;
        }
    }

    function discoverReels() {
        const reels = new Map();

        for (const link of document.querySelectorAll('a[href*="/reel/"]')) {
            const reel = canonicalReel(link.href);
            if (reel) reels.set(reel.id, reel);
        }

        for (const host of document.querySelectorAll('[data-video-id]')) {
            const id = String(host.getAttribute('data-video-id') || '').trim();
            if (!/^\d+$/.test(id)) continue;

            reels.set(id, {
                id,
                url: `https://www.facebook.com/reel/${id}`
            });
        }

        return [...reels.values()];
    }

    function createPagePanel() {
        if (document.getElementById('fbwp-reel-resolver-dev')) return;

        const panel = document.createElement('div');
        panel.id = 'fbwp-reel-resolver-dev';
        panel.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:2147483647',
            'width:360px',
            'padding:12px',
            'background:#111',
            'color:#fff',
            'border:1px solid #555',
            'border-radius:8px',
            'font:12px/1.4 Arial,sans-serif',
            'box-shadow:0 8px 30px rgba(0,0,0,.35)'
        ].join(';');

        panel.innerHTML = `
            <div style="font-weight:700;margin-bottom:8px">FBWP Reel Resolver DEV ${VERSION}</div>
            <select data-role="reels" style="width:100%;margin-bottom:8px"></select>
            <div style="display:flex;gap:8px;margin-bottom:8px">
                <button data-action="refresh" type="button">Refresh reels</button>
                <button data-action="resolve" type="button">Resolve selected</button>
            </div>
            <pre data-role="status" style="white-space:pre-wrap;margin:0;max-height:180px;overflow:auto">Ready.</pre>
        `;

        document.documentElement.appendChild(panel);

        const select = panel.querySelector('[data-role="reels"]');
        const status = panel.querySelector('[data-role="status"]');

        function refresh() {
            const previous = select.value;
            const reels = discoverReels();

            select.innerHTML = '';

            for (const reel of reels) {
                const option = document.createElement('option');
                option.value = reel.id;
                option.textContent = `${reel.id}  ${reel.url}`;
                select.appendChild(option);
            }

            if (previous && reels.some(reel => reel.id === previous)) {
                select.value = previous;
            }

            status.textContent = `Visible Reel/video IDs: ${reels.length}`;
        }

        async function resolveSelected() {
            const id = String(select.value || '').trim();
            if (!id) {
                status.textContent = 'No Reel/video ID selected.';
                return;
            }

            GM_deleteValue(resultKey(id));

            const url = `https://www.facebook.com/reel/${id}${AUTO_HASH}`;
            status.textContent = `Opening ${url}\nWaiting for direct media URLs...`;

            const tab = GM_openInTab(url, {
                active: false,
                insert: true,
                setParent: true
            });

            const started = Date.now();

            const poll = setInterval(() => {
                const result = loadResult(id);
                const elapsed = Math.round((Date.now() - started) / 1000);

                status.textContent = JSON.stringify({
                    elapsedSeconds: elapsed,
                    reelId: id,
                    poster: Boolean(result.poster),
                    progressive: result.progressive?.tag || '',
                    video: result.video?.tag || '',
                    audio: result.audio?.tag || '',
                    streamCount: result.streams.length,
                    complete: resolutionComplete(result)
                }, null, 2);

                if (!resolutionComplete(result) && elapsed < 30) return;

                clearInterval(poll);

                if (resolutionComplete(result)) {
                    status.textContent = JSON.stringify(result, null, 2);
                    console.log('[FBWP Reel DEV] Resolved result:', result);
                } else {
                    status.textContent += '\n\nTimed out after 30 seconds.';
                    try {
                        tab?.close?.();
                    } catch (_) {}
                }
            }, 500);
        }

        panel.querySelector('[data-action="refresh"]')
            .addEventListener('click', refresh);

        panel.querySelector('[data-action="resolve"]')
            .addEventListener('click', resolveSelected);

        refresh();
        setInterval(refresh, 2500);
    }

    if (REEL_ID) {
        startReelMode();
        return;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createPagePanel, { once: true });
    } else {
        createPagePanel();
    }
})();
