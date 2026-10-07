from pathlib import Path

path = Path('tampermonkey/facebook-posts-to-wordpress.user.js')
s = path.read_text(encoding='utf-8')


def repl(old, new, expected=1, label='replacement'):
    global s
    count = s.count(old)
    if count != expected:
        raise SystemExit(f'{label}: expected {expected}, found {count}')
    s = s.replace(old, new)


repl('// @version      1.4.18', '// @version      1.4.19', label='version')
repl(
    '// @description  Collect Facebook Page posts to JSON for WordPress import, preserving source dates, text and photos.',
    '// @description  Collect Facebook Page posts to JSON for WordPress import, preserving source dates, text, photos and video metadata.',
    label='description'
)

repl(
    "        const images =\n            [...imagesByIdentity.values()];\n\n        const dateValue = chosenDate",
    "        const images =\n            [...imagesByIdentity.values()];\n\n        const video = mergeVideoMetadata(\n            a.video || null,\n            b.video || null,\n            permalink\n        );\n\n        const dateValue = chosenDate",
    label='merge video metadata'
)

repl(
    "            permalink,\n            text: textValue,\n            images,\n\n            dateIso: chosenDate,",
    "            permalink,\n            text: textValue,\n            images,\n            video,\n\n            dateIso: chosenDate,",
    label='merged item video field'
)

repl(
    "        const imageRisk = data.filter(x =>\n            (x.images || []).length >\n            CFG.maxImagesPerPost\n        ).length;\n\n        el.textContent =\n            `Collected: ${data.length} | dated: ${dated} | ` +\n            `unresolved: ${unresolved} | links: ${linked}/${data.length} | ` +\n            `image-risk: ${imageRisk}`;",
    "        const imageRisk = data.filter(x =>\n            (x.images || []).length >\n            CFG.maxImagesPerPost\n        ).length;\n\n        const videoPosts = data.filter(x => Boolean(x.video)).length;\n        const downloadableVideos = data.filter(x => Boolean(x.video?.url)).length;\n\n        el.textContent =\n            `Collected: ${data.length} | dated: ${dated} | ` +\n            `unresolved: ${unresolved} | links: ${linked}/${data.length} | ` +\n            `videos: ${videoPosts} (${downloadableVideos} direct) | ` +\n            `image-risk: ${imageRisk}`;",
    label='archive ui video stats'
)

repl(
    "                    images: item.images || [],\n                    imageCount:\n                        (item.images || []).length,\n                    collectedAt:",
    "                    images: item.images || [],\n                    imageCount:\n                        (item.images || []).length,\n                    video: item.video || null,\n                    videoCount: item.video ? 1 : 0,\n                    collectedAt:",
    label='json video export'
)

marker = "\n    function getMainPostHeader(article) {"
if s.count(marker) != 1:
    raise SystemExit(f'video helper insertion marker count={s.count(marker)}')

