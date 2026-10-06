// ==UserScript==
// @name         Facebook Page to WordPress Collector Loader
// @namespace    iniotakis-tools
// @version      1.4.7-loader.1
// @description  Loads the generic v1.4.7 Facebook Page collector bundle stored in this repository.
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      raw.githubusercontent.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const PAYLOAD_URL = 'https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/payload/v1.4.7.b64';
    const EXPECTED_SHA256 = '8d51223f55c2e77893085788dad0113176313f2f7c38ff93881bc6d9ebb23aaf';

    function gmGet(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response.responseText.trim());
                    } else {
                        reject(new Error(`HTTP ${response.status} loading ${url}`));
                    }
                },
                onerror: () => reject(new Error(`Network error loading ${url}`))
            });
        });
    }

    function base64ToBytes(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async function gunzip(bytes) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('This browser does not support DecompressionStream. Use a current Chrome/Edge/Firefox build.');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
    }

    async function sha256(text) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function boot() {
        const payload = await gmGet(PAYLOAD_URL);
        const source = await gunzip(base64ToBytes(payload));
        const hash = await sha256(source);
        if (hash !== EXPECTED_SHA256) {
            throw new Error(`Collector payload hash mismatch: ${hash}`);
        }

        // Direct eval keeps execution inside the userscript sandbox, where GM_* APIs are available.
        eval(source);
    }

    boot().catch((error) => {
        console.error('[FB→WP loader]', error);
        alert(`Facebook collector failed to load:\n${error.message}`);
    });
})();
