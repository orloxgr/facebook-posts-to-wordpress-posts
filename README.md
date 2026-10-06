# Facebook Posts to WordPress Posts

One-time migration workflow for collecting Facebook Page posts in the browser and importing them into WordPress.

The project is generic: it is not tied to one Facebook Page or one WordPress site.

## Directories

### `tampermonkey/`

Contains the browser collector. Current collector: **v1.4.7**.

For the current workflow:

1. Open any Facebook Page you want to migrate.
2. Set the cutoff date.
3. Run **Collect**.
4. Confirm there are no unresolved posts or image-risk records.
5. **Export JSON**.

Collector state is isolated per Facebook Page and per collector version. It does not migrate state from older versions.

### `wordpress-plugin/`

Contains the temporary WordPress importer plugin.

Use the WordPress plugin for the actual import instead of the Tampermonkey REST importer. This keeps the migration inside WordPress Admin and works with any WordPress installation where you can install the plugin.

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
- Full post text is preserved except for a trailing hashtag-only block, which is converted to WordPress tags.
- The first image becomes the featured image and is not duplicated in the post body.
- With two source images, the second image is inserted below the text.
- With three or more source images, all images after the featured image are inserted as a WordPress gallery.
- Galleries use a maximum of three columns and WordPress core lightbox support.
- Hashtags are mapped to WordPress tags; inline hashtags remain in the post text.
- The publication year is also added as a WordPress tag.
- Title is the first line or the first sentence, whichever ends first; terminal `. ! ; ; ?` is removed.
- Duplicate detection does not use `textFingerprint` as identity.
- Exact full text is used only by the collector's narrow unresolved-snapshot repair rule.
- Image safety limit: 20 images per post.
