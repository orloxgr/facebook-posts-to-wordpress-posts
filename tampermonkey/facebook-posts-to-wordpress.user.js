// ==UserScript==
// @name         Facebook Page to WordPress Collector Loader
// @namespace    iniotakis-tools
// @version      1.4.7-loader.2
// @description  Generic Facebook Page collector for exporting posts to the WordPress importer.
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

    const BASE = 'https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/payload/';
    const PARTS = [
        'v1.4.6.part01.b64',
        'v1.4.6.part02.b64',
        'v1.4.6.part03.b64',
        'v1.4.6.part04.b64',
        'v1.4.6.part05.b64'
    ];
    const EXPECTED_SHA256 = 'c934e99d176afcdba464720919dbbc8a7198ca6edeb58d04399212101fa05b98';

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

    function replaceOrThrow(source, search, replacement, label) {
        if (!source.includes(search)) {
            throw new Error(`Generic collector patch failed: ${label}`);
        }
        return source.replace(search, replacement);
    }

    function genericize(source) {
        source = replaceOrThrow(
            source,
            '// @name         Δήμος Αλοννήσου - Facebook to WordPress One-Time Importer',
            '// @name         Facebook Page to WordPress Collector',
            'name'
        );
        source = replaceOrThrow(source, '// @version      1.4.6', '// @version      1.4.7', 'version');
        source = replaceOrThrow(
            source,
            '// @description  One-time import of old Facebook Page posts to alonissos.gov.gr with original date, text and photos.',
            '// @description  Collect Facebook Page posts to JSON for WordPress import, preserving source dates, text and photos.',
            'description'
        );
        source = replaceOrThrow(
            source,
            '// @match        https://www.facebook.com/dimos.alonnisou*\n// @match        https://www.facebook.com/dimos.alonnisou/*',
            '// @match        https://www.facebook.com/*\n// @match        https://facebook.com/*',
            'match'
        );
        source = replaceOrThrow(source, '// @connect      alonissos.gov.gr', '// @connect      *', 'connect');

        source = replaceOrThrow(
            source,
            "(function () {\n    'use strict';\n\n    const CFG = {",
            `(function () {
    'use strict';

    const INITIAL_PAGE_URL = new URL(location.href);

    function pageContextKey(url = INITIAL_PAGE_URL) {
        const parts = url.pathname.split('/').filter(Boolean);
        let identity = parts[0] || 'facebook';

        if (identity.toLowerCase() === 'profile.php') {
            identity = 'profile-' + (url.searchParams.get('id') || 'unknown');
        }

        return identity
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'facebook';
    }

    const PAGE_CONTEXT_KEY = pageContextKey();

    const CFG = {`,
            'page context'
        );

        source = replaceOrThrow(source, "wpBase: 'https://alonissos.gov.gr'", "wpBase: ''", 'wp base');
        source = replaceOrThrow(
            source,
            "targetCategoryName: 'Δελτία Τύπου - Νέα - Ανακοινώσεις'",
            "targetCategoryName: 'Facebook Import'",
            'category'
        );
        source = replaceOrThrow(
            source,
            "importedStorageKey: 'alonissos_fbwp_imported_v1_4_6'",
            "importedStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_imported_v1_4_7`",
            'imported storage'
        );
        source = replaceOrThrow(
            source,
            "archiveStorageKey: 'alonissos_fbwp_archive_v1_4_6'",
            "archiveStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_archive_v1_4_7`",
            'archive storage'
        );
        source = replaceOrThrow(
            source,
            "cutoffStorageKey: 'alonissos_fbwp_cutoff_v1_4_6'",
            "cutoffStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_cutoff_v1_4_7`",
            'cutoff storage'
        );

        source = replaceOrThrow(
            source,
            `        return (
            /\\/dimos\\.alonnisou\\/posts\\//i.test(s) ||
            /\\/dimos\\.alonnisou\\/photos\\//i.test(s) ||
            /\\/dimos\\.alonnisou\\/videos\\//i.test(s) ||
            /\\/dimos\\.alonnisou\\/reel\\//i.test(s) ||
            /\\/permalink(?:\\.php|\\/)/i.test(s) ||
            /\\/story\\.php/i.test(s) ||
            /[?&]story_fbid=/i.test(s) ||
            /[?&]fbid=/i.test(s)
        );`,
            `        return (
            /facebook\\.com\\/[^/?#]+\\/posts\\//i.test(s) ||
            /facebook\\.com\\/[^/?#]+\\/photos\\//i.test(s) ||
            /facebook\\.com\\/[^/?#]+\\/videos\\//i.test(s) ||
            /facebook\\.com\\/(?:[^/?#]+\\/)?reel\\//i.test(s) ||
            /\\/permalink(?:\\.php|\\/)/i.test(s) ||
            /\\/story\\.php/i.test(s) ||
            /[?&]story_fbid=/i.test(s) ||
            /[?&]fbid=/i.test(s)
        );`,
            'permalink patterns'
        );

        source = replaceOrThrow(
            source,
            `        const profile = root.querySelector(
            '[data-ad-rendering-role="profile_name"]'
        );

        const actions = root.querySelector(
            '[aria-label^="Actions for this post by Δήμος Αλοννήσου"]'
        );

        if (
            !profile ||
            !actions ||
            isInsideComment(profile, root) ||
            isInsideComment(actions, root)
        ) {
            return false;
        }

        return normalize(
            profile.innerText ||
            profile.textContent
        ).includes(
            'δημος αλοννησου'
        );`,
            `        const profile = root.querySelector(
            '[data-ad-rendering-role="profile_name"]'
        );

        const actions = [
            ...root.querySelectorAll(
                '[aria-label^="Actions for this post by "]'
            )
        ].find(el =>
            !isInsideComment(el, root)
        );

        if (
            !profile ||
            !actions ||
            isInsideComment(profile, root)
        ) {
            return false;
        }

        const profileName = normalize(
            String(
                profile.innerText ||
                profile.textContent ||
                ''
            ).split('\\n')[0]
        );

        const actionAuthor = normalize(
            String(
                actions.getAttribute('aria-label') || ''
            ).replace(
                /^Actions for this post by\\s+/i,
                ''
            )
        );

        return Boolean(
            profileName &&
            actionAuthor &&
            (
                profileName === actionAuthor ||
                profileName.includes(actionAuthor) ||
                actionAuthor.includes(profileName)
            )
        );`,
            'post author boundary'
        );

        source = replaceOrThrow(
            source,
            "/\\/dimos\\.alonnisou\\/?$/i.test(href)",
            "/^https?:\\/\\/(?:www\\.)?facebook\\.com\\/[^/?#]+\\/?$/i.test(href)",
            'profile image exclusion'
        );

        source = replaceOrThrow(
            source,
            "`alonissos-facebook-archive-${ts}.json`",
            "`facebook-${PAGE_CONTEXT_KEY}-archive-${ts}.json`",
            'export filename'
        );

        source = replaceOrThrow(
            source,
            `    function getCredentials() {
        if (credentials) return credentials;

        const user = prompt('WordPress username για alonissos.gov.gr:');
        if (!user) throw new Error('Ακυρώθηκε: λείπει username.');

        const pass = prompt(
            'WordPress Application Password (όχι το κανονικό password):'
        );
        if (!pass) throw new Error('Ακυρώθηκε: λείπει Application Password.');

        credentials = {
            user: user.trim(),
            pass: pass.replace(/\\s+/g, '')
        };
        return credentials;
    }`,
            `    function getCredentials() {
        if (credentials) return credentials;

        const site = prompt(
            'WordPress site URL (π.χ. https://example.com):',
            CFG.wpBase || ''
        );
        if (!site) throw new Error('Ακυρώθηκε: λείπει WordPress site URL.');

        const wpBase = String(site).trim().replace(/\\/+$/, '');

        try {
            const parsed = new URL(wpBase);
            if (!/^https?:$/i.test(parsed.protocol)) {
                throw new Error('bad protocol');
            }
        } catch (_) {
            throw new Error('Μη έγκυρο WordPress site URL.');
        }

        const user = prompt('WordPress username:');
        if (!user) throw new Error('Ακυρώθηκε: λείπει username.');

        const pass = prompt(
            'WordPress Application Password (όχι το κανονικό password):'
        );
        if (!pass) throw new Error('Ακυρώθηκε: λείπει Application Password.');

        credentials = {
            wpBase,
            user: user.trim(),
            pass: pass.replace(/\\s+/g, '')
        };
        return credentials;
    }`,
            'WordPress credentials'
        );

        source = replaceOrThrow(source, 'url: CFG.wpBase + path,', 'url: c.wpBase + path,', 'WP REST URL');
        source = replaceOrThrow(
            source,
            "url: CFG.wpBase + '/wp-json/wp/v2/media',",
            "url: c.wpBase + '/wp-json/wp/v2/media',",
            'WP media URL'
        );
        source = replaceOrThrow(
            source,
            "`Site: ${CFG.wpBase}\\n\\n` +",
            "`Site: θα ζητηθεί πριν το import\\n\\n` +",
            'WP confirm site'
        );
        source = source.replace(
            'v1.4.1 uses ONLY its own Tampermonkey storage.',
            'v1.4.7 uses ONLY its own page-scoped Tampermonkey storage.'
        );

        const forbidden = [
            'dimos.alonnisou',
            'alonissos.gov.gr',
            'Δήμος Αλοννήσου',
            'δημος αλοννησου',
            'alonissos_fbwp_',
            'alonissos-facebook-archive-'
        ];

        for (const value of forbidden) {
            if (source.includes(value)) {
                throw new Error(`Generic collector still contains client-specific value: ${value}`);
            }
        }

        return source;
    }

    async function boot() {
        const parts = [];
        for (const part of PARTS) {
            parts.push(await gmGet(BASE + part));
        }

        const originalSource = await gunzip(base64ToBytes(parts.join('')));
        const hash = await sha256(originalSource);
        if (hash !== EXPECTED_SHA256) {
            throw new Error(`Collector payload hash mismatch: ${hash}`);
        }

        const source = genericize(originalSource);

        // Direct eval keeps execution inside the userscript sandbox, where GM_* APIs are available.
        eval(source);
    }

    boot().catch((error) => {
        console.error('[FB→WP loader]', error);
        alert(`Facebook collector failed to load:\n${error.message}`);
    });
})();
