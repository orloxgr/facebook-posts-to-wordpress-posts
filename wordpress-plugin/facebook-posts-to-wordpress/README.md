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
- Uses the selected category and post status.
- Imports oldest → newest.
- Uses Facebook ID / archive identity metadata stored in post meta for duplicate protection.
- Stops on import errors and rolls back a partially imported post.
- Blocks archives with unresolved dates, duplicate identities, or more than 20 images in a single post.

## Notes

Facebook CDN image URLs are signed and can expire. Import the JSON as soon as practical after collection.
