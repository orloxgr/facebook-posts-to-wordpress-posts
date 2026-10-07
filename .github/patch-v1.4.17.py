from pathlib import Path

path = Path('tampermonkey/facebook-posts-to-wordpress.user.js')
src = path.read_text(encoding='utf-8')

src = src.replace('// @version      1.4.16', '// @version      1.4.17', 1)
src = src.replace('// @run-at       document-idle', '// @run-at       document-start', 1)

if '// @grant        unsafeWindow' not in src:
    src = src.replace('// @grant        GM_info\n', '// @grant        GM_info\n// @grant        unsafeWindow\n', 1)

hook_marker = "    'use strict';\n\n"
if hook_marker not in src:
    raise SystemExit('use strict marker not found')

hook = r'''    'use strict';

    /*
     * Facebook renders timestamp text inside closed shadow roots on some posts.
     * DevTools can display those roots, but normal DOM APIs cannot read them.
     * Install the hook at document-start and keep the returned ShadowRoot in a
     * private WeakMap without changing Facebook's requested open/closed mode.
     */
    const FBWP_CAPTURED_SHADOW_ROOTS = new WeakMap();

    (function installShadowRootCapture() {
        try {
            const pageWindow =
                typeof unsafeWindow !== 'undefined'
                    ? unsafeWindow
                    : window;

            const proto = pageWindow?.Element?.prototype;
            const originalAttachShadow = proto?.attachShadow;

            if (
                !proto ||
                typeof originalAttachShadow !== 'function' ||
                proto.__fbwpShadowCaptureInstalled
            ) {
                return;
            }

            const wrappedAttachShadow = function(init) {
                const root = originalAttachShadow.call(this, init);

                try {
                    FBWP_CAPTURED_SHADOW_ROOTS.set(this, root);
                } catch (_) {}

                return root;
            };

            Object.defineProperty(proto, 'attachShadow', {
                configurable: true,
                writable: true,
                value: wrappedAttachShadow
            });

            Object.defineProperty(proto, '__fbwpShadowCaptureInstalled', {
                configurable: true,
                value: true
            });
        } catch (e) {
            console.warn('[FB→WP] Shadow-root capture hook unavailable:', e);
        }
    })();

'''
src = src.replace(hook_marker, hook, 1)

# Add helper immediately before collectElementDateStrings().
marker = '    function collectElementDateStrings(el) {'
pos = src.find(marker)
if pos < 0:
    raise SystemExit('collectElementDateStrings not found')

helper = r'''    function getCapturedShadowRoot(host) {
        if (!host) return null;

        try {
            return (
                host.shadowRoot ||
                FBWP_CAPTURED_SHADOW_ROOTS.get(host) ||
                null
            );
        } catch (_) {
            return null;
        }
    }

    function collectCapturedShadowDateStrings(el) {
        const values = new Set();
        const seenRoots = new Set();
        const seenHosts = new Set();

        if (!el) return [];

        function add(value) {
            const v = String(value || '')
                .replace(/\u202f/g, ' ')
                .trim();

            if (v && v.length <= 240) {
                values.add(v);
            }
        }

        function visitHost(host, depth = 0) {
            if (
                !host ||
                depth > 5 ||
                seenHosts.has(host)
            ) {
                return;
            }

            seenHosts.add(host);

            const root = getCapturedShadowRoot(host);
            if (!root || seenRoots.has(root)) return;

            seenRoots.add(root);

            add(root.textContent);

            const nodes = [
                ...root.querySelectorAll('*')
            ].slice(0, 160);

            for (const node of nodes) {
                add(node.getAttribute?.('aria-label'));
                add(node.getAttribute?.('title'));
                add(node.getAttribute?.('datetime'));

                const utime = node.getAttribute?.('data-utime');
                if (utime) add('UTIME:' + utime);

                add(node.textContent);

                visitHost(node, depth + 1);
            }
        }

        visitHost(el, 0);

        for (const host of [
            ...el.querySelectorAll?.('*') || []
        ].slice(0, 160)) {
            visitHost(host, 0);
        }

        return [...values];
    }

'''
src = src[:pos] + helper + src[pos:]

# Feed captured shadow-root strings into the existing date candidate pipeline.
start = src.find('    function collectElementDateStrings(el) {')
end = src.find('\n    function collectReactDateStrings(el) {', start)
if start < 0 or end < 0:
    raise SystemExit('collectElementDateStrings boundaries not found')

block = src[start:end]
needle = '        return [...values];\n    }\n'
if needle not in block:
    raise SystemExit('collectElementDateStrings return marker not found')

replacement = '''        for (const shadowValue of collectCapturedShadowDateStrings(el)) {\n            add(shadowValue);\n        }\n\n        return [...values];\n    }\n'''
block = block.replace(needle, replacement, 1)
src = src[:start] + block + src[end:]

path.write_text(src, encoding='utf-8')
