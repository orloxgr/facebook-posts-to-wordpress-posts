<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_image_candidate_urls($image) {
    $urls = array();

    if (!empty($image['highResUrl'])) {
        $urls[] = esc_url_raw((string) $image['highResUrl']);
    }

    $url = isset($image['url']) ? esc_url_raw((string) $image['url']) : '';
    if ($url !== '') {
        /*
         * Facebook feed images commonly carry ctp=s640x640 even when the
         * same signed CDN URL advertises a larger cstp limit. Try the same
         * signed URL without the client thumbnail transform first.
         */
        if (preg_match('/fbcdn\.net/i', $url) && preg_match('/[?&]ctp=/i', $url)) {
            $high = remove_query_arg('ctp', $url);
            if ($high !== '' && $high !== $url) {
                $urls[] = esc_url_raw($high);
            }
        }
        $urls[] = $url;
    }

    if (!empty($image['fallbackUrl'])) {
        $urls[] = esc_url_raw((string) $image['fallbackUrl']);
    }

    return array_values(array_unique(array_filter($urls)));
}

function fbwp_extension_from_image_info($info, $url) {
    $mime = isset($info['mime']) ? strtolower((string) $info['mime']) : '';
    $map = array(
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/gif' => 'gif',
        'image/webp' => 'webp',
        'image/avif' => 'avif',
    );
    if (isset($map[$mime])) {
        return $map[$mime];
    }

    $path = wp_parse_url((string) $url, PHP_URL_PATH);
    if ($path && preg_match('/\.(jpe?g|png|gif|webp|avif)$/i', $path, $m)) {
        return strtolower($m[1] === 'jpeg' ? 'jpg' : $m[1]);
    }

    return 'jpg';
}

function fbwp_download_image_candidate($image, $image_number) {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $urls = fbwp_image_candidate_urls($image);
    if (empty($urls)) {
        return new WP_Error('missing_image_url', 'Image #' . $image_number . ' has no URL.');
    }

    $errors = array();
    foreach ($urls as $url) {
        $tmp = download_url($url, 60);
        if (is_wp_error($tmp)) {
            $errors[] = $tmp->get_error_message();
            continue;
        }

        $info = wp_getimagesize($tmp);
        if (!$info || empty($info[0]) || empty($info[1])) {
            @unlink($tmp);
            $errors[] = 'Downloaded file is not a valid image.';
            continue;
        }

        return array(
            'tmp' => $tmp,
            'url' => $url,
            'width' => (int) $info[0],
            'height' => (int) $info[1],
            'mime' => isset($info['mime']) ? (string) $info['mime'] : '',
            'ext' => fbwp_extension_from_image_info($info, $url),
        );
    }

    return new WP_Error(
        'image_download_failed',
        'Image #' . $image_number . ' failed: ' . implode(' | ', array_unique($errors))
    );
}

function fbwp_sideload_media($post_id, $images) {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $media_ids = array();

    foreach ($images as $i => $image) {
        $image_number = $i + 1;
        $alt = isset($image['alt']) ? sanitize_text_field((string) $image['alt']) : '';
        if ($alt === 'No photo description available.' || $alt === 'May be an image of text') {
            $alt = '';
        }

        $download = fbwp_download_image_candidate($image, $image_number);
        if (is_wp_error($download)) {
            foreach ($media_ids as $media_id) {
                wp_delete_attachment((int) $media_id, true);
            }
            return $download;
        }

        $file_array = array(
            'name' => sprintf('facebook-%d-%02d.%s', (int) $post_id, $image_number, $download['ext']),
            'tmp_name' => $download['tmp'],
        );

        $media_id = media_handle_sideload($file_array, $post_id, $alt);
        if (is_wp_error($media_id)) {
            @unlink($download['tmp']);
            foreach ($media_ids as $created_id) {
                wp_delete_attachment((int) $created_id, true);
            }
            return new WP_Error(
                'image_import_failed',
                'Image #' . $image_number . ' failed: ' . $media_id->get_error_message()
            );
        }

        $media_id = (int) $media_id;
        if ($alt !== '') {
            update_post_meta($media_id, '_wp_attachment_image_alt', $alt);
        }
        update_post_meta($media_id, '_fbwp_imported_media', 1);
        update_post_meta($media_id, '_fbwp_source_image_url', esc_url_raw($download['url']));
        update_post_meta($media_id, '_fbwp_source_image_width', (int) $download['width']);
        update_post_meta($media_id, '_fbwp_source_image_height', (int) $download['height']);

        $media_ids[] = $media_id;
    }

    return $media_ids;
}

