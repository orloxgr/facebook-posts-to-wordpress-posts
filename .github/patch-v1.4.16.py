from pathlib import Path
import re

path = Path('tampermonkey/facebook-posts-to-wordpress.user.js')
src = path.read_text(encoding='utf-8')

# Version: fresh isolated storage automatically follows GM_info.script.version.
old = '// @version      1.4.15'
new = '// @version      1.4.16'
if old not in src:
    raise SystemExit('Expected @version 1.4.15 not found')
src = src.replace(old, new, 1)

# Stronger duplicate reconciliation: exact full text + exact image set.
start = src.find('    function repairUnresolvedExactTextDuplicates(map) {')
end = src.find('\n    function archiveToRuntimeItem(item) {', start)
if start < 0 or end < 0:
    raise SystemExit('repairUnresolvedExactTextDuplicates boundaries not found')

repair = r'''    function exactImageSignature(item) {
        return (item?.images || [])
            .map(img => stableImageIdentity(img?.url || img))
            .filter(Boolean)
            .sort()
            .join('|');
    }

    function exactContentSignature(textValue, images = []) {
        const textFp = makeTextFingerprint(textValue);
        if (!textFp) return '';

        return `${textFp}|${(images || [])
            .map(img => stableImageIdentity(img?.url || img))
            .filter(Boolean)
            .sort()
            .join('|')}`;
    }

    function repairUnresolvedExactTextDuplicates(map) {
        const groups = new Map();

        for (const [key, item] of map.entries()) {
            const exactText = String(item?.text || '');
            if (!exactText) continue;

            const imageSignature = exactImageSignature(item);
            const groupKey = `${exactText}\u0000${imageSignature}`;

            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    imageSignature,
                    dated: [],
                    unresolved: []
                });
            }

            const group = groups.get(groupKey);

            if (item?.dateIso) {
                group.dated.push({ key, item });
            } else {
                group.unresolved.push({ key, item });
            }
        }

        let repaired = 0;

        for (const group of groups.values()) {
            /*
             * Safety rule:
             * exactly ONE dated snapshot must exist for the exact full text
             * AND exact image set. If there are 0 or 2+, do nothing.
             */
            if (
                group.dated.length !== 1 ||
                !group.unresolved.length
            ) {
                continue;
            }

            const anchor = group.dated[0];
            const anchorPermalink = canonicalFbPostUrl(
                anchor.item?.permalink || ''
            );
            const anchorSourceId =
                extractPostId(anchorPermalink) ||
                (
                    anchor.item?.id &&
                    !String(anchor.item.id).startsWith('fp-')
                        ? String(anchor.item.id)
                        : ''
                );

            const eligibleUnresolved = group.unresolved.filter(({ item }) => {
                const permalink = canonicalFbPostUrl(item?.permalink || '');
                const sourceId =
                    extractPostId(permalink) ||
                    (
                        item?.id &&
                        !String(item.id).startsWith('fp-')
                            ? String(item.id)
                            : ''
                    );

                // Identity-less snapshots are safe under exact text+image match.
                if (!sourceId) return true;

                // Same real source ID is always the same source post.
                if (anchorSourceId && sourceId === anchorSourceId) {
                    return true;
                }

                /*
                 * Facebook can expose the same post once as /posts/... and once
                 * as /photo/?fbid=.... Allow that reconciliation only when the
                 * exact image set is non-empty as an additional identity check.
                 */
                return Boolean(group.imageSignature);
            });

            if (!eligibleUnresolved.length) continue;

            let merged = anchor.item;

            for (const duplicate of eligibleUnresolved) {
                /*
                 * Keep the dated anchor as the incoming side so its canonical
                 * permalink/source identity and date diagnostics win.
                 */
                merged = mergeArchiveItems(
                    duplicate.item,
                    merged
                );
            }

            const newKey = archiveItemKey(merged);

            map.delete(anchor.key);

            for (const duplicate of eligibleUnresolved) {
                map.delete(duplicate.key);
                repaired++;
            }

            map.set(newKey, merged);
        }

        return repaired;
    }
'''
src = src[:start] + repair + src[end:]

