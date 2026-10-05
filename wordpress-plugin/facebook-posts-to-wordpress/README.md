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
- Preserves the full Facebook text.
- Extracts hashtags and assigns them as WordPress tags.
- Imports all collected images into the Media Library.
- Sets the first imported image as the featured image.
- Adds all imported images to the post content.
- Uses the selected category and post status.
- Imports oldest → newest.
- Uses Facebook ID / archive identity metadata and deterministic slugs for duplicate protection.
- Stops on import errors and rolls back a partially imported post.
- Blocks archives with unresolved dates, duplicate identities, or more than 20 images in a single post.

## Notes

Facebook CDN image URLs are signed and can expire. Import the JSON as soon as practical after collection.
