# Facebook Posts to WordPress Posts

One-time migration workflow for collecting Facebook Page posts in the browser and importing them into WordPress.

## Directories

### `tampermonkey/`

Contains the browser collector. Current collector: **v1.4.6**.

For the current workflow, use it to:

1. Open the Facebook Page.
2. Set the cutoff date.
3. Run **Collect**.
4. Confirm there are no unresolved posts or image-risk records.
5. **Export JSON**.

The collector keeps a fresh isolated state per version and does not migrate state from older versions.

### `wordpress-plugin/`

Contains the temporary WordPress importer plugin.

Use the WordPress plugin for the actual import instead of the Tampermonkey REST importer. This avoids Application Password prompts and keeps the migration inside WordPress Admin.

## Recommended workflow

1. Collect and export the Facebook archive with Tampermonkey.
2. Install the WordPress plugin.
3. Go to **Tools → Facebook Posts Import**.
4. Upload and validate the JSON.
5. Run **Import 1**.
6. Verify title, original date/time, category, text, featured image, content images and tags.
7. Run **Import ALL**.
8. Remove the temporary importer plugin when finished.

## Current migration rules

- Never infer publication dates from dates written inside the post text.
- If Facebook exposes a date but no exact time, the collector uses local `00:00`.
- Full post text is preserved.
- First image becomes the featured image.
- Imported images are also inserted into the post content.
- Hashtags are mapped to WordPress tags and remain in the post text.
- Title is the first line or the first sentence, whichever ends first; terminal `. ! ; ; ?` is removed.
- Duplicate detection does not use `textFingerprint` as identity.
- Exact full text is used only by the collector's narrow unresolved-snapshot repair rule.
- Image safety limit: 20 images per post.