function fbwp_existing_import_media_ids($post_id) {
    $candidate_ids = array();

    $thumb_id = (int) get_post_thumbnail_id($post_id);
    if ($thumb_id > 0) {
        $candidate_ids[] = $thumb_id;
    }

    $content = (string) get_post_field('post_content', $post_id);
    if ($content !== '') {
        if (preg_match_all('/"id"\s*:\s*(\d+)/', $content, $matches)) {
            $candidate_ids = array_merge($candidate_ids, array_map('intval', $matches[1]));
        }
        if (preg_match_all('/wp-image-(\d+)/', $content, $matches)) {
            $candidate_ids = array_merge($candidate_ids, array_map('intval', $matches[1]));
        }
    }

    $ids = array();
    foreach (array_unique(array_filter(array_map('intval', $candidate_ids))) as $media_id) {
        $attachment = get_post($media_id);
        if (!$attachment instanceof WP_Post || $attachment->post_type !== 'attachment') {
            continue;
        }

        /*
         * v1.0.4/v1.0.5 media are children of the imported post. Newer
         * versions are also explicitly marked. This avoids deleting a
         * manually inserted attachment that merely appears in the content.
         */
        if ((int) $attachment->post_parent === (int) $post_id || get_post_meta($media_id, '_fbwp_imported_media', true)) {
            $ids[] = $media_id;
        }
    }

    return array_values(array_unique($ids));
}

function fbwp_delete_media_ids($media_ids, $keep_ids = array()) {
    $keep = array_fill_keys(array_map('intval', $keep_ids), true);
    foreach (array_unique(array_map('intval', $media_ids)) as $media_id) {
        if ($media_id <= 0 || isset($keep[$media_id])) {
            continue;
        }
        if (get_post_type($media_id) === 'attachment') {
            wp_delete_attachment($media_id, true);
        }
    }
}

function fbwp_featured_source_size($media_ids) {
    if (empty($media_ids)) {
        return '';
    }

    $media_id = (int) reset($media_ids);
    $width = (int) get_post_meta($media_id, '_fbwp_source_image_width', true);
    $height = (int) get_post_meta($media_id, '_fbwp_source_image_height', true);

    if ($width <= 0 || $height <= 0) {
        $meta = wp_get_attachment_metadata($media_id);
        if (is_array($meta)) {
            $width = isset($meta['width']) ? (int) $meta['width'] : 0;
            $height = isset($meta['height']) ? (int) $meta['height'] : 0;
        }
    }

    return ($width > 0 && $height > 0) ? ($width . 'x' . $height) : '';
}

function fbwp_render_single_content_image($media_id) {
    $media_id = (int) $media_id;
    $image_html = wp_get_attachment_image(
        $media_id,
        'large',
        false,
        array('loading' => 'lazy', 'decoding' => 'async')
    );

    if (!$image_html) {
        return '';
    }

    return "\n<!-- wp:image {\"id\":" . $media_id . ",\"sizeSlug\":\"large\",\"linkDestination\":\"none\",\"lightbox\":{\"enabled\":true}} -->\n" .
        '<figure class="wp-block-image size-large">' . $image_html . "</figure>\n" .
        "<!-- /wp:image -->\n";
}

function fbwp_render_content_gallery($media_ids) {
    $media_ids = array_values(array_map('intval', $media_ids));
    if (count($media_ids) < 2) {
        return '';
    }

    $html = "\n<!-- wp:gallery {\"columns\":3,\"linkTo\":\"none\"} -->\n";
    $html .= '<figure class="wp-block-gallery has-nested-images columns-3 is-cropped">' . "\n";

    foreach ($media_ids as $media_id) {
        $image_html = wp_get_attachment_image(
            $media_id,
            'large',
            false,
            array('loading' => 'lazy', 'decoding' => 'async')
        );

        if (!$image_html) {
            continue;
        }

        $html .= "<!-- wp:image {\"id\":" . $media_id . ",\"sizeSlug\":\"large\",\"linkDestination\":\"none\",\"lightbox\":{\"enabled\":true}} -->\n";
        $html .= '<figure class="wp-block-image size-large">' . $image_html . "</figure>\n";
        $html .= "<!-- /wp:image -->\n";
    }

    $html .= "</figure>\n<!-- /wp:gallery -->\n";
    return $html;
}

function fbwp_build_content($post, $media_ids) {
    $content = fbwp_text_to_content(isset($post['text']) ? $post['text'] : '');

    /* Image #1 is featured-only. */
    $content_media_ids = array_values(array_slice($media_ids, 1));
    $content_image_count = count($content_media_ids);

    if ($content_image_count === 1) {
        $content .= fbwp_render_single_content_image($content_media_ids[0]);
    } elseif ($content_image_count >= 2) {
        $content .= fbwp_render_content_gallery($content_media_ids);
    }

    return $content;
}