# Manual retry replaces the automatic second pass. Update the stale comment.
src = src.replace(
    '// Keep pass 1 quick. Misses are retried by pass 2.',
    '// Keep normal collection quick. Misses can be retried manually.',
    1
)

# collectVisiblePosts accepts runSeen, so cycles do not reprocess mounted posts.
sig_old = '    async function collectVisiblePosts(cutoffDate) {'
sig_new = '    async function collectVisiblePosts(cutoffDate, runSeen = null) {'
if sig_old not in src:
    raise SystemExit('collectVisiblePosts signature not found')
src = src.replace(sig_old, sig_new, 1)

article_marker = '''            const article = containers[index];\n\n            status('''
if article_marker not in src:
    raise SystemExit('article loop marker not found')
article_repl = '''            const article = containers[index];\n\n            const earlyPermalink = getPermalink(article);\n            const earlySourceId = extractPostId(earlyPermalink || '');\n            const earlyKey = earlySourceId\n                ? `id:${earlySourceId}`\n                : canonicalFbPostUrl(earlyPermalink || '');\n\n            if (\n                runSeen &&\n                (\n                    runSeen.nodes?.has(article) ||\n                    (earlyKey && runSeen.keys?.has(earlyKey))\n                )\n            ) {\n                continue;\n            }\n\n            status('''
src = src.replace(article_marker, article_repl, 1)

save_marker = '''            saveArchiveRaw([...map.values()]);\n\n            article.style.outline = dateValue\n                ? '2px solid #35a853'\n                : '2px solid #d99b25';\n            article.dataset.fbwp = dateValue ? 'collected' : 'collected-no-date';\n        }\n'''
if save_marker not in src:
    raise SystemExit('save/seen marker not found')
save_repl = '''            saveArchiveRaw([...map.values()]);\n\n            if (runSeen) {\n                runSeen.nodes?.add(article);\n                if (earlyKey) runSeen.keys?.add(earlyKey);\n            }\n\n            article.style.outline = dateValue\n                ? '2px solid #35a853'\n                : '2px solid #d99b25';\n            article.dataset.fbwp = dateValue ? 'collected' : 'collected-no-date';\n        }\n'''
src = src.replace(save_marker, save_repl, 1)

# Remove the automatic PASS 2 block entirely.
auto_start = src.find('        /*\n         * PASS 2:')
auto_end = src.find('        const repairedExactText =', auto_start)
if auto_start < 0 or auto_end < 0:
    raise SystemExit('automatic PASS 2 block boundaries not found')
src = src[:auto_start] + src[auto_end:]

src = src.replace(
    '            unresolvedCount: actualUnresolved,\n            secondPassRecovered,\n            repairedExactText,',
    '            unresolvedCount: actualUnresolved,\n            repairedExactText,',
    1
)

# One run-scoped seen registry is shared across all scroll cycles.
stop_marker = "        let stopReason = '';\n"
if stop_marker not in src:
    raise SystemExit('collectToDate stopReason marker not found')
src = src.replace(
    stop_marker,
    stop_marker + "        const runSeen = { keys: new Set(), nodes: new WeakSet() };\n",
    1
)

call_old = '                const result = await collectVisiblePosts(cutoffDate);'
call_new = '                const result = await collectVisiblePosts(cutoffDate, runSeen);'
if call_old not in src:
    raise SystemExit('collectVisiblePosts call not found')
src = src.replace(call_old, call_new, 1)

# Add explicit slow retry action after stopCollector().
insert_at = src.find('\n\n    function getCredentials() {')
if insert_at < 0:
    raise SystemExit('getCredentials insertion marker not found')