helper = r'''

    function isVideoPostPermalink(url) {
        return /\/videos\//i.test(String(url || '')) ||
            /\/reel\//i.test(String(url || ''));
    }

    function normalizeMediaCandidateUrl(value) {
        let raw = String(value || '')
            .replace(/\\u002F/gi, '/')
            .replace(/\\u0026/gi, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&')
            .trim();

        if (!raw || /^blob:/i.test(raw) || /^data:/i.test(raw)) {
            return '';
        }

        const embedded = raw.match(/https?:\/\/[^\s\"'<>\\]+/i);
        if (embedded) raw = embedded[0];

        try {
            const u = new URL(raw, location.origin);
            if (!/^https?:$/i.test(u.protocol)) return '';
            return u.toString();
        } catch (_) {
            return '';
        }
    }

    function isFbCdnUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return host === 'fbcdn.net' || host.endsWith('.fbcdn.net');
        } catch (_) {
            return false;
        }
    }

    function videoUrlLooksDirect(url) {
        if (!url || !isFbCdnUrl(url)) return false;

        const s = String(url).toLowerCase();
        return (
            /\.mp4(?:$|[?&])/.test(s) ||
            /mime_type=video/.test(s) ||
            /\/video\//.test(s) ||
            /\/v\/t\d/.test(s)
        );
    }

    function mergeVideoMetadata(existing, incoming, fallbackPermalink = '') {
        const a = existing && typeof existing === 'object'
            ? existing
            : null;
        const b = incoming && typeof incoming === 'object'
            ? incoming
            : null;

        if (!a && !b && !isVideoPostPermalink(fallbackPermalink)) {
            return null;
        }

        const merged = {
            ...(a || {}),
            ...(b || {})
        };

        merged.url =
            b?.url ||
            a?.url ||
            '';

        merged.poster =
            b?.poster ||
            a?.poster ||
            '';

        merged.permalink =
            b?.permalink ||
            a?.permalink ||
            (isVideoPostPermalink(fallbackPermalink) ? fallbackPermalink : '');

        merged.downloadable = Boolean(merged.url);
        merged.blobSource = Boolean(a?.blobSource || b?.blobSource);

        return merged;
    }

    function extractVideo(article, permalink = '') {
        if (!isSafePostRoot(article)) {
            console.error(
                '[FB→WP] VIDEO SCOPE REFUSED: unsafe/broad post root'
            );
            return null;
        }

        const videos = [
            ...article.querySelectorAll('video')
        ].filter(video => !isInsideComment(video, article));

        const videoSignal =
            videos.length > 0 ||
            isVideoPostPermalink(permalink);

        if (!videoSignal) {
            return null;
        }

        const directCandidates = [];
        const posterCandidates = [];
        const seenDirect = new Set();
        const seenPoster = new Set();
        let blobSource = false;
        let width = 0;
        let height = 0;

        function addDirect(value, source, score = 0, strong = false) {
            const raw = String(value || '').trim();
            if (/^blob:/i.test(raw)) {
                blobSource = true;
                return;
            }

            const url = normalizeMediaCandidateUrl(raw);
            if (!url || !isFbCdnUrl(url)) return;
            if (!strong && !videoUrlLooksDirect(url)) return;
            if (seenDirect.has(url)) return;

            seenDirect.add(url);
            directCandidates.push({ url, source, score });
        }

        function addPoster(value, source, score = 0) {
            const url = normalizeMediaCandidateUrl(value);
            if (!url || !isFbCdnUrl(url)) return;
            if (videoUrlLooksDirect(url)) return;
            if (seenPoster.has(url)) return;

            seenPoster.add(url);
            posterCandidates.push({ url, source, score });
        }

        for (const video of videos) {
            width = Math.max(
                width,
                Number(video.videoWidth || video.clientWidth || video.width || 0)
            );
            height = Math.max(
                height,
                Number(video.videoHeight || video.clientHeight || video.height || 0)
            );

            addDirect(video.currentSrc, 'dom:currentSrc', 90, false);
            addDirect(video.src, 'dom:src', 85, false);

            for (const source of video.querySelectorAll('source[src]')) {
                addDirect(source.src || source.getAttribute('src'), 'dom:source', 80, false);
            }

            addPoster(video.poster || video.getAttribute('poster'), 'dom:poster', 100);
        }

        const seenObjects = new WeakSet();
        let inspectedObjects = 0;

        function inspectString(value, path) {
            const p = String(path || '').toLowerCase();
            const isPosterPath = /poster|thumbnail|thumb|preview_image|preferred_thumbnail/.test(p);
            const isVideoPath = /playable|browser_native|progressive|video_url|video_uri|videourl|videouri|video\.src|video_src/.test(p);
            const isHd = /(^|[._])hd([._]|$)|quality_hd|high_quality/.test(p);
            const isSd = /(^|[._])sd([._]|$)|quality_sd|low_quality/.test(p);

            if (isPosterPath) {
                addPoster(value, `react:${path}`, 70);
                return;
            }

            if (isVideoPath) {
                addDirect(
                    value,
                    `react:${path}`,
                    isHd ? 120 : (isSd ? 70 : 100),
                    true
                );
                return;
            }

            if (/src|url|uri/.test(p)) {
                addDirect(value, `react:${path}`, 50, false);
            }
        }

        function walk(value, depth = 0, path = '') {
            if (value == null || depth > 7 || inspectedObjects > 2500) return;

            if (typeof value === 'string') {
                inspectString(value, path);
                return;
            }

            if (typeof value !== 'object') return;
            if (seenObjects.has(value)) return;
            seenObjects.add(value);
            inspectedObjects++;

            if (Array.isArray(value)) {
                value.slice(0, 80).forEach((v, i) =>
                    walk(v, depth + 1, `${path}[${i}]`)
                );
                return;
            }

            let count = 0;
            for (const [key, child] of Object.entries(value)) {
                if (++count > 140) break;

                const childPath = path ? `${path}.${key}` : key;
                const interesting =
                    depth < 2 ||
                    /video|playable|browser_native|progressive|poster|thumbnail|thumb|preview|src|url|uri|media|attachment|props|children|data|node/i.test(key) ||
                    /video|playable|poster|thumbnail|media|attachment/i.test(path);

                if (interesting) {
                    walk(child, depth + 1, childPath);
                }
            }
        }

        const reactNodes = new Set([article]);

        for (const video of videos) {
            let node = video;
            let depth = 0;
            while (node && article.contains(node) && depth < 8) {
                reactNodes.add(node);
                if (node === article) break;
                node = node.parentElement;
                depth++;
            }
        }

        for (const node of reactNodes) {
            for (const key of Object.keys(node)) {
                if (/^__reactProps/.test(key)) {
                    try {
                        walk(node[key], 0, 'props');
                    } catch (_) {}
                    continue;
                }

                if (/^__reactFiber/.test(key)) {
                    try {
                        const fiber = node[key];
                        walk(fiber?.memoizedProps, 0, 'memoizedProps');
                        walk(fiber?.pendingProps, 0, 'pendingProps');
                    } catch (_) {}
                }
            }
        }

        directCandidates.sort((a, b) => b.score - a.score);
        posterCandidates.sort((a, b) => b.score - a.score);

        const direct = directCandidates[0] || null;
        const poster = posterCandidates[0] || null;

        return {
            permalink: isVideoPostPermalink(permalink) ? permalink : '',
            url: direct?.url || '',
            poster: poster?.url || '',
            downloadable: Boolean(direct?.url),
            source: direct?.source || (videos.length ? 'dom:video' : 'permalink'),
            posterSource: poster?.source || '',
            width,
            height,
            blobSource,
            domVideoCount: videos.length
        };
    }
'''
s = s.replace(marker, helper + marker)

