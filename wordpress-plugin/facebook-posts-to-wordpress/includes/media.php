<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_sideload_media($post_id, $images) {
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';

    $media_ids = array();
    foreach ($images as $i => $image) {
        $url = isset($image['url']) ? esc_url_raw((string) $image['url']) : '';
        if ($url === '') {
            return new WP_Error('missing_image_url', 'Image #' . ($i + 1) . ' has no URL.');
        }

        $alt = isset($image['alt']) ? sanitize_text_field((string) $image['alt']) : '';
        if ($alt === 'No photo description available.' || $alt === 'May be an image of text') {
            $alt = '';
        }

        $media_id = media_sideload_image($url, $post_id, $alt, 'id');
        if (is_wp_error($media_id)) {
            return new WP_Error('image_import_failed', 'Image #' . ($i + 1) . ' failed: ' . $media_id->get_error_message());
        }

        $media_id = (int) $media_id;
        if ($alt !== '') {
            update_post_meta($media_id, '_wp_attachment_image_alt', $alt);
        }
        $media_ids[] = $media_id;
    }

    return $media_ids;
}

function fbwp_build_content($post, $media_ids) {
    $content = fbwp_text_to_content(isset($post['text']) ? $post['text'] : '');

    foreach ($media_ids as $media_id) {
        $image_html = wp_get_attachment_image($media_id, 'large', false, array('loading' => 'lazy', 'decoding' => 'async'));
        if ($image_html) {
            $content .= "\n<figure class=\"wp-block-image size-large\">" . $image_html . "</figure>\n";
        }
    }

    return $content;
}
