# Changelog

## 1.0.5

- Stop using the generated slug as duplicate identity.
- Allow distinct Facebook posts that share the same date and generated title to import separately.
- Keep duplicate protection based on Facebook source ID, archive key, and fingerprint metadata.
- Let WordPress make a colliding slug unique automatically (for example by appending `-2`).

## 1.0.4

- Limit imported galleries to a maximum of three columns/images per row.
- Enable WordPress core Image block lightbox (Expand on click) for imported body and gallery images.
- Preserve gallery lightbox navigation behavior provided by the active WordPress core version.

## 1.0.3

- Reserve the first imported image for featured image only; it is no longer duplicated inside post content.
- With two source images, only the second image appears below the text.
- With three or more source images, all images after the featured image are rendered as a WordPress gallery.
