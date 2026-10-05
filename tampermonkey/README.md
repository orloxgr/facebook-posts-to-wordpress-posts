# Tampermonkey collector

Current collector: **v1.4.6**.

## Install

Install `facebook-posts-to-wordpress.user.js` in Tampermonkey and open:

`https://www.facebook.com/dimos.alonnisou`

The small userscript loader reconstructs the exact tested v1.4.6 collector from the versioned payload files in `payload/` and verifies its SHA-256 before running it.

Expected collector source SHA-256:

`c934e99d176afcdba464720919dbbc8a7198ca6edeb58d04399212101fa05b98`

## Workflow

1. Set the cutoff date.
2. Run **Collect**.
3. Wait until the cutoff is reached.
4. Confirm `unresolved: 0` and `image-risk: 0`.
5. Export the JSON archive.
6. Use the WordPress plugin in `../wordpress-plugin/` for the actual import.

Do not use the legacy WordPress REST import buttons from the collector for the current workflow.

## Collector rules

- Publication dates are read only from Facebook's structural timestamp/permalink context; dates written in the post body are never used as the publication date.
- Unknown exact time uses local 00:00.
- First line or first sentence, whichever ends first, is the title rule used by the importer.
- `textFingerprint` is diagnostic only, never the normal identity key.
- Exact full text is used only for the narrow unresolved-snapshot repair rule: exactly one dated match and an identity-less unresolved snapshot.
- A post with more than 20 collected images is considered an image-scope anomaly and is blocked from import.
- Each collector release uses its own isolated state; no previous-version state migration is performed.
