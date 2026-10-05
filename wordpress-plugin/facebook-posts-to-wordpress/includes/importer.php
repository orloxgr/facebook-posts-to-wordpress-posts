<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_find_existing_post($post) {
    $meta_query = array('relation' => 'OR');
    $source_id = fbwp_real_source_id($post);
    if ($source_id !== '') {
        $meta_query[] = array('key' => '_fbwp_source_id', 'value' => $source_id);
    }

    $archive_key = isset($post['archiveKey']) ? trim((string) $post['archiveKey']) : '';
    if ($archive_key !== '') {
        $meta_query[] = array('key' => '_fbwp_archive_key', 'value' => $archive_key);
    }

    $fingerprint = isset($post['fingerprint']) ? trim((string) $post['fingerprint']) : '';
    if ($fingerprint !== '') {
        $meta_query[] = array('key' => '_fbwp_fingerprint', 'value' => $fingerprint);
    }

    if (count($meta_query) > 1) {
        $query = new WP_Query(array(
            'post_type' => 'post',
            'post_status' => 'any',
            'fields' => 'ids',
            'posts_per_page' => 1,
            'meta_query' => $meta_query,
            'no_found_rows' => true,
        ));
        if (!empty($query->posts)) {
            return (int) $query->posts[0];
        }
    }

    $slug = fbwp_slug_for_post($post);
    if ($slug !== '') {
        $existing = get_page_by_path($slug, OBJECT, 'post');
        if ($existing instanceof WP_Post) {
            return (int) $existing->ID;
        }
    }
    return 0;
}

function fbwp_import_one_record($post, $category_name, $status) {
    $date_iso = isset($post['dateIso']) ? trim((string) $post['dateIso']) : '';
    if ($date_iso === '' || strtotime($date_iso) === false) {
        return new WP_Error('unresolved_date', 'Post has no safe date.');
    }

    $images = isset($post['images']) && is_array($post['images']) ? $post['images'] : array();
    if (count($images) > FBWP_MAX_IMAGES_PER_POST) {
        return new WP_Error('image_safety', 'Post exceeds the image safety limit.');
    }

    $existing_id = fbwp_find_existing_post($post);
    if ($existing_id) {
        return array(
            'result' => 'skipped',
            'postId' => $existing_id,
            'editUrl' => get_edit_post_link($existing_id, 'raw'),
            'title' => get_the_title($existing_id),
            'images' => 0,
            'tags' => 0,
        );
    }

    $category_id = fbwp_get_or_create_category($category_name);
    if (is_wp_error($category_id)) {
        return $category_id;
    }
    $date = fbwp_date_parts($date_iso);
    if (is_wp_error($date)) {
        return $date;
    }

    $title = fbwp_title_from_text(isset($post['text']) ? $post['text'] : '', $date_iso);
    $tags = fbwp_extract_hashtags(isset($post['text']) ? $post['text'] : '');

    $source_ts = strtotime($date_iso);
    $year_tag = $source_ts ? wp_date('Y', $source_ts, wp_timezone()) : '';
    if ($year_tag !== '' && !in_array($year_tag, $tags, true)) {
        $tags[] = $year_tag;
    }

    $post_id = wp_insert_post(array(
        'post_type' => 'post',
        'post_status' => 'draft',
        'post_title' => wp_strip_all_tags($title),
        'post_name' => fbwp_slug_for_post($post),
        'post_content' => '',
        'post_date' => $date['local'],
        'post_date_gmt' => $date['gmt'],
        'post_category' => array((int) $category_id),
    ), true);
    if (is_wp_error($post_id)) {
        return $post_id;
    }

    $media_ids = array();
    try {
        $media_ids = fbwp_sideload_media($post_id, $images);
        if (is_wp_error($media_ids)) {
            throw new Exception($media_ids->get_error_message());
        }

        $updated = wp_update_post(array(
            'ID' => $post_id,
            'post_content' => fbwp_build_content($post, $media_ids),
            'post_status' => ($status === 'draft') ? 'draft' : 'publish',
            'post_date' => $date['local'],
            'post_date_gmt' => $date['gmt'],
        ), true);
        if (is_wp_error($updated)) {
            throw new Exception($updated->get_error_message());
        }

        if (!empty($tags)) {
            $tag_result = wp_set_post_tags($post_id, $tags, false);
            if (is_wp_error($tag_result)) {
                throw new Exception('Tags failed: ' . $tag_result->get_error_message());
            }
        }
        if (!empty($media_ids)) {
            set_post_thumbnail($post_id, (int) $media_ids[0]);
        }

        $source_id = fbwp_real_source_id($post);
        if ($source_id !== '') {
            update_post_meta($post_id, '_fbwp_source_id', $source_id);
        }
        if (!empty($post['archiveKey'])) {
            update_post_meta($post_id, '_fbwp_archive_key', sanitize_text_field((string) $post['archiveKey']));
        }
        if (!empty($post['fingerprint'])) {
            update_post_meta($post_id, '_fbwp_fingerprint', sanitize_text_field((string) $post['fingerprint']));
        }
        if (!empty($post['permalink'])) {
            update_post_meta($post_id, '_fbwp_source_permalink', esc_url_raw((string) $post['permalink']));
        }
        update_post_meta($post_id, '_fbwp_imported_at', current_time('mysql'));

        return array(
            'result' => 'imported',
            'postId' => (int) $post_id,
            'editUrl' => get_edit_post_link($post_id, 'raw'),
            'title' => $title,
            'images' => count($media_ids),
            'tags' => count($tags),
        );
    } catch (Throwable $e) {
        foreach ($media_ids as $media_id) {
            wp_delete_attachment((int) $media_id, true);
        }
        wp_delete_post((int) $post_id, true);
        return new WP_Error('import_failed', $e->getMessage());
    }
}