retry_fn = r'''

    async function retryUnresolved() {
        if (busy) return;

        busy = true;
        collectorStopRequested = false;

        try {
            const map = new Map();

            for (const raw of loadArchiveRaw()) {
                const item = mergeArchiveItems({}, raw);
                const key = archiveItemKey(item);

                if (map.has(key)) {
                    map.set(
                        key,
                        mergeArchiveItems(map.get(key), item)
                    );
                } else {
                    map.set(key, item);
                }
            }

            const reconciledBefore =
                repairUnresolvedExactTextDuplicates(map);

            saveArchiveRaw([...map.values()]);

            let unresolvedEntries = [...map.entries()]
                .filter(([, item]) => !item.dateIso);

            if (!unresolvedEntries.length) {
                status(
                    `Retry: 0 unresolved. Reconciled duplicates: ${reconciledBefore}.`,
                    'ok'
                );
                return;
            }

            const cutoffValue = GM_getValue(
                CFG.cutoffStorageKey,
                ''
            ) || '';
            const cutoffDate = parseCutoffInput(cutoffValue);

            const bySourceId = new Map();
            const byPermalink = new Map();
            const byContent = new Map();

            for (const [key, item] of unresolvedEntries) {
                const permalink = canonicalFbPostUrl(item.permalink || '');
                const sourceId =
                    extractPostId(permalink) ||
                    (
                        item.id &&
                        !String(item.id).startsWith('fp-')
                            ? String(item.id)
                            : ''
                    );

                if (sourceId) bySourceId.set(sourceId, key);
                if (permalink) byPermalink.set(permalink, key);

                const contentKey = exactContentSignature(
                    item.text || '',
                    item.images || []
                );

                if (contentKey) {
                    if (!byContent.has(contentKey)) {
                        byContent.set(contentKey, []);
                    }
                    byContent.get(contentKey).push(key);
                }
            }

            const containers = getPostContainers().filter(isTargetPost);
            let matched = 0;
            let recovered = 0;
            let removedOlder = 0;

            status(
                `Retry unresolved: ${unresolvedEntries.length} pending, ` +
                `${containers.length} mounted posts...`,
                'info'
            );

            for (let i = 0; i < containers.length; i++) {
                if (collectorStopRequested) break;

                const article = containers[i];
                const permalink = getPermalink(article);
                const canonical = canonicalFbPostUrl(permalink || '');
                const sourceId = extractPostId(canonical || permalink || '');

                let existingKey = null;

                if (sourceId && bySourceId.has(sourceId)) {
                    existingKey = bySourceId.get(sourceId);
                } else if (canonical && byPermalink.has(canonical)) {
                    existingKey = byPermalink.get(canonical);
                }

                if (!existingKey) {
                    const textValue = extractText(article);
                    const images = extractImages(article);
                    const contentKey = exactContentSignature(
                        textValue,
                        images
                    );
                    const matches = contentKey
                        ? (byContent.get(contentKey) || [])
                        : [];

                    if (matches.length === 1) {
                        existingKey = matches[0];
                    }
                }

                if (!existingKey) continue;

                const existing = map.get(existingKey);
                if (!existing || existing.dateIso) continue;

                matched++;
                status(
                    `Retry unresolved ${matched}/${unresolvedEntries.length}: ` +
                    `waiting for timestamp...`,
                    'info'
                );

                const timestamp = await waitForTimestampCandidates(
                    article,
                    2500
                );

                let dateInfo = {
                    date: null,
                    source: 'main post timestamp unresolved',
                    hoverDebug: []
                };

                for (const candidate of timestamp.values || []) {
                    const parsed = parseFbDate(candidate.value);
                    if (parsed && !isNaN(parsed)) {
                        dateInfo = {
                            date: parsed,
                            source: `${candidate.source}: ${candidate.value}`,
                            hoverDebug: []
                        };
                        break;
                    }
                }

                if (
                    !dateInfo.date &&
                    timestamp.timestampEl &&
                    timestamp.timestampEl.isConnected
                ) {
                    const hovered = await getDateFromHover(
                        timestamp.timestampEl,
                        1600
                    );

                    if (hovered.date) {
                        dateInfo = hovered;
                    }
                }

                if (!dateInfo.date) continue;

                if (
                    cutoffDate &&
                    startOfDay(dateInfo.date) < cutoffDate
                ) {
                    map.delete(existingKey);
                    removedOlder++;
                    continue;
                }

                const retrySnapshot = {
                    ...existing,
                    dateIso: dateInfo.date.toISOString(),
                    dateSource: dateInfo.source || '',
                    dateDebug: {
                        ...(existing.dateDebug || {}),
                        manualRetry: {
                            candidates: (timestamp.values || []).map(x => ({
                                source: x.source,
                                value: x.value
                            })),
                            hasTimestampElement: Boolean(timestamp.timestampEl),
                            hoverDebug: dateInfo.hoverDebug || []
                        }
                    }
                };

                const merged = mergeArchiveItems(existing, retrySnapshot);
                const newKey = archiveItemKey(merged);

                if (newKey !== existingKey) {
                    map.delete(existingKey);
                }
                map.set(newKey, merged);
                recovered++;
            }

            const reconciledAfter =
                repairUnresolvedExactTextDuplicates(map);

            saveArchiveRaw([...map.values()]);

            const remaining = [...map.values()]
                .filter(item => !item.dateIso)
                .length;

            status(
                `Retry DONE: ${recovered} recovered, ` +
                `${removedOlder} older-than-cutoff removed, ` +
                `${reconciledBefore + reconciledAfter} duplicate snapshots reconciled, ` +
                `${remaining} unresolved remain. ` +
                `Matched ${matched}/${unresolvedEntries.length} in mounted DOM.`,
                remaining ? 'warn' : 'ok'
            );
        } catch (e) {
            console.error('[FB→WP] Retry unresolved failed:', e);
            status(e.message || String(e), 'error');
            alert('Retry unresolved: ' + (e.message || e));
        } finally {
            busy = false;
            collectorStopRequested = false;
            updateArchiveUi();
        }
    }
'''
src = src[:insert_at] + retry_fn + src[insert_at:]

