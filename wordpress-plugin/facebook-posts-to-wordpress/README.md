# Facebook Posts to WordPress Posts — WordPress plugin

Temporary one-time importer for JSON archives produced by the companion Tampermonkey collector.

## Install

1. Copy `facebook-posts-to-wordpress` into `wp-content/plugins/`.
2. Activate **Facebook Posts to WordPress Posts**.
3. Go to **Tools → Facebook Posts Import**.
4. Upload the exported JSON and click **Validate JSON**.
5. Run **Import 1** first and verify the WordPress post.
6. If everything is correct, run **Import ALL**.
7. Deactivate and remove the plugin after the migration is complete.

## Import behavior

- Preserves the source Facebook publication date/time from `dateIso`.
- Uses the first line or first sentence, whichever ends first, as the WordPress title.
- Uses the slug format `YYYYMMDD-title` based on the source post date and generated title.
- Preserves the Facebook body text without adding internal importer comments to the post content.
- Extracts hashtags and assigns them as WordPress tags.
- Removes the trailing hashtag-only block from the visible post content after converting those hashtags to WordPress tags.
- Also adds the source publication year as a WordPress tag, e.g. `2026`.
- Imports all collected images into the Media Library.
- The first imported image is always the featured image and is not repeated inside the post content.
- With 1 source image: featured image only; no image is appended to the post body.
- With 2 source images: first is featured, second is appended as a normal image below the text.
- With 3 or more source images: first is featured, all remaining images are appended below the text as a WordPress gallery.
- Imported galleries use a maximum of 3 columns/images per row.
- Body images and gallery images have WordPress core lightbox (Expand on click) enabled.
- Uses the selected category and post status.
- Imports oldest → newest.
- Uses Facebook ID / archive identity metadata stored in post meta for duplicate protection.
- Stops on import errors and rolls back a partially imported post.
- Blocks archives with unresolved dates, duplicate identities, or more than 20 images in a single post.

## Overwrite existing imports

Enable **Overwrite existing imported posts** when the same Facebook archive has already been imported and you want to refresh the existing WordPress posts instead of skipping them.

- Matching is still based only on Facebook source ID, archive key, or fingerprint metadata — never on the generated slug.
- The existing WordPress post ID is kept.
- Title, slug, content, date, category, tags, featured image, and imported gallery/body images are refreshed from the JSON.
- Previously imported images used by that post are removed only after the replacement succeeds.
- If an overwrite fails, the existing post is restored and newly downloaded replacement images are removed.
- Leave the checkbox unchecked for the normal skip-existing behavior.

For the current image-quality repair, you can reuse the already exported JSON. The importer first tries a higher-resolution Facebook CDN rendition by removing the feed-only `ctp` resize parameter from the signed image URL. If that candidate is unavailable, it automatically falls back to the original URL stored in the JSON. The import log reports the downloaded featured-image dimensions, for example `featured=1080x1350`.

## Notes

Facebook CDN image URLs are signed and can expire. Import or overwrite from the JSON as soon as practical after collection.
