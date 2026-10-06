# Tampermonkey collector

Current collector: **v1.4.7**.

The collector is generic: it is not tied to a specific Facebook Page or WordPress domain.

## Install

Install directly from GitHub using the raw userscript URL:

`https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js`

With Tampermonkey installed, opening that URL should offer the userscript installation screen.

The canonical userscript includes `@updateURL` and `@downloadURL` pointing to the same raw GitHub file, so Tampermonkey can check for future updates automatically.

The canonical script loads the versioned collector with Tampermonkey's `@require`. It does **not** use `eval()` or `new Function()`, so Facebook's Content Security Policy does not block the collector with an `unsafe-eval` error.

After installation, open the Facebook Page you want to archive, for example:

`https://www.facebook.com/example.page`

The readable versioned collector source is kept in this directory as `facebook-posts-to-wordpress-v1.4.7.user.js`.

## Workflow

1. Open the Facebook Page you want to migrate.
2. Set the cutoff date.
3. Run **Collect**.
4. Wait until the cutoff is reached.
5. Confirm `unresolved: 0` and `image-risk: 0`.
6. Export the JSON archive.
7. Use the WordPress plugin in `../wordpress-plugin/` for the actual import.

Do not use the legacy WordPress REST import buttons from the collector for the recommended workflow.

## Generic behavior

- Runs on Facebook Pages instead of one hard-coded Page URL.
- Post author/root checks use the author shown in each post rather than a hard-coded Page name.
- Facebook permalink detection accepts normal Page post/photo/video/reel URL shapes.
- Collector state is isolated per Facebook Page and per collector version.
- Export filenames use the current Page context instead of a client-specific prefix.
- The legacy direct WordPress REST importer, if used, asks for the WordPress site URL instead of using a hard-coded domain.

## Collector rules

- Publication dates are read only from Facebook's structural timestamp/permalink context; dates written in the post body are never used as the publication date.
- Unknown exact time uses local 00:00.
- First line or first sentence, whichever ends first, is the title rule used by the importer.
- `textFingerprint` is diagnostic only, never the normal identity key.
- Exact full text is used only for the narrow unresolved-snapshot repair rule: exactly one dated match and an identity-less unresolved snapshot.
- A post with more than 20 collected images is considered an image-scope anomaly and is blocked from import.
- Each collector release uses its own isolated state; no previous-version state migration is performed.