# Add Retry button under STOP.
stop_button = '''            <button\n                id="fbwp-stop"\n                style="width:100%;margin-top:5px;padding:7px;cursor:pointer"\n            >\n                STOP\n            </button>\n'''
if stop_button not in src:
    raise SystemExit('STOP button block not found')
retry_button = stop_button + '''\n            <button\n                id="fbwp-retry-unresolved"\n                style="width:100%;margin-top:5px;padding:7px;cursor:pointer;font-weight:700"\n            >\n                Retry unresolved\n            </button>\n'''
src = src.replace(stop_button, retry_button, 1)

# Add click handler.
stop_listener = '''        document\n            .getElementById('fbwp-stop')\n            .addEventListener('click', stopCollector);\n'''
if stop_listener not in src:
    raise SystemExit('STOP listener block not found')
retry_listener = stop_listener + '''\n        document\n            .getElementById('fbwp-retry-unresolved')\n            .addEventListener('click', retryUnresolved);\n'''
src = src.replace(stop_listener, retry_listener, 1)

# Update UI guidance.
src = src.replace(
    'Κάθε post: See more → timestamp → collect. Hard stop στο cutoff. Fresh state only.',
    'Collect = fast pass. Retry unresolved = slower retry μόνο για unresolved. Hard stop στο cutoff. Fresh state only.',
    1
)

# Sanity checks.
required = [
    '// @version      1.4.16',
    'const VERSION = String(GM_info.script.version);',
    'async function collectVisiblePosts(cutoffDate, runSeen = null)',
    'const runSeen = { keys: new Set(), nodes: new WeakSet() };',
    'async function retryUnresolved()',
    'id="fbwp-retry-unresolved"',
    '.addEventListener(\'click\', retryUnresolved)',
    '2500',
    '1600',
    'exactImageSignature(item)'
]
for token in required:
    if token not in src:
        raise SystemExit('Missing required token: ' + token)

if 'PASS 2:' in src:
    raise SystemExit('Automatic PASS 2 marker still present')
if 'secondPassRecovered' in src:
    raise SystemExit('Automatic secondPassRecovered state still present')

runtime_without_metadata = re.sub(
    r'^// @version\s+.*$',
    '',
    src,
    count=1,
    flags=re.M
)
stale = re.findall(r'\bv\d+\.\d+(?:\.\d+)?\b', runtime_without_metadata)
if stale:
    raise SystemExit(f'Hard-coded collector version strings remain: {stale[:10]}')

path.write_text(src, encoding='utf-8')
