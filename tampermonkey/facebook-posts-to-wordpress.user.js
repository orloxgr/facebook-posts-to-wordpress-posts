// ==UserScript==
// @name         Facebook Page to WordPress Collector
// @namespace    iniotakis-tools
// @version      1.4.15
// @description  Collect Facebook Page posts to JSON for WordPress import, preserving source dates, text and photos.
// @updateURL    https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js
// @downloadURL  https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_info
// @connect      *
// @connect      *.fbcdn.net
// @connect      facebook.com
// @connect      www.facebook.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // Runtime version always comes from the single @version metadata field above.
    const VERSION = String(GM_info.script.version);
    const VERSION_KEY = VERSION.replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '');

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

    const CFG = {
        wpBase: '',
        targetCategoryName: 'Facebook Import',
        defaultStatus: 'publish', // publish or draft
        includeFirstImageInContent: true,
        minImageWidth: 220,
        minImageHeight: 160,
        maxImagesPerPost: 20,
        importedStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_imported_${VERSION_KEY}`,
        archiveStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_archive_${VERSION_KEY}`,
        cutoffStorageKey: `fbwp_${PAGE_CONTEXT_KEY}_cutoff_${VERSION_KEY}`
    };

    let scannedPosts = [];
    let credentials = null;
    let busy = false;
    let collectorStopRequested = false;

    const MONTHS = {
        // Greek, normalized without accents
        'ιανουαριου': 0,
        'φεβρουαριου': 1,
        'μαρτιου': 2,
        'απριλιου': 3,
        'μαιου': 4,
        'ιουνιου': 5,
        'ιουλιου': 6,
        'αυγουστου': 7,
        'σεπτεμβριου': 8,
        'οκτωβριου': 9,
        'νοεμβριου': 10,
        'δεκεμβριου': 11,

        // English
        'january': 0, 'jan': 0,
        'february': 1, 'feb': 1,
        'march': 2, 'mar': 2,
        'april': 3, 'apr': 3,
        'may': 4,
        'june': 5, 'jun': 5,
        'july': 6, 'jul': 6,
        'august': 7, 'aug': 7,
        'september': 8, 'sep': 8, 'sept': 8,
        'october': 9, 'oct': 9,
        'november': 10, 'nov': 10,
        'december': 11, 'dec': 11
    };

    function normalize(s) {
        return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function basicAuth(user, pass) {
        const bytes = new TextEncoder().encode(`${user}:${pass}`);
        let binary = '';
        bytes.forEach(b => binary += String.fromCharCode(b));
        return 'Basic ' + btoa(binary);
    }

    function gmRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                timeout: 60000,
                ...opts,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('Request timeout'))
            });
        });
    }

    function getImported() {
        try {
            const raw = GM_getValue(
                CFG.importedStorageKey,
                '[]'
            );

            const parsed = JSON.parse(String(raw || '[]'));

            return new Set(
                Array.isArray(parsed) ? parsed : []
            );
        } catch (_) {
            return new Set();
        }
    }

    function markImported(id) {
        const s = getImported();
        s.add(id);

        GM_setValue(
            CFG.importedStorageKey,
            JSON.stringify([...s])
        );
    }


    function parseArchiveValue(raw) {
        if (raw == null || raw === '') return [];

        try {
            if (Array.isArray(raw)) {
                return raw;
            }

            const parsed = JSON.parse(String(raw));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error('[FB→WP] Archive parse failed:', e);
            return [];
        }
    }

    function loadArchiveRaw() {
        /*
         * Each collector version uses ONLY its own page-scoped Tampermonkey storage.
         * No migration and no fallback to any previous state.
         */
        try {
            return parseArchiveValue(
                GM_getValue(
                    CFG.archiveStorageKey,
                    '[]'
                )
            );
        } catch (e) {
            console.error('[FB→WP] Archive read failed:', e);
            return [];
        }
    }

    function saveArchiveRaw(items) {
        const safeItems = Array.isArray(items)
            ? items
            : [];

        GM_setValue(
            CFG.archiveStorageKey,
            JSON.stringify(safeItems)
        );

        updateArchiveUi(safeItems);
    }

    function canonicalFbPostUrl(url) {
        if (!url) return '';

        try {
            const u = new URL(url, location.origin);

            if (
                !/facebook\.com$/i.test(u.hostname) &&
                !/\.facebook\.com$/i.test(u.hostname)
            ) {
                return '';
            }

            /*
             * Facebook adds volatile tracking params on every render.
             * They MUST NOT participate in archive identity.
             */
            for (const key of [...u.searchParams.keys()]) {
                const k = key.toLowerCase();

                if (
                    k.startsWith('__cft__') ||
                    k.startsWith('__tn__') ||
                    [
                        'mibextid', 'ref', 'refid',
                        'comment_id', 'reply_comment_id',
                        'notif_id', 'notif_t',
                        'paipv', 'eav'
                    ].includes(k)
                ) {
                    u.searchParams.delete(key);
                }
            }

            u.hash = '';

            /*
             * Photo URLs are frequently used as the only stable link exposed
             * by Facebook. fbid is enough to make them deterministic.
             */
            if (
                /\/photo\/?$/i.test(u.pathname) ||
                /\/photo\.php$/i.test(u.pathname)
            ) {
                const fbid = u.searchParams.get('fbid');

                if (fbid) {
                    return `${u.origin}/photo/?fbid=${encodeURIComponent(fbid)}`;
                }
            }

            /*
             * /posts/, /videos/, /reel/ paths already contain their identity;
             * remove all remaining query noise.
             */
            if (
                /\/posts\//i.test(u.pathname) ||
                /\/videos\//i.test(u.pathname) ||
                /\/reel\//i.test(u.pathname)
            ) {
                return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
            }

            /*
             * story.php/permalink.php need their stable identity params.
             */
            if (
                /\/story\.php$/i.test(u.pathname) ||
                /\/permalink\.php$/i.test(u.pathname)
            ) {
                const keep = new URLSearchParams();

                for (const key of ['story_fbid', 'fbid', 'id']) {
                    const value = u.searchParams.get(key);
                    if (value) keep.set(key, value);
                }

                const qs = keep.toString();
                return `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`;
            }

            return u.toString();
        } catch (_) {
            return '';
        }
    }

    function isPostPermalinkUrl(url) {
        if (!url) return false;

        let s = '';

        try {
            s = new URL(url, location.origin).toString();
        } catch (_) {
            s = String(url || '');
        }

        return (
            /facebook\.com\/[^/?#]+\/posts\//i.test(s) ||
            /facebook\.com\/[^/?#]+\/photos\//i.test(s) ||
            /facebook\.com\/[^/?#]+\/videos\//i.test(s) ||
            /facebook\.com\/(?:[^/?#]+\/)?reel\//i.test(s) ||
            /\/permalink(?:\.php|\/)/i.test(s) ||
            /\/story\.php/i.test(s) ||
            /[?&]story_fbid=/i.test(s) ||
            /[?&]fbid=/i.test(s)
        );
    }

    function stableImageIdentity(url) {
        try {
            const u = new URL(url);
            return u.pathname;
        } catch (_) {
            return String(url || '').split('?')[0];
        }
    }

    function makeTextFingerprint(textValue) {
        const body = normalize(
            String(textValue || '')
                .replace(/\s+/g, ' ')
                .trim()
        );

        if (!body) return '';

        return stableHash(body);
    }

    function makePostFingerprint(textValue, dateValue, images = []) {
        const datePart =
            dateValue && !isNaN(dateValue)
                ? wpLocalDateString(dateValue).slice(0, 10)
                : '';

        const body = normalize(
            String(textValue || '')
                .replace(/\s+/g, ' ')
                .trim()
        );

        const imagePart = (images || [])
            .map(img => stableImageIdentity(img?.url || img))
            .sort()
            .join('|');

        return stableHash(
            `${datePart}|${body}|${imagePart}`
        );
    }

    function archiveItemFingerprint(item) {
        if (item?.fingerprint) return item.fingerprint;

        const dateValue = item?.dateIso
            ? new Date(item.dateIso)
            : item?.date || null;

        return makePostFingerprint(
            item?.text || '',
            dateValue,
            item?.images || []
        );
    }

    function mergeArchiveItems(existing, incoming) {
        const a = existing || {};
        const b = incoming || {};

        const aDate = a.dateIso || null;
        const bDate = b.dateIso || null;

        const chooseIncomingDate = Boolean(bDate);
        const chosenDate = chooseIncomingDate
            ? bDate
            : aDate;

        /*
         * Keep timestamp diagnostics for unresolved incoming snapshots.
         * Previously mergeArchiveItems({}, snapshot) discarded dateSource/dateDebug
         * whenever b.dateIso was null, which made unresolved posts impossible to
         * diagnose after export. A dated existing item still keeps its own
         * diagnostics when merged with a later unresolved snapshot.
         */
        const incomingHasDateDiagnostics =
            Boolean(b.dateSource) ||
            b.dateDebug != null;

        const useIncomingDateDiagnostics =
            chooseIncomingDate ||
            (!aDate && incomingHasDateDiagnostics);

        const aPermalink =
            canonicalFbPostUrl(a.permalink || '');
        const bPermalink =
            canonicalFbPostUrl(b.permalink || '');

        const permalink =
            bPermalink || aPermalink || '';

        const idFromUrl =
            extractPostId(permalink);

        const aText = String(a.text || '');
        const bText = String(b.text || '');

        const textValue =
            bText.length >= aText.length
                ? bText
                : aText;

        const imagesByIdentity = new Map();

        for (const img of [
            ...(a.images || []),
            ...(b.images || [])
        ]) {
            const key =
                stableImageIdentity(img?.url || img);

            if (!key) continue;

            const current =
                imagesByIdentity.get(key);

            if (!current) {
                imagesByIdentity.set(key, img);
                continue;
            }

            const currentArea =
                Number(current.width || 0) *
                Number(current.height || 0);

            const incomingArea =
                Number(img?.width || 0) *
                Number(img?.height || 0);

            if (incomingArea > currentArea) {
                imagesByIdentity.set(key, img);
            }
        }

        const images =
            [...imagesByIdentity.values()];

        const dateValue = chosenDate
            ? new Date(chosenDate)
            : null;

        const fingerprint =
            makePostFingerprint(
                textValue,
                dateValue,
                images
            );

        const textFingerprint =
            makeTextFingerprint(textValue);

        return {
            ...a,
            ...b,

            archiveKey:
                permalink ||
                fingerprint,

            fingerprint,
            textFingerprint,

            id:
                idFromUrl ||
                (
                    b.id &&
                    !String(b.id).startsWith('fp-')
                        ? b.id
                        : null
                ) ||
                (
                    a.id &&
                    !String(a.id).startsWith('fp-')
                        ? a.id
                        : null
                ) ||
                `fp-${fingerprint}`,

            permalink,
            text: textValue,
            images,

            dateIso: chosenDate,

            dateSource:
                useIncomingDateDiagnostics
                    ? (b.dateSource || '')
                    : (a.dateSource || ''),

            dateDebug:
                useIncomingDateDiagnostics
                    ? (b.dateDebug ?? null)
                    : (a.dateDebug ?? null),

            collectedAt:
                a.collectedAt ||
                b.collectedAt ||
                new Date().toISOString(),

            imported:
                Boolean(a.imported || b.imported)
        };
    }

    function archiveItemKey(item) {
        const canonical = canonicalFbPostUrl(item?.permalink || '');

        if (canonical && isPostPermalinkUrl(canonical)) {
            return canonical;
        }

        return archiveItemFingerprint(item);
    }

    function repairUnresolvedExactTextDuplicates(map) {
        const groups = new Map();

        for (const [key, item] of map.entries()) {
            const exactText =
                String(item?.text || '');

            if (!exactText) continue;

            if (!groups.has(exactText)) {
                groups.set(
                    exactText,
                    {
                        dated: [],
                        unresolved: []
                    }
                );
            }

            const group =
                groups.get(exactText);

            if (item?.dateIso) {
                group.dated.push({
                    key,
                    item
                });
            } else {
                group.unresolved.push({
                    key,
                    item
                });
            }
        }

        let repaired = 0;

        for (const group of groups.values()) {
            /*
             * Critical safety rule:
             * exactly ONE dated post must exist for this exact full text.
             * If 0 or 2+, we do nothing.
             */
            if (
                group.dated.length !== 1 ||
                !group.unresolved.length
            ) {
                continue;
            }

            const eligibleUnresolved =
                group.unresolved.filter(({ item }) => {
                    const permalink =
                        canonicalFbPostUrl(
                            item?.permalink || ''
                        );

                    const sourceId =
                        extractPostId(permalink) ||
                        (
                            item?.id &&
                            !String(item.id)
                                .startsWith('fp-')
                                ? String(item.id)
                                : ''
                        );

                    /*
                     * Repair only identity-less snapshots.
                     * If an unresolved item has its own real Facebook ID,
                     * it is never merged just because the text matches.
                     */
                    return !sourceId;
                });

            if (!eligibleUnresolved.length) {
                continue;
            }

            const anchor =
                group.dated[0];

            let merged =
                anchor.item;

            for (const duplicate of eligibleUnresolved) {
                merged =
                    mergeArchiveItems(
                        merged,
                        duplicate.item
                    );
            }

            const newKey =
                archiveItemKey(merged);

            map.delete(anchor.key);

            for (const duplicate of eligibleUnresolved) {
                map.delete(duplicate.key);
                repaired++;
            }

            map.set(
                newKey,
                merged
            );
        }

        return repaired;
    }

    function archiveToRuntimeItem(item) {
        return {
            ...item,
            date: item.dateIso ? new Date(item.dateIso) : null,
            imported: getImported().has(item.id)
        };
    }

    function getArchivedRuntimeItems() {
        return loadArchiveRaw().map(archiveToRuntimeItem);
    }

    function updateArchiveUi(items = null) {
        const data = items || loadArchiveRaw();
        const el = document.getElementById('fbwp-archive-count');
        if (!el) return;

        const dated = data.filter(x => x.dateIso).length;
        const unresolved = data.length - dated;
        const linked = data.filter(x =>
            Boolean(canonicalFbPostUrl(x.permalink || ''))
        ).length;

        const imageRisk = data.filter(x =>
            (x.images || []).length >
            CFG.maxImagesPerPost
        ).length;

        el.textContent =
            `Collected: ${data.length} | dated: ${dated} | ` +
            `unresolved: ${unresolved} | links: ${linked}/${data.length} | ` +
            `image-risk: ${imageRisk}`;
    }

    function downloadBlob(content, filename, mimeType) {
        const blob = new Blob(
            [content],
            { type: mimeType }
        );

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = filename;

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(
            () => URL.revokeObjectURL(url),
            3000
        );
    }

    function exportCollectedJson() {
        /*
         * READ-ONLY operation.
         * No save/delete/clear call is allowed in this function.
         */
        const archive = loadArchiveRaw();

        const snapshot = JSON.parse(
            JSON.stringify(archive)
        );

        const dated = snapshot.filter(
            x => x.dateIso
        ).length;

        const unresolved =
            snapshot.length - dated;

        const payload = {
            exportedAt: new Date().toISOString(),
            page: location.href,
            cutoff:
                GM_getValue(
                    CFG.cutoffStorageKey,
                    ''
                ) || '',
            totals: {
                collected: snapshot.length,
                dated,
                unresolved
            },
            posts: snapshot
                .slice()
                .sort((a, b) => {
                    const da = a.dateIso || '9999';
                    const db = b.dateIso || '9999';
                    return da.localeCompare(db);
                })
                .map((item, index) => ({
                    index: index + 1,
                    archiveKey: item.archiveKey || '',
                    fingerprint:
                        item.fingerprint ||
                        archiveItemFingerprint(item),
                    textFingerprint:
                        item.textFingerprint ||
                        makeTextFingerprint(item.text),
                    id: item.id || '',
                    dateIso: item.dateIso || null,
                    dateSource: item.dateSource || '',
                    dateDebug: item.dateDebug || null,
                    permalink: item.permalink || '',
                    text: item.text || '',
                    textLength:
                        (item.text || '').length,
                    images: item.images || [],
                    imageCount:
                        (item.images || []).length,
                    collectedAt:
                        item.collectedAt || '',
                    imported:
                        Boolean(item.imported)
                }))
        };

        const ts = new Date()
            .toISOString()
            .replace(/[:.]/g, '-');

        downloadBlob(
            JSON.stringify(payload, null, 2),
            `facebook-${PAGE_CONTEXT_KEY}-archive-${ts}.json`,
            'application/json;charset=utf-8'
        );

        /*
         * Verify after export that persistent archive still has
         * exactly the same number of items.
         */
        const afterExport =
            loadArchiveRaw().length;

        if (afterExport !== snapshot.length) {
            console.error(
                '[FB→WP] ARCHIVE COUNT CHANGED DURING EXPORT',
                {
                    before: snapshot.length,
                    after: afterExport
                }
            );

            status(
                `JSON exported, αλλά archive count άλλαξε: ` +
                `${snapshot.length} → ${afterExport}`,
                'error'
            );

            return;
        }

        status(
            `JSON exported: ${snapshot.length} posts. ` +
            `Archive παραμένει ${afterExport}.`,
            'ok'
        );
    }

    function clearCollectedArchive() {
        if (!confirm(
            `Να διαγραφεί ΟΛΗ η συλλογή του v${VERSION};`
        )) {
            return;
        }

        try {
            GM_deleteValue(
                CFG.archiveStorageKey
            );

            GM_deleteValue(
                CFG.importedStorageKey
            );
        } catch (e) {
            console.error(
                `[FB→WP] v${VERSION} state delete failed:`,
                e
            );
        }

        updateArchiveUi([]);

        status(
            'Archive cleared: 0 posts.',
            'ok'
        );
    }

    function parseCutoffInput(value) {
        const m = String(value || '').trim().match(
            /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/
        );

        if (!m) return null;

        const d = new Date(
            Number(m[3]),
            Number(m[2]) - 1,
            Number(m[1]),
            0, 0, 0, 0
        );

        if (
            d.getFullYear() !== Number(m[3]) ||
            d.getMonth() !== Number(m[2]) - 1 ||
            d.getDate() !== Number(m[1])
        ) {
            return null;
        }

        return d;
    }

    function startOfDay(date) {
        if (!date || isNaN(date)) return null;
        return new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            0, 0, 0, 0
        );
    }

    function formatDateOnly(date) {
        if (!date || isNaN(date)) return '-';
        const pad = n => String(n).padStart(2, '0');
        return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    }

    function status(msg, level = 'ok') {
        const el =
            document.getElementById('fbwp-status');

        if (!el) return;

        if (level === true) level = 'error';
        if (level === false) level = 'ok';

        const colors = {
            ok: '#d9fdd3',
            warn: '#ffd88a',
            error: '#ffb4b4',
            info: '#d7e8ff'
        };

        el.textContent = msg;
        el.style.color =
            colors[level] || colors.ok;
    }

    function log(...args) {
        console.log('[FB→WP]', ...args);
    }

    function isInsideComment(el, root = null) {
        if (!el || !el.closest) return false;

        const comment =
            el.closest('[data-commentid]') ||
            el.closest('div[role="article"][aria-label^="Comment by "]') ||
            el.closest('div[role="article"][aria-label^="Reply by "]');

        if (!comment) return false;
        if (!root) return true;

        return root.contains(comment);
    }

    function getMainStoriesInside(root) {
        if (!root) return [];

        return [
            ...root.querySelectorAll(
                '[data-ad-rendering-role="story_message"]'
            )
        ].filter(story =>
            !isInsideComment(story, root)
        );
    }

    function isSafePostRoot(root, expectedStory = null) {
        if (!root) return false;

        const stories =
            getMainStoriesInside(root);

        /*
         * Critical boundary rule:
         * one post root must contain exactly one main story_message.
         * Two or more means we climbed into the Facebook feed wrapper.
         */
        if (stories.length !== 1) {
            return false;
        }

        if (
            expectedStory &&
            stories[0] !== expectedStory
        ) {
            return false;
        }

        const profile = root.querySelector(
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
            ).split('\n')[0]
        );

        const actionAuthor = normalize(
            String(
                actions.getAttribute('aria-label') || ''
            ).replace(
                /^Actions for this post by\s+/i,
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
        );
    }

    function findPostRoot(story) {
        let el = story;

        while (
            el &&
            el !== document.body
        ) {
            const stories =
                getMainStoriesInside(el);

            /*
             * Once this ancestor contains multiple posts, going further
             * upward can never become safe again.
             */
            if (stories.length > 1) {
                return null;
            }

            if (
                isSafePostRoot(
                    el,
                    story
                )
            ) {
                return el;
            }

            el = el.parentElement;
        }

        return null;
    }

    function getPostContainers() {
        const roots = [];
        const seen = new Set();

        const stories = [...document.querySelectorAll(
            '[data-ad-rendering-role="story_message"]'
        )];

        for (const story of stories) {
            if (isInsideComment(story)) continue;

            const root = findPostRoot(story);
            if (!root || seen.has(root)) continue;

            seen.add(root);
            roots.push(root);
        }

        return roots;
    }

    function isTargetPost(article) {
        if (!article) return false;
        if (isInsideComment(article)) return false;

        return isSafePostRoot(article);
    }

    function collectReactPostUrls(root) {
        const found = new Set();
        const seen = new WeakSet();

        if (!root) return [];

        function add(value) {
            if (typeof value !== 'string') return;

            const raw = value
                .replace(/\\u002F/g, '/')
                .replace(/\\\//g, '/')
                .replace(/&amp;/g, '&')
                .trim();

            if (!raw || raw.length > 3000) return;

            let candidate = raw;

            // Pull an embedded Facebook URL out of longer React strings.
            const embedded = raw.match(
                /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>\\]+/i
            );

            if (embedded) {
                candidate = embedded[0];
            }

            try {
                const absolute = new URL(candidate, location.origin).toString();

                if (isPostPermalinkUrl(absolute)) {
                    const clean = canonicalFbPostUrl(absolute);
                    if (clean) found.add(clean);
                }
            } catch (_) {}
        }

        function walk(value, depth) {
            if (depth > 6 || value == null) return;

            if (typeof value === 'string') {
                add(value);
                return;
            }

            if (typeof value !== 'object') return;
            if (seen.has(value)) return;
            seen.add(value);

            if (Array.isArray(value)) {
                value.slice(0, 80).forEach(v => walk(v, depth + 1));
                return;
            }

            let count = 0;

            for (const [key, v] of Object.entries(value)) {
                if (++count > 120) break;

                if (
                    depth < 2 ||
                    /href|url|uri|link|permalink|story|post|route|destination|target|props|children/i.test(key)
                ) {
                    walk(v, depth + 1);
                }
            }
        }

        const nodes = [
            root,
            ...root.querySelectorAll?.('a,[role="link"],[aria-labelledby]') || []
        ].slice(0, 80);

        for (const node of nodes) {
            // Plain DOM attributes first.
            add(node.href);
            add(node.getAttribute?.('href'));

            // Facebook/React routing data.
            for (const key of Object.keys(node)) {
                if (/^__react(?:Props|Fiber|Container)/.test(key)) {
                    try {
                        walk(node[key], 0);
                    } catch (_) {}
                }
            }
        }

        return [...found];
    }

    function getPermalink(article) {
        if (!article) return '';

        const direct = [];

        for (const a of article.querySelectorAll('a[href]')) {
            const href = a.href || a.getAttribute('href') || '';

            if (!isPostPermalinkUrl(href)) continue;

            const clean = canonicalFbPostUrl(href);
            if (!clean) continue;

            direct.push({
                url: clean,
                inComment: isInsideComment(a, article),
                timestampLike:
                    Boolean(a.querySelector('abbr')) ||
                    Boolean(a.getAttribute('aria-label')) ||
                    Boolean(a.getAttribute('title')) ||
                    Boolean(a.querySelector('[aria-labelledby]'))
            });
        }

        // Prefer a post URL outside comments.
        const own = direct.find(x => !x.inComment && x.timestampLike) ||
            direct.find(x => !x.inComment);

        if (own) return own.url;

        /*
         * A comment permalink contains the parent post permalink too.
         * After removing comment_id / reply_comment_id it becomes the source post URL.
         * This is verified in the supplied Facebook HTML.
         */
        if (direct.length) {
            return direct[0].url;
        }

        /*
         * Posts with no visible comments can have no useful DOM href at all.
         * Their timestamp anchor is routed by React and may only expose the real
         * post URL inside React props/fiber.
         */
        const roots = [
            findMainTimestampElement(article),
            getMainPostHeader(article),
            article
        ].filter(Boolean);

        for (const root of roots) {
            const urls = collectReactPostUrls(root);
            if (urls.length) return urls[0];
        }

        return '';
    }

    function cleanFbUrl(url) {
        return canonicalFbPostUrl(url) || String(url || '');
    }

    function extractPostId(url) {
        if (!url) return '';

        const s = String(url);

        const patterns = [
            /(pfbid[A-Za-z0-9]+)/,
            /\/posts\/(\d+)/,
            /[?&]story_fbid=(\d+)/,
            /[?&]fbid=(\d+)/,
            /\/videos\/(\d+)/,
            /\/reel\/(\d+)/,
            /\/photos\/[^/]+\/(\d+)/
        ];

        for (const re of patterns) {
            const m = s.match(re);
            if (m) return m[1];
        }

        return '';
    }

    function stableHash(value) {
        let hash = 2166136261;
        const s = String(value || '');

        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }

        return 'h' + (hash >>> 0).toString(36);
    }

    function makeStablePostId(
        permalink,
        textValue,
        dateValue,
        images = []
    ) {
        const fromUrl = extractPostId(permalink);
        if (fromUrl) return fromUrl;

        return 'fp-' + makePostFingerprint(
            textValue,
            dateValue,
            images
        );
    }

    function cleanCollectedText(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\n?\s*(See more|See less|Δείτε περισσότερα|Περισσότερα|Λιγότερα)\s*$/i, '')
            .trim();
    }

    function extractText(article) {
        const story = article.querySelector(
            '[data-ad-rendering-role="story_message"]'
        );

        let visible = '';

        if (story) {
            const primary = story.querySelector(
                'div[data-ad-preview="message"], ' +
                'div[data-ad-comet-preview="message"]'
            );

            visible = cleanCollectedText(
                primary?.innerText ||
                story.innerText ||
                story.textContent ||
                ''
            );
        }

        /*
         * Facebook keeps the complete post text in a hidden/accessibility
         * description on many collapsed posts. This means we can archive the
         * full post without needing a synthetic "See more" click.
         */
        const descriptions = [...article.querySelectorAll(
            '[data-ad-rendering-role="description"]'
        )]
            .filter(el => !isInsideComment(el, article))
            .map(el => cleanCollectedText(el.innerText || el.textContent))
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);

        if (descriptions.length) {
            const prefix = normalize(
                visible
                    .replace(/….*$/s, '')
                    .slice(0, 90)
            );

            const full = descriptions.find(candidate => {
                if (candidate.length <= visible.length) return false;
                if (!prefix || prefix.length < 12) return true;

                return normalize(candidate).includes(prefix);
            });

            if (full) return full;
        }

        return visible;
    }

    function largestImgUrl(img) {
        const srcset = img.getAttribute('srcset');
        if (srcset) {
            const candidates = srcset.split(',')
                .map(part => part.trim().split(/\s+/))
                .map(([url, size]) => ({
                    url,
                    w: parseInt((size || '').replace(/\D/g, ''), 10) || 0
                }))
                .sort((a, b) => b.w - a.w);
            if (candidates[0]?.url) return candidates[0].url;
        }
        return img.currentSrc || img.src || '';
    }

    function extractImages(article) {
        if (!isSafePostRoot(article)) {
            console.error(
                '[FB→WP] IMAGE SCOPE REFUSED: unsafe/broad post root'
            );
            return [];
        }

        const imgs = [
            ...article.querySelectorAll('img')
        ];

        const out = [];
        const seen = new Set();

        for (const img of imgs) {
            if (
                isInsideComment(
                    img,
                    article
                )
            ) {
                continue;
            }

            const url =
                largestImgUrl(img);

            if (
                !url ||
                !/fbcdn\.net/i.test(url)
            ) {
                continue;
            }

            if (
                /emoji|rsrc\.php|static/i.test(url)
            ) {
                continue;
            }

            const a =
                img.closest('a[href]');

            const href =
                a?.href || '';

            /*
             * Exclude page/profile/avatar media.
             */
            if (
                /\/profile\.php/i.test(href) ||
                /^https?:\/\/(?:www\.)?facebook\.com\/[^/?#]+\/?$/i.test(href)
            ) {
                continue;
            }

            const w =
                img.naturalWidth ||
                img.width ||
                img.clientWidth ||
                0;

            const h =
                img.naturalHeight ||
                img.height ||
                img.clientHeight ||
                0;

            if (
                w < CFG.minImageWidth ||
                h < CFG.minImageHeight
            ) {
                continue;
            }

            let key = url;

            try {
                const u = new URL(url);
                key = u.pathname;
            } catch (_) {}

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);

            out.push({
                url,
                alt:
                    (
                        img.getAttribute(
                            'alt'
                        ) || ''
                    ).trim(),
                width: w,
                height: h
            });
        }

        if (
            out.length >
            CFG.maxImagesPerPost
        ) {
            console.error(
                '[FB→WP] IMAGE SAFETY anomaly detected',
                {
                    count: out.length,
                    limit:
                        CFG.maxImagesPerPost,
                    permalink:
                        getPermalink(article)
                }
            );
        }

        return out;
    }

    function getMainPostHeader(article) {
        const profile = article.querySelector(
            '[data-ad-rendering-role="profile_name"]'
        );
        const story = article.querySelector(
            '[data-ad-rendering-role="story_message"]'
        );

        if (!profile || !story) return null;

        let node = profile.parentElement;

        while (node && node !== article && node !== document.body) {
            const hasTimestampLike =
                node.querySelector?.(
                    'a[target="_blank"], time[datetime], [data-utime], [aria-labelledby]'
                );

            if (hasTimestampLike && !node.contains(story)) {
                return node;
            }

            node = node.parentElement;
        }

        return null;
    }

    function findMainTimestampElement(article) {
        const header = getMainPostHeader(article);
        const story = article.querySelector(
            '[data-ad-rendering-role="story_message"]'
        );
        const profile = article.querySelector(
            '[data-ad-rendering-role="profile_name"]'
        );

        if (!story || !profile) return null;

        const scope = header || article;

        const candidates = [
            ...scope.querySelectorAll(
                'a[target="_blank"], time[datetime], [data-utime], [aria-labelledby]'
            )
        ]
            .filter(el => !isInsideComment(el, article))
            .filter(el => !profile.contains(el))
            .filter(el => !story.contains(el));

        let found = candidates.find(el => {
            const vals = collectElementDateStrings(el);
            return vals.some(looksLikeDateText);
        });

        if (found) return found;

        // Exact markup seen in the supplied Facebook HTML.
        found = candidates.find(el =>
            el.matches?.('a[target="_blank"]') &&
            el.querySelector?.('[aria-labelledby]')
        );

        if (found) return found;

        /*
         * Facebook can render the main timestamp anchor structurally but leave
         * its visible/accessibility text empty until hover. In that state the
         * header looks like: Page Name · <a target="_blank" href="?__cft__...">
         * with no text at all. Treat ONLY that same-page, empty __cft__ anchor
         * as the timestamp element so getDateFromHover() can read its tooltip.
         */
        found = candidates.find(el => {
            if (!el.matches?.('a[target="_blank"]')) return false;

            const href = String(el.getAttribute('href') || '').trim();
            const text = String(el.innerText || el.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
            const aria = String(el.getAttribute('aria-label') || '').trim();
            const title = String(el.getAttribute('title') || '').trim();

            if (!href || text || aria || title) return false;

            try {
                const u = new URL(href, location.href);

                return (
                    u.origin === location.origin &&
                    u.pathname === location.pathname &&
                    u.searchParams.has('__cft__[0]') &&
                    !u.searchParams.has('story_fbid') &&
                    !u.searchParams.has('fbid')
                );
            } catch (_) {
                return false;
            }
        });

        return found || null;
    }

    function collectMainTimestampCandidates(article) {
        const values = [];
        const seen = new Set();

        function add(value, source) {
            const v = String(value || '')
                .replace(/\u202f/g, ' ')
                .trim();

            if (!v || !looksLikeDateText(v)) return;

            const key = normalize(v);
            if (seen.has(key)) return;

            seen.add(key);
            values.push({ value: v, source });
        }

        const timestampEl = findMainTimestampElement(article);

        if (timestampEl) {
            for (const value of collectElementDateStrings(timestampEl)) {
                add(value, 'main timestamp');
            }
        }

        // Old Facebook layout / permalink timestamp variants.
        for (const link of article.querySelectorAll('a[href]')) {
            if (isInsideComment(link, article)) continue;

            const href = link.href || '';

            if (
                !href.includes('/posts/') &&
                !href.includes('/photos/') &&
                !href.includes('/videos/') &&
                !href.includes('/reel/') &&
                !href.includes('story_fbid=') &&
                !href.includes('/permalink/')
            ) {
                continue;
            }

            for (const value of collectElementDateStrings(link)) {
                add(value, 'post permalink');
            }
        }

        // Header-only fallback. Never scan story_message/body text.
        const header = getMainPostHeader(article);

        if (header) {
            for (const el of header.querySelectorAll(
                '[aria-label],[title],[aria-labelledby],time[datetime],[data-utime],a,span'
            )) {
                if (isInsideComment(el, article)) continue;

                const textValue = String(
                    el.innerText || el.textContent || ''
                ).trim();

                if (textValue.length <= 100) {
                    add(textValue, 'post header');
                }

                add(el.getAttribute?.('aria-label'), 'post header');
                add(el.getAttribute?.('title'), 'post header');
                add(el.getAttribute?.('datetime'), 'post header');

                const utime = el.getAttribute?.('data-utime');
                if (utime) add('UTIME:' + utime, 'post header');

                const labelledBy = el.getAttribute?.('aria-labelledby');

                if (labelledBy) {
                    for (const id of labelledBy.split(/\s+/)) {
                        const labelEl = document.getElementById(id);
                        if (!labelEl) continue;

                        add(
                            labelEl.innerText || labelEl.textContent,
                            'aria-labelledby'
                        );
                        add(
                            labelEl.getAttribute?.('aria-label'),
                            'aria-labelledby'
                        );
                        add(
                            labelEl.getAttribute?.('title'),
                            'aria-labelledby'
                        );
                    }
                }
            }
        }

        return { values, timestampEl };
    }

    function looksLikeDateText(value) {
        const s = normalize(value).replace(/\./g, '');
        if (!s) return false;

        return (
            /\b\d{4}\b/.test(s) ||
            /\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(s) ||
            Object.keys(MONTHS).some(month => s.includes(month)) ||

            // English short relative labels: 2d, 3h, 5m, 1w
            /^\d+\s*(s|m|h|d|w)$/i.test(s) ||

            // English long relative labels
            /^\d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks)(\s+ago)?$/i.test(s) ||
            /^\d+\s*(day|days)\s+ago$/i.test(s) ||

            // Greek relative labels / abbreviations
            /^\d+\s*(δ|δευτ|δευτερολεπτο|δευτερολεπτα)$/i.test(s) ||
            /^\d+\s*(λ|λεπτ|λεπτο|λεπτα)$/i.test(s) ||
            /^\d+\s*(ωρ|ωρα|ωρες)$/i.test(s) ||
            /^\d+\s*(ημ|ημερα|ημερες)$/i.test(s) ||
            /^\d+\s*(εβδ|εβδομαδα|εβδομαδες)$/i.test(s) ||
            /^(πριν\s+απο\s+)?\d+\s*(δευτερολεπτα|λεπτα|ωρες|ημερες|εβδομαδες)(\s+πριν)?$/i.test(s) ||

            s === 'yesterday' ||
            s.startsWith('yesterday at ') ||
            s === 'χθες' ||
            s.startsWith('χθες στις ') ||
            s === 'just now' ||
            s === 'τωρα'
        );
    }

    function collectElementDateStrings(el) {
        const values = new Set();
        if (!el) return [];

        function add(value) {
            const v = String(value || '').replace(/\u202f/g, ' ').trim();
            if (v) values.add(v);
        }

        add(el.getAttribute?.('aria-label'));
        add(el.getAttribute?.('title'));
        add(el.textContent);

        for (const child of el.querySelectorAll?.('[aria-label],[title],[aria-labelledby],time[datetime],[data-utime]') || []) {
            add(child.getAttribute('aria-label'));
            add(child.getAttribute('title'));
            add(child.getAttribute('datetime'));

            const ut = child.getAttribute('data-utime');
            if (ut) add('UTIME:' + ut);

            const labelledBy = child.getAttribute('aria-labelledby');
            if (labelledBy) {
                for (const id of labelledBy.split(/\s+/)) {
                    const labelEl = document.getElementById(id);
                    if (!labelEl) continue;
                    add(labelEl.getAttribute?.('aria-label'));
                    add(labelEl.getAttribute?.('title'));
                    add(labelEl.innerText || labelEl.textContent);
                }
            }

            add(child.textContent);
        }

        return [...values];
    }

    function collectReactDateStrings(el) {
        const values = new Set();
        if (!el) return [];

        const seen = new WeakSet();

        function walk(value, depth) {
            if (depth > 5 || value == null) return;

            if (typeof value === 'string') {
                const v = value.replace(/\u202f/g, ' ').trim();
                if (v.length <= 220 && looksLikeDateText(v)) values.add(v);
                return;
            }

            if (typeof value !== 'object') return;
            if (seen.has(value)) return;
            seen.add(value);

            if (Array.isArray(value)) {
                value.slice(0, 50).forEach(v => walk(v, depth + 1));
                return;
            }

            let count = 0;
            for (const [key, v] of Object.entries(value)) {
                if (++count > 80) break;
                if (/children|props|label|title|tooltip|time|date|timestamp|accessibility|text/i.test(key) || depth < 2) {
                    walk(v, depth + 1);
                }
            }
        }

        for (const node of [el, ...el.querySelectorAll?.('*') || []].slice(0, 30)) {
            for (const key of Object.keys(node)) {
                if (/^__react(?:Props|Fiber|Container)/.test(key)) {
                    try { walk(node[key], 0); } catch (_) {}
                }
            }
        }

        return [...values];
    }

    function parseFbDate(value) {
        if (!value) return null;

        if (value.startsWith('UTIME:')) {
            const sec = Number(value.slice(6));
            if (Number.isFinite(sec) && sec > 1000000000) {
                return new Date(sec * 1000);
            }
        }

        if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
            const d = new Date(value);
            if (!isNaN(d)) return d;
        }

        let s = normalize(value).replace(/\u202f/g, ' ');

        // Relative Facebook timestamps are calculated from the browser's
        // current LOCAL date/time. If the original clock time is unknown,
        // normalize the result to 00:00:00 as requested.
        const now = new Date();

        function midnight(date) {
            return new Date(
                date.getFullYear(),
                date.getMonth(),
                date.getDate(),
                0, 0, 0, 0
            );
        }

        function subtractRelative(amount, unit) {
            const d = new Date(now);
            const u = String(unit || '').toLowerCase();

            if (
                u === 's' ||
                /^sec/.test(u) ||
                /^(δ|δευτ|δευτερολεπ)/.test(u)
            ) {
                d.setSeconds(d.getSeconds() - amount);
            } else if (
                u === 'm' ||
                /^min/.test(u) ||
                /^(λ|λεπτ)/.test(u)
            ) {
                d.setMinutes(d.getMinutes() - amount);
            } else if (
                u === 'h' ||
                /^(hr|hour)/.test(u) ||
                /^(ωρ|ωρα|ωρες)/.test(u)
            ) {
                d.setHours(d.getHours() - amount);
            } else if (
                u === 'd' ||
                /^day/.test(u) ||
                /^(ημ|ημερα|ημερες)/.test(u)
            ) {
                d.setDate(d.getDate() - amount);
            } else if (
                u === 'w' ||
                /^week/.test(u) ||
                /^(εβδ|εβδομαδα|εβδομαδες)/.test(u)
            ) {
                d.setDate(d.getDate() - amount * 7);
            } else {
                return null;
            }

            return midnight(d);
        }

        if (s === 'just now' || s === 'τωρα') {
            return midnight(now);
        }

        let rel = s.match(
            /^(\d+)\s*(s|m|h|d|w)$/i
        );

        if (rel) {
            return subtractRelative(
                Number(rel[1]),
                rel[2]
            );
        }

        rel = s.match(
            /^(\d+)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|week|weeks)(?:\s+ago)?$/i
        );

        if (rel) {
            return subtractRelative(
                Number(rel[1]),
                rel[2]
            );
        }

        rel = s.match(
            /^(\d+)\s*(δ|δευτ|δευτερολεπτο|δευτερολεπτα|λ|λεπτ|λεπτο|λεπτα|ωρ|ωρα|ωρες|ημ|ημερα|ημερες|εβδ|εβδομαδα|εβδομαδες)$/i
        );

        if (rel) {
            return subtractRelative(
                Number(rel[1]),
                rel[2]
            );
        }

        rel = s.match(
            /^(?:πριν\s+απο\s+)?(\d+)\s*(δευτερολεπτα|λεπτα|ωρες|ημερες|εβδομαδες)(?:\s+πριν)?$/i
        );

        if (rel) {
            return subtractRelative(
                Number(rel[1]),
                rel[2]
            );
        }

        if (
            s === 'yesterday' ||
            s.startsWith('yesterday at ') ||
            s === 'χθες' ||
            s.startsWith('χθες στις ')
        ) {
            const d = new Date(now);
            d.setDate(d.getDate() - 1);
            return midnight(d);
        }

        // Numeric dd/mm/yyyy [time]
        let m = s.match(
            /(?:^|\s)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[,\s]+(?:στις|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(π\.?\s*μ\.?|μ\.?\s*μ\.?|am|pm)?)?/
        );
        if (m) {
            let year = Number(m[3]);
            if (year < 100) year += 2000;
            return makeLocalDate(
                year, Number(m[2]) - 1, Number(m[1]),
                Number(m[4] || 0), Number(m[5] || 0), m[6] || ''
            );
        }

        const monthKeys = Object.keys(MONTHS)
            .sort((a, b) => b.length - a.length)
            .join('|');

        // Greek/day-first: Wednesday 30 September 2026 at 10:44 AM
        m = s.match(
            new RegExp(
                '(?:^|\\s)(\\d{1,2})\\s+(' + monthKeys + ')' +
                '(?:,?\\s+(\\d{4}))?' +
                '(?:[^\\d]{0,20}(\\d{1,2})(?::(\\d{2}))?\\s*(π\\.?\\s*μ\\.?|μ\\.?\\s*μ\\.?|am|pm)?)?'
            )
        );
        if (m) {
            const month = MONTHS[m[2]];
            const day = Number(m[1]);
            const year = m[3] ? Number(m[3]) : inferYear(month, day);
            return makeLocalDate(
                year, month, day,
                Number(m[4] || 0), Number(m[5] || 0), m[6] || ''
            );
        }

        // English month-first: Wednesday, September 30, 2026 at 10:44 AM
        m = s.match(
            new RegExp(
                '(?:^|\\s)(' + monthKeys + ')\\s+(\\d{1,2})' +
                '(?:,?\\s+(\\d{4}))?' +
                '(?:[^\\d]{0,20}(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?'
            )
        );
        if (m) {
            const month = MONTHS[m[1]];
            const day = Number(m[2]);
            const year = m[3] ? Number(m[3]) : inferYear(month, day);
            return makeLocalDate(
                year, month, day,
                Number(m[4] || 0), Number(m[5] || 0), m[6] || ''
            );
        }

        return null;
    }

    function inferYear(month, day) {
        const now = new Date();
        let y = now.getFullYear();
        const candidate = new Date(y, month, day, 0, 0, 0);
        if (candidate.getTime() > now.getTime() + 36 * 3600 * 1000) y--;
        return y;
    }

    function makeLocalDate(year, month, day, hour, minute, ampm) {
        let h = Number(hour || 0);
        const ap = normalize(ampm).replace(/\s/g, '').replace(/\./g, '');

        if (ap === 'pm' || ap === 'μμ') {
            if (h < 12) h += 12;
        } else if (ap === 'am' || ap === 'πμ') {
            if (h === 12) h = 0;
        }

        const d = new Date(year, month, day, h, Number(minute || 0), 0);
        if (
            d.getFullYear() !== year ||
            d.getMonth() !== month ||
            d.getDate() !== day
        ) return null;
        return d;
    }

    function dispatchHover(el) {
        if (!el) return;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}

        const rect = el.getBoundingClientRect?.();
        const clientX = rect ? Math.round(rect.left + Math.max(1, rect.width) / 2) : 1;
        const clientY = rect ? Math.round(rect.top + Math.max(1, rect.height) / 2) : 1;
        const common = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY,
            screenX: clientX,
            screenY: clientY
        };

        try {
            for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
                el.dispatchEvent(new PointerEvent(type, {
                    ...common,
                    pointerId: 1,
                    pointerType: 'mouse',
                    isPrimary: true
                }));
            }
        } catch (_) {}

        for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
            try { el.dispatchEvent(new MouseEvent(type, common)); } catch (_) {}
        }
    }

    function dispatchUnhover(el) {
        if (!el) return;
        const common = { bubbles: true, cancelable: true, view: window };
        for (const type of ['mouseout', 'mouseleave']) {
            try { el.dispatchEvent(new MouseEvent(type, common)); } catch (_) {}
        }
    }

    function collectTooltipTexts() {
        const values = new Set();
        const selectors = [
            '[role="tooltip"]',
            '[data-visualcompletion="ignore-dynamic"] [aria-label]',
            '[aria-live="polite"]'
        ];

        for (const el of document.querySelectorAll(selectors.join(','))) {
            const rect = el.getBoundingClientRect?.();
            if (rect && rect.width === 0 && rect.height === 0) continue;

            for (const v of [
                el.getAttribute?.('aria-label'),
                el.getAttribute?.('title'),
                el.innerText,
                el.textContent
            ]) {
                const t = String(v || '').replace(/\u202f/g, ' ').trim();
                if (t && t.length <= 240 && looksLikeDateText(t)) values.add(t);
            }
        }

        return [...values];
    }

    async function getDateFromHover(timestampEl, timeoutMs = 600) {
        if (!timestampEl) {
            return { date: null, source: '', hoverDebug: [] };
        }

        const observed = new Set();
        const baseline = new Set(collectTooltipTexts());
        const existingTooltips = new Set(
            [...document.querySelectorAll('[role="tooltip"]')]
        );

        function addValue(value) {
            const t = String(value || '')
                .replace(/\u202f/g, ' ')
                .trim();

            if (
                t &&
                t.length <= 240 &&
                looksLikeDateText(t) &&
                !baseline.has(t)
            ) {
                observed.add(t);
            }
        }

        function collectFromElement(el) {
            if (!(el instanceof Element)) return;

            for (const v of [
                el.getAttribute?.('aria-label'),
                el.getAttribute?.('title'),
                el.innerText,
                el.textContent
            ]) {
                addValue(v);
            }
        }

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) continue;

                    const candidates = [];
                    if (
                        node.matches?.(
                            '[role="tooltip"], [data-visualcompletion="ignore-dynamic"], [aria-live="polite"]'
                        )
                    ) {
                        candidates.push(node);
                    }

                    candidates.push(...(
                        node.querySelectorAll?.(
                            '[role="tooltip"], [data-visualcompletion="ignore-dynamic"], [aria-live="polite"]'
                        ) || []
                    ));

                    for (const el of candidates) {
                        if (
                            el.matches?.('[role="tooltip"]') &&
                            existingTooltips.has(el)
                        ) {
                            continue;
                        }

                        collectFromElement(el);
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        function collectNewTooltipTexts() {
            for (const value of collectTooltipTexts()) {
                addValue(value);
            }
        }

        dispatchHover(timestampEl);

        const hoverStarted = Date.now();
        while (Date.now() - hoverStarted < timeoutMs) {
            collectNewTooltipTexts();

            if ([...observed].some(value => {
                const d = parseFbDate(value);
                return d && !isNaN(d);
            })) {
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 80));
            dispatchHover(timestampEl);
        }

        if (!observed.size && timestampEl.isConnected) {
            try {
                timestampEl.focus({ preventScroll: true });
            } catch (_) {
                try { timestampEl.focus(); } catch (_) {}
            }

            const focusStarted = Date.now();
            while (Date.now() - focusStarted < 250) {
                collectNewTooltipTexts();
                await new Promise(resolve => setTimeout(resolve, 80));
            }

            try { timestampEl.blur(); } catch (_) {}
        }

        observer.disconnect();
        dispatchUnhover(timestampEl);
        collectNewTooltipTexts();

        for (const candidate of observed) {
            const d = parseFbDate(candidate);
            if (d && !isNaN(d)) {
                return {
                    date: d,
                    source: 'main timestamp tooltip: ' + candidate,
                    hoverDebug: [...observed].slice(0, 8)
                };
            }
        }

        return {
            date: null,
            source: [...observed].slice(0, 5).join(' | '),
            hoverDebug: [...observed].slice(0, 8)
        };
    }

    async function extractDate(article) {
        const collected = collectMainTimestampCandidates(article);

        for (const candidate of collected.values) {
            const d = parseFbDate(candidate.value);

            if (d && !isNaN(d)) {
                return {
                    date: d,
                    source: `${candidate.source}: ${candidate.value}`
                };
            }
        }

        // Last resort: tooltip belonging only to the identified main timestamp.
        if (collected.timestampEl) {
            const hovered = await getDateFromHover(
                collected.timestampEl
            );

            if (hovered.date) {
                // If tooltip date has no useful time, parser already returns 00:00.
                return hovered;
            }
        }

        return {
            date: null,
            source:
                collected.values
                    .slice(0, 8)
                    .map(x => `${x.source}:${x.value}`)
                    .join(' | ') ||
                'main post timestamp unresolved'
        };
    }

    function wpLocalDateString(d) {
        const pad = n => String(n).padStart(2, '0');
        return (
            d.getFullYear() + '-' +
            pad(d.getMonth() + 1) + '-' +
            pad(d.getDate()) + 'T' +
            pad(d.getHours()) + ':' +
            pad(d.getMinutes()) + ':' +
            pad(d.getSeconds())
        );
    }

    function titleFromText(text, date) {
        let raw = String(text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/^[\s\n]+/, '');

        if (!raw.trim()) {
            const pad = n =>
                String(n).padStart(2, '0');

            return (
                `Facebook ${pad(date.getDate())}/` +
                `${pad(date.getMonth() + 1)}/` +
                `${date.getFullYear()}`
            );
        }

        /*
         * WordPress title:
         * whichever ends first:
         *   - the first line
         *   - the first sentence
         *
         * Sentence terminators:
         * .  !  ;  Greek question mark (;)  ?
         *
         * The terminal punctuation itself is not included.
         */

        const newlineIndex =
            raw.indexOf('\n');

        const sentenceMatch =
            /[.!;;?](?=\s|$)/.exec(raw);

        const sentenceIndex =
            sentenceMatch
                ? sentenceMatch.index
                : -1;

        let endIndex = raw.length;

        if (
            newlineIndex >= 0 &&
            newlineIndex < endIndex
        ) {
            endIndex = newlineIndex;
        }

        if (
            sentenceIndex >= 0 &&
            sentenceIndex < endIndex
        ) {
            endIndex = sentenceIndex;
        }

        let title = raw
            .slice(0, endIndex)
            .replace(/\s+/g, ' ')
            .replace(/[.!;;?]+$/g, '')
            .trim();

        /*
         * Defensive fallback for a first blank/URL-only line.
         */
        if (!title) {
            const firstNonEmpty = raw
                .split('\n')
                .map(line =>
                    line
                        .replace(/\s+/g, ' ')
                        .trim()
                )
                .find(Boolean);

            title = (
                firstNonEmpty || raw
            )
                .replace(/[.!;;?]+$/g, '')
                .trim();
        }

        return title;
    }

    async function scan() {
        const imported = getImported();

        document.querySelectorAll('[data-fbwp]').forEach(el => {
            el.style.outline = '';
            delete el.dataset.fbwp;
        });

        const containers = getPostContainers().filter(isTargetPost);
        scannedPosts = [];

        for (let index = 0; index < containers.length; index++) {
            const article = containers[index];
            status(`Διαβάζω ημερομηνίες ${index + 1}/${containers.length}...`);

            const expandInfo = await expandArticleBeforeCollect(article);

            if (expandInfo.found) {
                status(
                    `Post ${index + 1}/${containers.length}: ` +
                    `See more ${expandInfo.opened}/${expandInfo.found} | ` +
                    `archive ${map.size}`
                );
            }

            const permalink = getPermalink(article);
            const textValue = extractText(article);
            const images = extractImages(article);

            const timestampDebug = await waitForTimestampCandidates(
                article,
                1600
            );

            let dateInfo = {
                date: null,
                source: 'main post timestamp unresolved'
            };

            for (const candidate of timestampDebug.values) {
                const parsed = parseFbDate(candidate.value);

                if (parsed && !isNaN(parsed)) {
                    dateInfo = {
                        date: parsed,
                        source: `${candidate.source}: ${candidate.value}`
                    };
                    break;
                }
            }

            if (!dateInfo.date && timestampDebug.timestampEl) {
                const hovered = await getDateFromHover(
                    timestampDebug.timestampEl
                );

                if (hovered.date) {
                    dateInfo = hovered;
                }
            }
            const id = makeStablePostId(permalink, textValue, dateInfo.date);

            const item = {
                index,
                article,
                permalink,
                id,
                text: textValue,
                images,
                date: dateInfo.date,
                dateSource: dateInfo.source,
                imported: imported.has(id)
            };

            article.style.outline = dateInfo.date
                ? '3px solid #35a853'
                : '3px solid #d93025';
            article.dataset.fbwp = dateInfo.date ? 'ok' : 'bad-date';
            scannedPosts.push(item);
        }

        const ok = scannedPosts.filter(p => p.date && !p.imported);
        const already = scannedPosts.filter(p => p.imported);
        const bad = scannedPosts.filter(p => !p.date);

        console.table(scannedPosts.map(p => ({
            id: p.id,
            date: p.date ? wpLocalDateString(p.date) : 'MISSING',
            chars: p.text.length,
            images: p.images.length,
            imported: p.imported,
            url: p.permalink || '(synthetic id)',
            dateSource: p.dateSource
        })));

        status(
            `Scan: ${ok.length} έτοιμα | ${already.length} ήδη imported | ` +
            `${bad.length} χωρίς ασφαλή ημερομηνία`
        );

        if (bad.length) {
            log('Posts skipped because exact main-post date was not found:', bad);
        }

        return scannedPosts;
    }

    function getMainSeeMoreButtons() {
        const out = [];

        const stories = [...document.querySelectorAll(
            '[data-ad-rendering-role="story_message"]'
        )].filter(story => !isInsideComment(story));

        for (const story of stories) {
            for (const el of story.querySelectorAll('[role="button"], button')) {
                const t = normalize(el.innerText || el.textContent);

                if (
                    t === 'see more' ||
                    t === 'δειτε περισσοτερα' ||
                    t === 'περισσοτερα'
                ) {
                    out.push(el);
                }
            }
        }

        return out.sort((a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top
        );
    }

    async function clickOneSeeMore(button) {
        if (!button || !button.isConnected) return false;

        try {
            button.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch (_) {}

        await new Promise(resolve => setTimeout(resolve, 120));

        // First use the browser's native HTMLElement click implementation.
        try {
            HTMLElement.prototype.click.call(button);
        } catch (_) {
            try { button.click(); } catch (_) {}
        }

        await new Promise(resolve => setTimeout(resolve, 320));

        // Success if this exact control disappeared or its label changed.
        if (!button.isConnected) return true;

        const after = normalize(button.innerText || button.textContent);
        if (
            after !== 'see more' &&
            after !== 'δειτε περισσοτερα' &&
            after !== 'περισσοτερα'
        ) {
            return true;
        }

        // Facebook fallback: pointer/mouse sequence + Enter.
        const common = { bubbles: true, cancelable: true, view: window };

        try {
            button.dispatchEvent(new PointerEvent('pointerdown', {
                ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true
            }));
            button.dispatchEvent(new MouseEvent('mousedown', common));
            button.dispatchEvent(new MouseEvent('mouseup', common));
            button.dispatchEvent(new MouseEvent('click', common));
            button.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
            }));
            button.dispatchEvent(new KeyboardEvent('keyup', {
                bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'
            }));
        } catch (_) {}

        await new Promise(resolve => setTimeout(resolve, 450));

        return !button.isConnected ||
            !['see more', 'δειτε περισσοτερα', 'περισσοτερα']
                .includes(normalize(button.innerText || button.textContent));
    }

    async function expandStoryMessages() {
        const initial = getMainSeeMoreButtons().length;
        let clicked = 0;
        let failed = 0;

        // Re-query after every click. Facebook often replaces the whole story subtree.
        for (let attempt = 0; attempt < 250; attempt++) {
            const buttons = getMainSeeMoreButtons()
                .filter(el => el.dataset.fbwpSeeMoreFailed !== '1');

            if (!buttons.length) break;

            const button = buttons[0];
            const ok = await clickOneSeeMore(button);

            if (ok) {
                clicked++;
            } else {
                failed++;
                if (button.isConnected) {
                    button.dataset.fbwpSeeMoreFailed = '1';
                }
            }

            await new Promise(resolve => setTimeout(resolve, 120));
        }

        const remaining = getMainSeeMoreButtons().length;

        return {
            initial,
            clicked,
            failed,
            remaining
        };
    }

    async function expandAndScan() {
        status('Ανοίγω όλα τα "See more" στα κύρια posts...');

        const expand = await expandStoryMessages();

        status(
            `See more: βρέθηκαν ${expand.initial}, άνοιξαν ${expand.clicked}, ` +
            `έμειναν ${expand.remaining}. Διαβάζω ημερομηνίες...`,
            expand.remaining > 0
        );

        await new Promise(resolve => setTimeout(resolve, 500));
        await scan();

        const base = document.getElementById('fbwp-status')?.textContent || '';
        status(
            `${base} | See more: ${expand.clicked}/${expand.initial} άνοιξαν, ` +
            `${expand.remaining} έμειναν`,
            expand.remaining > 0
        );

        log('See more stats:', expand);
    }


    function findSeeMoreInArticle(article) {
        const story = article.querySelector(
            '[data-ad-rendering-role="story_message"]'
        );

        if (!story) return null;

        return [
            ...story.querySelectorAll(
                '[role="button"], button, a[role="button"]'
            )
        ].find(el => {
            const t = normalize(
                el.innerText ||
                el.textContent ||
                el.getAttribute?.('aria-label')
            );

            return (
                t === 'see more' ||
                t === 'δειτε περισσοτερα' ||
                t === 'περισσοτερα'
            );
        }) || null;
    }

    async function expandArticleBeforeCollect(article) {
        if (!article?.isConnected) {
            return { found: 0, opened: 0, failed: 0 };
        }

        let found = 0;
        let opened = 0;
        let failed = 0;

        for (let attempt = 0; attempt < 4; attempt++) {
            const button = findSeeMoreInArticle(article);
            if (!button) break;

            found++;
            const ok = await clickOneSeeMore(button);

            if (ok) {
                opened++;
                await new Promise(resolve => setTimeout(resolve, 120));
                continue;
            }

            failed++;
            if (button.isConnected) {
                button.dataset.fbwpSeeMoreFailed = '1';
            }
            break;
        }

        return { found, opened, failed };
    }


    async function waitForTimestampCandidates(article, timeoutMs = 400) {
        const started = Date.now();
        let last = { values: [], timestampEl: null };

        try {
            article.scrollIntoView({
                block: 'center',
                inline: 'nearest'
            });
        } catch (_) {}

        // Keep pass 1 quick. Misses are retried by pass 2.
        await new Promise(resolve => setTimeout(resolve, 80));

        while (Date.now() - started < timeoutMs) {
            last = collectMainTimestampCandidates(article);

            if (last.values.length) {
                return last;
            }

            await new Promise(resolve => setTimeout(resolve, 80));
        }

        return last;
    }

    function collectTimestampDomDiagnostics(article) {
        if (!article) return null;

        const profile = article.querySelector('[data-ad-rendering-role="profile_name"]');
        const story = article.querySelector('[data-ad-rendering-role="story_message"]');
        let headerScope = profile || article;

        if (profile) {
            let current = profile;
            while (current.parentElement && current.parentElement !== article) {
                const parent = current.parentElement;
                if (story && parent.contains(story)) break;
                headerScope = parent;
                current = parent;
            }
        }

        function describe(el) {
            if (!el || el.nodeType !== 1) return null;
            return {
                tag: el.tagName,
                text: String(el.innerText || el.textContent || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 240),
                href: el.getAttribute('href'),
                role: el.getAttribute('role'),
                ariaLabel: el.getAttribute('aria-label'),
                ariaLabelledby: el.getAttribute('aria-labelledby'),
                title: el.getAttribute('title'),
                target: el.getAttribute('target'),
                dataUtime: el.getAttribute('data-utime'),
                datetime: el.getAttribute('datetime'),
                dataAdRenderingRole: el.getAttribute('data-ad-rendering-role'),
                className: String(el.getAttribute('class') || '').slice(0, 320)
            };
        }

        const selector = [
            'a', 'time', 'abbr', '[role="link"]', '[role="button"]',
            '[aria-label]', '[aria-labelledby]', '[title]', '[data-utime]', '[datetime]'
        ].join(',');

        const elements = [];
        const seen = new Set();
        for (const el of headerScope.querySelectorAll(selector)) {
            if (elements.length >= 120) break;
            if (seen.has(el)) continue;
            seen.add(el);
            const item = describe(el);
            if (item) elements.push(item);
        }

        const profileAncestors = [];
        let current = profile;
        let depth = 0;
        while (current && depth < 8) {
            const item = describe(current);
            if (item) profileAncestors.push(item);
            if (current === article) break;
            current = current.parentElement;
            depth++;
        }

        return {
            headerScope: describe(headerScope),
            profile: describe(profile),
            profileAncestors,
            elements
        };
    }

    async function collectVisiblePosts(cutoffDate) {
        const archive = loadArchiveRaw();

        /*
         * Normalize the previously stored archive first.
         * This also repairs legacy entries whose keys contained __cft__[0].
         */
        const map = new Map();
        const fingerprintToKey = new Map();
        const sourceIdToKey = new Map();

        for (const legacyRaw of archive) {
            const legacy = mergeArchiveItems(
                {},
                legacyRaw
            );

            const fp =
                archiveItemFingerprint(legacy);

            const textFp =
                legacy.textFingerprint ||
                makeTextFingerprint(legacy.text);

            const sourceId =
                extractPostId(legacy.permalink || '') ||
                (
                    legacy.id &&
                    !String(legacy.id).startsWith('fp-')
                        ? String(legacy.id)
                        : ''
                );

            let existingKey = null;

            /*
             * Identity rule:
             * - Real Facebook source ID wins.
             * - Otherwise use exact archive key / full fingerprint.
             * - NEVER merge by textFingerprint.
             */
            if (
                sourceId &&
                sourceIdToKey.has(sourceId)
            ) {
                existingKey =
                    sourceIdToKey.get(sourceId);
            } else if (
                map.has(
                    archiveItemKey(legacy)
                )
            ) {
                existingKey =
                    archiveItemKey(legacy);
            } else if (
                !sourceId &&
                fp &&
                fingerprintToKey.has(fp)
            ) {
                existingKey =
                    fingerprintToKey.get(fp);
            }

            if (existingKey) {
                const merged =
                    mergeArchiveItems(
                        map.get(existingKey),
                        legacy
                    );

                const newKey =
                    archiveItemKey(merged);

                if (newKey !== existingKey) {
                    map.delete(existingKey);
                }

                map.set(newKey, merged);

                fingerprintToKey.set(
                    merged.fingerprint,
                    newKey
                );

                const mergedSourceId =
                    extractPostId(merged.permalink || '') ||
                    (
                        merged.id &&
                        !String(merged.id).startsWith('fp-')
                            ? String(merged.id)
                            : ''
                    );

                if (mergedSourceId) {
                    sourceIdToKey.set(
                        mergedSourceId,
                        newKey
                    );
                }
            } else {
                const key =
                    archiveItemKey(legacy);

                map.set(key, legacy);

                if (fp) {
                    fingerprintToKey.set(
                        fp,
                        key
                    );
                }

                if (sourceId) {
                    sourceIdToKey.set(
                        sourceId,
                        key
                    );
                }
            }
        }

        /*
         * Save normalized/migrated archive immediately.
         * This can only reduce duplicates / canonicalize keys.
         */
        saveArchiveRaw([...map.values()]);

        const imported = getImported();
        const containers = getPostContainers().filter(isTargetPost);

        let newCount = 0;
        let updatedCount = 0;
        let unresolvedCount = 0;
        let olderCount = 0;
        let oldestDate = null;
        let reachedCutoff = false;

        for (let index = 0; index < containers.length; index++) {
            if (collectorStopRequested) break;

            const article = containers[index];

            status(
                `Post ${index + 1}/${containers.length}: ` +
                `See more → timestamp → collect | archive ${map.size}`
            );

            /* Capture the structural timestamp before See more can replace the React subtree. */
  const timestampBeforeExpand = await waitForTimestampCandidates(
      article,
      400
  );

  let dateBeforeExpand = {
      date: null,
      source: 'main post timestamp unresolved'
  };

  for (const candidate of timestampBeforeExpand.values || []) {
      const parsed = parseFbDate(candidate.value);

      if (parsed && !isNaN(parsed)) {
          dateBeforeExpand = {
              date: parsed,
              source: `${candidate.source}: ${candidate.value}`
          };
          break;
      }
  }

  const expandInfo = await expandArticleBeforeCollect(article);

            if (expandInfo.found) {
                status(
                    `Post ${index + 1}/${containers.length}: ` +
                    `See more ${expandInfo.opened}/${expandInfo.found} | ` +
                    `archive ${map.size}`
                );
            }

            const permalink = getPermalink(article);
            const textValue = extractText(article);
            const images = extractImages(article);

            const timestampDebug = await waitForTimestampCandidates(
                article,
                400
            );

            let dateInfo = {
                date: null,
                source: 'main post timestamp unresolved'
            };

            for (const candidate of timestampDebug.values) {
                const parsed = parseFbDate(candidate.value);

                if (parsed && !isNaN(parsed)) {
                    dateInfo = {
                        date: parsed,
                        source: `${candidate.source}: ${candidate.value}`
                    };
                    break;
                }
            }

            if (!dateInfo.date && dateBeforeExpand.date) {
      dateInfo = dateBeforeExpand;
  }

  const dateValue = dateInfo.date;
            const id = makeStablePostId(permalink, textValue, dateValue, images);

            const fingerprint = makePostFingerprint(
                textValue,
                dateValue,
                images
            );

            const runtime = {
                id,
                permalink,
                text: textValue,
                images,
                date: dateValue,
                fingerprint
            };

            const archiveKey = archiveItemKey(runtime);

            if (dateValue && !isNaN(dateValue)) {
                const day = startOfDay(dateValue);

                if (!oldestDate || day < oldestDate) {
                    oldestDate = day;
                }

                if (day < cutoffDate) {
                    reachedCutoff = true;
                    olderCount++;

                    article.style.outline = '2px solid #777';
                    article.dataset.fbwp = 'older-than-cutoff';

                    /*
                     * HARD STOP:
                     * The Facebook feed can already have many older posts mounted.
                     * Do not finish the current batch once the first dated post
                     * older than the requested cutoff is encountered.
                     */
                    status(
                        `Cutoff reached: ${formatDateOnly(cutoffDate)}. ` +
                        `Ολοκληρώνω τη συλλογή.`,
                        'ok'
                    );

                    break;
                }
            } else {
                unresolvedCount++;
            }

            const snapshot = {
                archiveKey,
                fingerprint,
                textFingerprint: makeTextFingerprint(textValue),
                id,
                permalink,
                text: textValue,
                images,
                dateIso: dateValue && !isNaN(dateValue)
                    ? dateValue.toISOString()
                    : null,
                dateSource: dateInfo.source || '',
                dateDebug: {
                    candidates: [
                        ...(timestampBeforeExpand.values || []),
                        ...(timestampDebug.values || [])
                    ].map(x => ({
                        source: x.source,
                        value: x.value
                    })),
                    hasTimestampElement: Boolean(
                        timestampBeforeExpand.timestampEl ||
                        timestampDebug.timestampEl
                    ),
                    beforeExpand: {
                        candidates: (timestampBeforeExpand.values || []).map(x => ({
                            source: x.source,
                            value: x.value
                        })),
                        hasTimestampElement: Boolean(timestampBeforeExpand.timestampEl)
                    },
                    afterExpand: {
                        candidates: (timestampDebug.values || []).map(x => ({
                            source: x.source,
                            value: x.value
                        })),
                        hasTimestampElement: Boolean(timestampDebug.timestampEl)
                    },
                    dom: dateValue ? null : collectTimestampDomDiagnostics(article)
                },
                collectedAt: new Date().toISOString(),
                imported: imported.has(id)
            };

            const sourceId =
                extractPostId(permalink || '') ||
                (
                    id &&
                    !String(id).startsWith('fp-')
                        ? String(id)
                        : ''
                );

            const textFingerprint =
                snapshot.textFingerprint;

            let existingKey = null;

            if (
                sourceId &&
                sourceIdToKey.has(sourceId)
            ) {
                existingKey =
                    sourceIdToKey.get(sourceId);
            } else if (
                map.has(archiveKey)
            ) {
                existingKey =
                    archiveKey;
            } else if (
                !sourceId &&
                fingerprint &&
                fingerprintToKey.has(fingerprint)
            ) {
                existingKey =
                    fingerprintToKey.get(fingerprint);
            }

            const existing = existingKey
                ? map.get(existingKey)
                : null;

            if (!existing) {
                const cleanSnapshot =
                    mergeArchiveItems({}, snapshot);

                const newKey =
                    archiveItemKey(cleanSnapshot);

                map.set(newKey, cleanSnapshot);

                fingerprintToKey.set(
                    cleanSnapshot.fingerprint,
                    newKey
                );

                const newSourceId =
                    extractPostId(
                        cleanSnapshot.permalink || ''
                    );

                if (newSourceId) {
                    sourceIdToKey.set(
                        newSourceId,
                        newKey
                    );
                }

                newCount++;
            } else {
                const merged =
                    mergeArchiveItems(
                        existing,
                        snapshot
                    );

                const newKey =
                    archiveItemKey(merged);

                if (
                    existingKey &&
                    existingKey !== newKey
                ) {
                    map.delete(existingKey);
                }

                map.set(newKey, merged);

                fingerprintToKey.set(
                    merged.fingerprint,
                    newKey
                );

                const mergedSourceId =
                    extractPostId(
                        merged.permalink || ''
                    ) ||
                    (
                        merged.id &&
                        !String(merged.id)
                            .startsWith('fp-')
                            ? String(merged.id)
                            : ''
                    );

                if (mergedSourceId) {
                    sourceIdToKey.set(
                        mergedSourceId,
                        newKey
                    );
                }

                updatedCount++;
            }

            /*
             * Persist after every processed post so Facebook can safely
             * virtualize/remove older DOM nodes while we keep scrolling.
             */
            saveArchiveRaw([...map.values()]);

            article.style.outline = dateValue
                ? '2px solid #35a853'
                : '2px solid #d99b25';
            article.dataset.fbwp = dateValue ? 'collected' : 'collected-no-date';
        }

        /*
         * PASS 2:
         * Retry only entries that are still unresolved and still mounted.
         * Already-dated items are never touched and no duplicate is created.
         */
        let secondPassRecovered = 0;

        const unresolvedKeys = new Set(
            [...map.entries()]
                .filter(([, item]) => !item.dateIso)
                .map(([key]) => key)
        );

        if (unresolvedKeys.size) {
            status(
                `Pass 2: retrying ${unresolvedKeys.size} unresolved post(s)...`
            );

            const retryContainers =
                getPostContainers().filter(isTargetPost);

            for (
                let retryIndex = 0;
                retryIndex < retryContainers.length;
                retryIndex++
            ) {
                if (collectorStopRequested || !unresolvedKeys.size) break;

                const article = retryContainers[retryIndex];
                const permalink = getPermalink(article);
                const sourceId = extractPostId(permalink || '');

                let existingKey = null;

                if (
                    sourceId &&
                    sourceIdToKey.has(sourceId)
                ) {
                    existingKey = sourceIdToKey.get(sourceId);
                } else {
                    const candidateKey = archiveItemKey({ permalink });
                    if (candidateKey && map.has(candidateKey)) {
                        existingKey = candidateKey;
                    }
                }

                if (
                    !existingKey ||
                    !unresolvedKeys.has(existingKey)
                ) {
                    continue;
                }

                const existing = map.get(existingKey);
                if (!existing || existing.dateIso) {
                    unresolvedKeys.delete(existingKey);
                    continue;
                }

                const retryTimestamp =
                    await waitForTimestampCandidates(article, 800);

                let retryDateInfo = {
                    date: null,
                    source: 'main post timestamp unresolved',
                    hoverDebug: []
                };

                for (const candidate of retryTimestamp.values || []) {
                    const parsed = parseFbDate(candidate.value);
                    if (parsed && !isNaN(parsed)) {
                        retryDateInfo = {
                            date: parsed,
                            source: `${candidate.source}: ${candidate.value}`,
                            hoverDebug: []
                        };
                        break;
                    }
                }

                if (
                    !retryDateInfo.date &&
                    retryTimestamp.timestampEl &&
                    retryTimestamp.timestampEl.isConnected
                ) {
                    const hovered = await getDateFromHover(
                        retryTimestamp.timestampEl,
                        600
                    );
                    if (hovered.date) {
                        retryDateInfo = hovered;
                    }
                }

                if (!retryDateInfo.date) {
                    continue;
                }

                const retrySnapshot = {
                    ...existing,
                    dateIso: retryDateInfo.date.toISOString(),
                    dateSource: retryDateInfo.source || '',
                    dateDebug: {
                        ...(existing.dateDebug || {}),
                        retryPass: {
                            candidates: (retryTimestamp.values || []).map(x => ({
                                source: x.source,
                                value: x.value
                            })),
                            hasTimestampElement: Boolean(
                                retryTimestamp.timestampEl
                            ),
                            hoverDebug: retryDateInfo.hoverDebug || []
                        }
                    }
                };

                const merged = mergeArchiveItems(
                    existing,
                    retrySnapshot
                );
                const newKey = archiveItemKey(merged);

                if (newKey !== existingKey) {
                    map.delete(existingKey);
                }
                map.set(newKey, merged);
                fingerprintToKey.set(merged.fingerprint, newKey);

                const mergedSourceId =
                    extractPostId(merged.permalink || '') ||
                    (
                        merged.id &&
                        !String(merged.id).startsWith('fp-')
                            ? String(merged.id)
                            : ''
                    );

                if (mergedSourceId) {
                    sourceIdToKey.set(mergedSourceId, newKey);
                }

                unresolvedKeys.delete(existingKey);
                secondPassRecovered++;
                updatedCount++;

                saveArchiveRaw([...map.values()]);

                article.style.outline = '2px solid #35a853';
                article.dataset.fbwp = 'collected-pass2';
            }

            log(
                `Pass 2 recovered ${secondPassRecovered} unresolved post(s).`
            );
        }

        const repairedExactText =
            repairUnresolvedExactTextDuplicates(
                map
            );

        if (repairedExactText) {
            log(
                `Exact-text repair: ${repairedExactText} unresolved duplicate snapshot(s) merged.`
            );
        }

        /*
         * Persist the repaired archive once more before returning.
         */
        saveArchiveRaw(
            [...map.values()]
        );

        const actualUnresolved =
            [...map.values()]
                .filter(item => !item.dateIso)
                .length;

        return {
            totalArchive: map.size,
            newCount,
            updatedCount,
            unresolvedCount: actualUnresolved,
            secondPassRecovered,
            repairedExactText,
            olderCount,
            oldestDate,
            reachedCutoff
        };
    }

    function waitForFeedChange(previousBottom, previousCount, timeoutMs = 3500) {
        return new Promise(resolve => {
            const started = Date.now();

            const timer = setInterval(() => {
                const bottom = document.documentElement.scrollHeight;
                const count = getPostContainers().length;

                if (
                    bottom > previousBottom + 200 ||
                    count !== previousCount ||
                    Date.now() - started >= timeoutMs
                ) {
                    clearInterval(timer);
                    resolve({
                        bottom,
                        count,
                        changed:
                            bottom > previousBottom + 200 ||
                            count !== previousCount
                    });
                }
            }, 200);
        });
    }

    async function scrollForMorePosts() {
        const previousBottom = document.documentElement.scrollHeight;
        const previousCount = getPostContainers().length;

        window.scrollTo({
            top: document.documentElement.scrollHeight,
            behavior: 'smooth'
        });

        await new Promise(resolve => setTimeout(resolve, 700));

        return waitForFeedChange(
            previousBottom,
            previousCount,
            4000
        );
    }

    async function collectToDate() {
        if (busy) return;

        const input = document.getElementById('fbwp-cutoff');
        const cutoffDate = parseCutoffInput(input?.value);

        if (!cutoffDate) {
            alert('Βάλε ημερομηνία σε μορφή ΗΗ/ΜΜ/ΕΕΕΕ, π.χ. 01/01/2026.');
            return;
        }

        const cutoffValue =
            input.value.trim();

        GM_setValue(
            CFG.cutoffStorageKey,
            cutoffValue
        );

        if (!confirm(
            `Θα συλλέξω posts μέχρι και ${formatDateOnly(cutoffDate)}.\n\n` +
            `Κάθε post αποθηκεύεται τοπικά αμέσως μόλις φορτωθεί.\n` +
            `Posts παλαιότερα από το όριο δεν θα προστεθούν.\n\n` +
            `Συνέχεια;`
        )) {
            return;
        }

        busy = true;
        collectorStopRequested = false;

        let cycles = 0;
        let stagnantCycles = 0;
        let totalNewThisRun = 0;
        let lastArchiveCount = loadArchiveRaw().length;
        let stopReason = '';

        try {
            while (!collectorStopRequested && cycles < 500) {
                cycles++;

                status(
                    `Cycle ${cycles}: συλλογή φορτωμένων posts...`
                );

                const result = await collectVisiblePosts(cutoffDate);
                totalNewThisRun += result.newCount;

                const currentCount = loadArchiveRaw().length;

                if (currentCount > lastArchiveCount) {
                    stagnantCycles = 0;
                } else {
                    stagnantCycles++;
                }

                lastArchiveCount = currentCount;

                if (result.reachedCutoff) {
                    stopReason =
                        `Ολοκληρώθηκε στο όριο ` +
                        `${formatDateOnly(cutoffDate)}.`;
                    break;
                }

                if (collectorStopRequested) {
                    stopReason = 'Σταμάτησε από τον χρήστη.';
                    break;
                }

                if (stagnantCycles >= 6) {
                    stopReason =
                        'Δεν φορτώθηκαν νέα posts για 6 κύκλους.';
                    break;
                }

                status(
                    `Collected ${currentCount}. ` +
                    `Oldest loaded: ${formatDateOnly(result.oldestDate)}. ` +
                    `Scrolling...`
                );

                const feed = await scrollForMorePosts();

                if (!feed.changed) {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }

            if (!stopReason && collectorStopRequested) {
                stopReason = 'Σταμάτησε από τον χρήστη.';
            }

            if (!stopReason && cycles >= 500) {
                stopReason = 'Έφτασε το εσωτερικό όριο 500 κύκλων.';
            }

            const archive = loadArchiveRaw();
            const unresolved = archive.filter(x => !x.dateIso).length;
            const dated = archive.length - unresolved;

            status(
                `DONE. Collected: ${archive.length} ` +
                `(${dated} dated, ${unresolved} unresolved). ` +
                `New this run: ${totalNewThisRun}. ${stopReason}`,
                unresolved > 0 ? 'warn' : 'ok'
            );

            console.table(
                archive.map(item => ({
                    date: item.dateIso
                        ? wpLocalDateString(new Date(item.dateIso))
                        : 'MISSING',
                    chars: (item.text || '').length,
                    images: (item.images || []).length,
                    url: item.permalink,
                    source: item.dateSource
                }))
            );
        } catch (e) {
            console.error('[FB→WP] Collector failed:', e);
            status(e.message || String(e), true);
            alert('Collector: ' + (e.message || e));
        } finally {
            busy = false;
            collectorStopRequested = false;
            updateArchiveUi();
        }
    }

    function stopCollector() {
        collectorStopRequested = true;
        status('STOP requested — ολοκληρώνω το τρέχον post...');
    }


    function getCredentials() {
        if (credentials) return credentials;

        const site = prompt(
            'WordPress site URL (π.χ. https://example.com):',
            CFG.wpBase || ''
        );
        if (!site) throw new Error('Ακυρώθηκε: λείπει WordPress site URL.');

        const wpBase = String(site).trim().replace(/\/+$/, '');

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
            pass: pass.replace(/\s+/g, '')
        };
        return credentials;
    }

    async function wpJson(method, path, body = null) {
        const c = getCredentials();
        const headers = {
            'Authorization': basicAuth(c.user, c.pass),
            'Accept': 'application/json'
        };
        if (body !== null) headers['Content-Type'] = 'application/json';

        const res = await gmRequest({
            method,
            url: c.wpBase + path,
            headers,
            data: body !== null ? JSON.stringify(body) : undefined
        });

        let json = null;
        try {
            json = JSON.parse(res.responseText || '{}');
        } catch (_) {}

        if (res.status < 200 || res.status >= 300) {
            throw new Error(
                `WordPress HTTP ${res.status}: ` +
                (json?.message || res.responseText || 'Unknown error')
            );
        }
        return json;
    }

    async function findTargetCategoryId() {
        const cats = await wpJson('GET', '/wp-json/wp/v2/categories?per_page=100&context=edit');
        const targetN = normalize(CFG.targetCategoryName);

        let found = cats.find(c => normalize(c.name) === targetN);
        if (!found) {
            found = cats.find(c =>
                normalize(c.name).includes('δελτια τυπου') &&
                normalize(c.name).includes('ανακοινω')
            );
        }

        if (!found) {
            throw new Error(
                `Δεν βρήκα την κατηγορία "${CFG.targetCategoryName}". ` +
                'Δεν έγινε import.'
            );
        }

        return found.id;
    }

    function extractHashtags(text) {
        const raw = String(text || '');
        const found = [];
        const seen = new Set();

        /*
         * Facebook-style hashtags:
         * letters, numbers and underscore.
         * Unicode-aware so Greek hashtags work correctly.
         */
        const re = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu;

        let match;

        while ((match = re.exec(raw)) !== null) {
            const tag = (match[2] || '').trim();

            if (!tag) continue;

            const key = normalize(tag);

            if (!key || seen.has(key)) {
                continue;
            }

            seen.add(key);
            found.push(tag);
        }

        return found;
    }

    async function findOrCreateWpTag(name) {
        const wanted =
            String(name || '').trim();

        if (!wanted) return null;

        const wantedN =
            normalize(wanted);

        /*
         * Search first so existing WP tags are reused.
         */
        const found = await wpJson(
            'GET',
            `/wp-json/wp/v2/tags?context=edit&per_page=100&` +
            `search=${encodeURIComponent(wanted)}`
        );

        if (Array.isArray(found)) {
            const exact = found.find(tag =>
                normalize(tag?.name) === wantedN
            );

            if (exact?.id) {
                return exact.id;
            }
        }

        try {
            const created = await wpJson(
                'POST',
                '/wp-json/wp/v2/tags',
                {
                    name: wanted
                }
            );

            return created?.id || null;
        } catch (e) {
            /*
             * If WordPress reports that the term already exists
             * (e.g. race/slug collision), search once more and reuse it.
             */
            log(
                `Tag create fallback for #${wanted}:`,
                e
            );

            const retry = await wpJson(
                'GET',
                `/wp-json/wp/v2/tags?context=edit&per_page=100&` +
                `search=${encodeURIComponent(wanted)}`
            );

            if (Array.isArray(retry)) {
                const exact = retry.find(tag =>
                    normalize(tag?.name) === wantedN
                );

                if (exact?.id) {
                    return exact.id;
                }
            }

            throw e;
        }
    }

    async function resolveWpTagIds(text) {
        const hashtags =
            extractHashtags(text);

        const ids = [];

        for (const tag of hashtags) {
            const id =
                await findOrCreateWpTag(tag);

            if (id && !ids.includes(id)) {
                ids.push(id);
            }
        }

        return {
            hashtags,
            ids
        };
    }

    function wpSlugForItem(item) {
        const raw = String(
            item?.id ||
            item?.fingerprint ||
            archiveItemFingerprint(item)
        )
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 160);

        return `facebook-${raw || stableHash(JSON.stringify(item || {}))}`;
    }

    async function wpAlreadyHas(item) {
        const slug = wpSlugForItem(item);
        const statuses = encodeURIComponent(
            'publish,draft,pending,private,future'
        );

        /*
         * Primary duplicate guard: deterministic WordPress slug.
         * This works even when Facebook exposes no source permalink.
         */
        try {
            const bySlug = await wpJson(
                'GET',
                `/wp-json/wp/v2/posts?context=edit&per_page=10&` +
                `status=${statuses}&slug=${encodeURIComponent(slug)}`
            );

            if (Array.isArray(bySlug) && bySlug.length) {
                return true;
            }
        } catch (e) {
            log('Slug duplicate lookup failed, using marker fallback:', e);
        }

        // Secondary guard for posts imported by an older script version.
        const marker = `FB_IMPORT_ID:${item.id}`;
        const q = encodeURIComponent(marker);

        try {
            const posts = await wpJson(
                'GET',
                `/wp-json/wp/v2/posts?context=edit&per_page=20&` +
                `status=${statuses}&search=${q}`
            );

            return posts.some(p => {
                const raw = p?.content?.raw || '';
                return raw.includes(marker);
            });
        } catch (e) {
            log('Marker duplicate lookup failed:', e);
            return false;
        }
    }

    function extForType(contentType, url) {
        const ct = (contentType || '').toLowerCase();
        if (ct.includes('png')) return 'png';
        if (ct.includes('webp')) return 'webp';
        if (ct.includes('gif')) return 'gif';
        if (ct.includes('avif')) return 'avif';
        if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';

        try {
            const p = new URL(url).pathname;
            const m = p.match(/\.(jpe?g|png|webp|gif|avif)$/i);
            if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
        } catch (_) {}

        return 'jpg';
    }

    async function uploadImage(img, item, seq) {
        const download = await gmRequest({
            method: 'GET',
            url: img.url,
            responseType: 'arraybuffer',
            headers: {
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        });

        if (download.status < 200 || download.status >= 300) {
            throw new Error(`Facebook image download HTTP ${download.status}`);
        }

        const contentType =
            (download.responseHeaders.match(/content-type:\s*([^\r\n]+)/i) || [])[1]
            || 'image/jpeg';

        const ext = extForType(contentType, img.url);
        const filename = `facebook-${item.id}-${String(seq).padStart(2, '0')}.${ext}`;

        const c = getCredentials();
        const upload = await gmRequest({
            method: 'POST',
            url: c.wpBase + '/wp-json/wp/v2/media',
            headers: {
                'Authorization': basicAuth(c.user, c.pass),
                'Content-Type': contentType.split(';')[0].trim(),
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Accept': 'application/json'
            },
            data: download.response,
            binary: true
        });

        let json = null;
        try {
            json = JSON.parse(upload.responseText || '{}');
        } catch (_) {}

        if (upload.status < 200 || upload.status >= 300) {
            throw new Error(
                `Media upload HTTP ${upload.status}: ` +
                (json?.message || upload.responseText || '')
            );
        }

        if (img.alt) {
            try {
                await wpJson('POST', `/wp-json/wp/v2/media/${json.id}`, {
                    alt_text: img.alt
                });
            } catch (e) {
                log('Could not set image alt text:', e);
            }
        }

        return {
            id: json.id,
            url: json.source_url,
            alt: img.alt || ''
        };
    }

    function textToHtml(text) {
        const safe = esc(text || '');
        return safe
            .split(/\n{2,}/)
            .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
            .join('\n');
    }

    function mediaToHtml(media) {
        return media.map(m =>
            `<figure class="wp-block-image">` +
            `<img src="${esc(m.url)}" alt="${esc(m.alt)}">` +
            `</figure>`
        ).join('\n');
    }

    function validateArchiveIdentity(items) {
        const seenIds = new Set();
        const seenKeys = new Set();

        for (const item of items || []) {
            const id =
                String(item?.id || '');

            const key =
                archiveItemKey(item);

            if (id) {
                if (seenIds.has(id)) {
                    throw new Error(
                        `ARCHIVE ID COLLISION: ${id}`
                    );
                }

                seenIds.add(id);
            }

            if (key) {
                if (seenKeys.has(key)) {
                    throw new Error(
                        `ARCHIVE KEY COLLISION: ${key}`
                    );
                }

                seenKeys.add(key);
            }
        }

        return true;
    }

    function validateImportItem(item) {
        if (!item) {
            throw new Error(
                'Κενό collected item.'
            );
        }

        const imageCount =
            (item.images || []).length;

        if (
            imageCount >
            CFG.maxImagesPerPost
        ) {
            throw new Error(
                `IMAGE SAFETY: ${imageCount} εικόνες σε ένα post. ` +
                `Όριο: ${CFG.maxImagesPerPost}. ` +
                `Το import μπλοκαρίστηκε πριν ανέβει οποιαδήποτε εικόνα.`
            );
        }

        if (!item.date) {
            throw new Error(
                'Δεν υπάρχει ασφαλής ημερομηνία για αυτό το post.'
            );
        }

        if (!item.id) {
            throw new Error(
                'Δεν βρέθηκε σταθερό ID για αυτό το Facebook post.'
            );
        }

        return true;
    }

    async function importOne(item, categoryId, wpStatus) {
        validateImportItem(item);

        if (getImported().has(item.id)) {
            return { skipped: true, reason: 'local history' };
        }

        if (await wpAlreadyHas(item)) {
            markImported(item.id);
            return { skipped: true, reason: 'already in WordPress' };
        }

        const tagResult =
            await resolveWpTagIds(item.text);

        if (tagResult.hashtags.length) {
            status(
                `Tags: ${tagResult.hashtags.length} | ` +
                `Εικόνες: ${item.images.length} (${item.id})`
            );
        } else {
            status(
                `Κατεβάζω εικόνες: ${item.images.length} (${item.id})`
            );
        }

        const media = [];
        for (let i = 0; i < item.images.length; i++) {
            media.push(await uploadImage(item.images[i], item, i + 1));
        }

        const marker = `<!-- FB_IMPORT_ID:${item.id} -->`;
        const fingerprintMarker = `<!-- FB_FINGERPRINT:${item.fingerprint || archiveItemFingerprint(item)} -->`;
        const sourceMarker = item.permalink
            ? `<!-- FB_SOURCE:${esc(item.permalink)} -->`
            : '';

        let content = [
            marker,
            fingerprintMarker,
            sourceMarker,
            textToHtml(item.text)
        ].filter(Boolean).join('\n');

        if (media.length) {
            content += '\n' + mediaToHtml(
                CFG.includeFirstImageInContent ? media : media.slice(1)
            );
        }

        const payload = {
            title: titleFromText(item.text, item.date),
            slug: wpSlugForItem(item),
            content,
            status: wpStatus,
            date: wpLocalDateString(item.date),
            categories: [categoryId],
            tags: tagResult.ids
        };

        if (media[0]?.id) {
            payload.featured_media = media[0].id;
        }

        const created = await wpJson(
            'POST',
            '/wp-json/wp/v2/posts',
            payload
        );

        markImported(item.id);
        item.imported = true;

        log('Imported:', {
            facebook: item.permalink,
            wordpress: created.link,
            date: payload.date,
            media: media.length,
            hashtags: tagResult.hashtags,
            tagIds: tagResult.ids
        });

        return { skipped: false, post: created };
    }

    async function importAll() {
        if (busy) return;
        busy = true;

        try {
            const candidates = getArchivedRuntimeItems()
                .filter(p => p.date && !p.imported)
                .sort((a, b) => a.date - b.date);

            const allArchived = getArchivedRuntimeItems();

            validateArchiveIdentity(allArchived);

            const unresolved = allArchived
                .filter(p => !p.date);

            const missingPermalinks = candidates
                .filter(p => !canonicalFbPostUrl(p.permalink || ''));

            const unsafeImages = candidates
                .filter(p =>
                    (p.images || []).length >
                    CFG.maxImagesPerPost
                );

            if (unsafeImages.length) {
                const details = unsafeImages
                    .slice(0, 10)
                    .map(p =>
                        `${p.id}: ${(p.images || []).length} images`
                    )
                    .join('\n');

                throw new Error(
                    `IMPORT ALL ΜΠΛΟΚΑΡΙΣΤΗΚΕ: ` +
                    `${unsafeImages.length} post(s) έχουν υπερβολικό αριθμό εικόνων.\n` +
                    details
                );
            }

            if (!candidates.length) {
                status(
                    `Δεν υπάρχουν collected posts με ημερομηνία για import. ` +
                    `Unresolved: ${unresolved.length}`,
                    true
                );
                return;
            }

            const wpStatus =
                document.getElementById('fbwp-post-status')?.value ||
                CFG.defaultStatus;

            const yes = confirm(
                `Θα εισαχθούν ${candidates.length} collected posts ως "${wpStatus}".\n\n` +
                `Χωρίς ημερομηνία και δεν θα εισαχθούν: ${unresolved.length}\n` +
                `Χωρίς Facebook permalink: ${missingPermalinks.length} ` +
                `(duplicate protection παραμένει ενεργό μέσω slug)\n` +
                `Κατηγορία: ${CFG.targetCategoryName}\n` +
                `Site: θα ζητηθεί πριν το import\n\n` +
                `Συνέχεια;`
            );

            if (!yes) return;

            status('Ελέγχω WordPress credentials / category...');
            const categoryId = await findTargetCategoryId();

            let done = 0;
            let skipped = 0;
            let failed = 0;

            for (let i = 0; i < candidates.length; i++) {
                const item = candidates[i];

                try {
                    status(
                        `Import ${i + 1}/${candidates.length} | ` +
                        `${wpLocalDateString(item.date)} | ` +
                        `${item.images.length} εικόνες`
                    );

                    const r = await importOne(
                        item,
                        categoryId,
                        wpStatus
                    );

                    if (r.skipped) skipped++;
                    else done++;
                } catch (e) {
                    failed++;
                    console.error(
                        '[FB→WP] FAILED ITEM',
                        item,
                        e
                    );

                    const keepGoing = confirm(
                        `Αποτυχία στο post:\n${item.permalink}\n\n` +
                        `${e.message}\n\n` +
                        `OK = συνέχισε στα υπόλοιπα\n` +
                        `Cancel = σταμάτα`
                    );

                    if (!keepGoing) break;
                }
            }

            status(
                `Τέλος: ${done} imported | ` +
                `${skipped} skipped | ${failed} failed`,
                failed > 0
            );
        } catch (e) {
            console.error(e);
            status(e.message || String(e), true);
            alert('FB→WP: ' + (e.message || e));
        } finally {
            busy = false;
            updateArchiveUi();
        }
    }

    async function importFirstUnimported() {
        if (busy) return;
        busy = true;

        try {
            const allArchived =
                getArchivedRuntimeItems();

            validateArchiveIdentity(
                allArchived
            );

            const item = allArchived
                .filter(p => p.date && !p.imported)
                .sort((a, b) => b.date - a.date)[0];

            if (!item) {
                status(
                    'Δεν βρήκα collected post με ημερομηνία για δοκιμαστικό import.',
                    true
                );
                return;
            }

            validateImportItem(item);

            const wpStatus =
                document.getElementById('fbwp-post-status')?.value ||
                CFG.defaultStatus;

            if (!confirm(
                `Δοκιμαστικό import ΕΝΟΣ collected post:\n\n` +
                `${wpLocalDateString(item.date)}\n` +
                `${item.text.slice(0, 180)}\n\n` +
                `${item.images.length} εικόνες\n` +
                `Status: ${wpStatus}\n\nΣυνέχεια;`
            )) {
                return;
            }

            const categoryId = await findTargetCategoryId();
            const r = await importOne(
                item,
                categoryId,
                wpStatus
            );

            status(
                r.skipped
                    ? `Skipped: ${r.reason}`
                    : 'Το 1ο collected post εισήχθη. Έλεγξέ το στο WordPress.'
            );
        } catch (e) {
            console.error(e);
            status(e.message || String(e), true);
            alert('FB→WP: ' + (e.message || e));
        } finally {
            busy = false;
            updateArchiveUi();
        }
    }

    function injectUI() {
        if (document.getElementById('fbwp-panel')) return;

        let savedCutoff = '';

        try {
            savedCutoff =
                GM_getValue(
                    CFG.cutoffStorageKey,
                    ''
                ) || '';
        } catch (_) {}

        if (!savedCutoff) {
            savedCutoff = '01/01/2026';
        }

        const box = document.createElement('div');
        box.id = 'fbwp-panel';
        box.innerHTML = `
            <div style="font-weight:700;font-size:14px;margin-bottom:8px">
                Facebook → WordPress v${VERSION}
            </div>

            <div style="font-size:12px;margin-bottom:4px">
                Collect till:
            </div>

            <input
                id="fbwp-cutoff"
                value="${esc(savedCutoff)}"
                placeholder="01/01/2026"
                style="box-sizing:border-box;width:100%;padding:7px;margin-bottom:6px"
            >

            <button
                id="fbwp-collect"
                style="width:100%;padding:9px;cursor:pointer;font-weight:700"
            >
                Collect to date
            </button>

            <button
                id="fbwp-stop"
                style="width:100%;margin-top:5px;padding:7px;cursor:pointer"
            >
                STOP
            </button>

            <div
                id="fbwp-archive-count"
                style="margin-top:7px;font-size:11px;color:#ddd"
            ></div>


            <button
                id="fbwp-export-json"
                style="width:100%;margin-top:7px;padding:7px;cursor:pointer;font-weight:700"
            >
                Export JSON (no reset)
            </button>

            <button
                id="fbwp-clear"
                style="width:100%;margin-top:5px;padding:5px;cursor:pointer;font-size:11px"
            >
                Clear collected archive
            </button>

            <div
                id="fbwp-status"
                style="margin-top:8px;font-size:12px;line-height:1.35;color:#d9fdd3"
            >
                Κάθε post: See more → timestamp → collect. Hard stop στο cutoff. Fresh state only.
            </div>

            <div style="margin-top:7px;font-size:10px;color:#bbb">
                Πράσινο = collected με ημερομηνία<br>
                Πορτοκαλί = collected αλλά ημερομηνία unresolved<br>
                Γκρι = παλαιότερο από το όριο
            </div>
        `;

        Object.assign(box.style, {
            position: 'fixed',
            right: '18px',
            bottom: '18px',
            width: '255px',
            zIndex: '2147483647',
            background: '#1c1e21',
            color: '#fff',
            border: '1px solid #555',
            borderRadius: '10px',
            padding: '12px',
            boxShadow: '0 6px 28px rgba(0,0,0,.45)',
            fontFamily: 'Arial, sans-serif'
        });

        document.body.appendChild(box);

        document
            .getElementById('fbwp-collect')
            .addEventListener('click', collectToDate);

        document
            .getElementById('fbwp-stop')
            .addEventListener('click', stopCollector);


        document
            .getElementById('fbwp-export-json')
            .addEventListener('click', exportCollectedJson);

        document
            .getElementById('fbwp-clear')
            .addEventListener('click', clearCollectedArchive);

        updateArchiveUi();
    }

    function boot() {
        injectUI();

        // Facebook SPA navigation can replace chunks of the page.
        const observer = new MutationObserver(() => {
            if (!document.getElementById('fbwp-panel')) injectUI();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        log(`Loaded collector v${VERSION}.`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
