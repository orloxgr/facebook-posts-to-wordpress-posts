# Tampermonkey collector

Current collector version is defined only by the `@version` field in `facebook-posts-to-wordpress.user.js`.

The collector is generic: it is not tied to a specific Facebook Page or WordPress domain.

## Install

Install directly from GitHub using the raw userscript URL:

`https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js`

With Tampermonkey installed, opening that URL should offer the userscript installation screen.

The canonical userscript includes `@updateURL` and `@downloadURL` pointing to the same raw GitHub file, so Tampermonkey can check for future updates automatically whenever `@version` changes.

There is only one active collector source file: `facebook-posts-to-wordpress.user.js`. The collector code runs directly as a Tampermonkey userscript; there is no loader, `@require`, `eval()` or `new Function()` layer.

After installation, open the Facebook Page you want to archive, for example:

`https://www.facebook.com/example.page`

## Workflow

1. Open the Facebook Page you want to migrate.
2. Set the cutoff date.
3. Run **Collect**.
4. Wait until the cutoff is reached.
5. Confirm `unresolved: 0` and `image-risk: 0`.
6. Export the JSON archive.
7. Use the WordPress plugin in `../wordpress-plugin/` for the actual import.

The collector exports JSON only; the obsolete direct WordPress import controls have been removed from the panel.

## Generic behavior

- Runs on Facebook Pages instead of one hard-coded Page URL.
- Post author/root checks use the author shown in each post rather than a hard-coded Page name.
- Facebook permalink detection accepts normal Page post/photo/video/reel URL shapes.
- Collector state is isolated per Facebook Page and per collector version.
- Export filenames use the current Page context instead of a client-specific prefix.

## Version handling

- The only literal collector version is the Tampermonkey `@version` metadata field.
- Runtime UI text, clear-state confirmation text and storage keys read the version from `GM_info.script.version`.
- Storage keys derive their version suffix automatically from that runtime value.
- Each collector release uses its own isolated state; no previous-version state migration is performed.

## Collector rules

- Publication dates are read only from Facebook's structural timestamp/permalink context; dates written in the post body are never used as the publication date.
- Unknown exact time uses local 00:00.
- First line or first sentence, whichever ends first, is the title rule used by the importer.
- `textFingerprint` is diagnostic only, never the normal identity key.
- Exact full text is used only for the narrow unresolved-snapshot repair rule: exactly one dated match and an identity-less unresolved snapshot.
- A post with more than 20 collected images is considered an image-scope anomaly and is blocked from import.