# Both scan() and collectVisiblePosts() collect media after text.
repl(
    "            const permalink = getPermalink(article);\n            const textValue = extractText(article);\n            const images = extractImages(article);",
    "            const permalink = getPermalink(article);\n            const textValue = extractText(article);\n            const images = extractImages(article);\n            const video = extractVideo(article, permalink);",
    expected=2,
    label='media collection calls'
)

repl(
    "                text: textValue,\n                images,\n                date: dateInfo.date,",
    "                text: textValue,\n                images,\n                video,\n                date: dateInfo.date,",
    label='scan item video'
)

repl(
    "            images: p.images.length,\n            imported: p.imported,",
    "            images: p.images.length,\n            video: p.video ? (p.video.url ? 'direct' : 'embed-only') : '',\n            imported: p.imported,",
    label='scan table video'
)

repl(
    "                text: textValue,\n                images,\n                date: dateValue,\n                fingerprint",
    "                text: textValue,\n                images,\n                video,\n                date: dateValue,\n                fingerprint",
    label='runtime video'
)

repl(
    "                permalink,\n                text: textValue,\n                images,\n                dateIso:",
    "                permalink,\n                text: textValue,\n                images,\n                video,\n                dateIso:",
    label='snapshot video'
)

repl(
    "                    images: (item.images || []).length,\n                    url: item.permalink,",
    "                    images: (item.images || []).length,\n                    video: item.video ? (item.video.url ? 'direct' : 'embed-only') : '',\n                    url: item.permalink,",
    label='done table video'
)

path.write_text(s, encoding='utf-8')
