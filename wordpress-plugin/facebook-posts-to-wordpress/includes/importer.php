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

    /* Never use the generated slug as duplicate identity. */
    return 0;
}

function fbwp_snapshot_post($post_id) {
    $post = get_post($post_id);
    if (!$post instanceof WP_Post) {
        return null;
    }

    return array(
        'post_title' => $post->post_title,
        'post_name' => $post->post_name,
        'post_content' => $post->post_content,
        'post_status' => $post->post_status,
        'post_date' => $post->post_date,
        'post_date_gmt' => $post->post_date_gmt,
        'categories' => wp_get_post_categories($post_id, array('fields' => 'ids')),
        'tags' => wp_get_post_tags($post_id, array('fields' => 'ids')),
        'thumbnail' => (int) get_post_thumbnail_id($post_id),
    );
}

function fbwp_restore_post_snapshot($post_id, $snapshot) {
    if (!is_array($snapshot)) {
        return;
    }

    wp_update_post(array(
        'ID' => (int) $post_id,
        'post_title' => $snapshot['post_title'],
        'post_name' => $snapshot['post_name'],
        'post_content' => $snapshot['post_content'],
        'post_status' => $snapshot['post_status'],
        'post_date' => $snapshot['post_date'],
        'post_date_gmt' => $snapshot['post_date_gmt'],
        'post_category' => array_map('intval', (array) $snapshot['categories']),
    ));

    wp_set_post_terms($post_id, array_map('intval', (array) $snapshot['tags']), 'post_tag', false);

    if (!empty($snapshot['thumbnail'])) {
        set_post_thumbnail($post_id, (int) $snapshot['thumbnail']);
    } else {
        delete_post_thumbnail($post_id);
    }
}

function fbwp_import_one_record($post, $category_name, $status, $overwrite = false) {
    $date_iso = isset($post['dateIso']) ? trim((string) $post['dateIso']) : '';
    if ($date_iso === '' || strtotime($date_iso) === false) {
        return new WP_Error('unresolved_date', 'Post has no safe date.');
    }

    $images = isset($post['images']) && is_array($post['images']) ? $post['images'] : array();
    if (count($images) > FBWP_MAX_IMAGES_PER_POST) {
        return new WP_Error('image_safety', 'Post exceeds the image safety limit.');
    }

    $existing_id = fbwp_find_existing_post($post);
    if ($existing_id && !$overwrite) {
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

    $is_overwrite = $existing_id > 0 && $overwrite;
    $snapshot = $is_overwrite ? fbwp_snapshot_post($existing_id) : null;
    $old_media_ids = $is_overwrite ? fbwp_existing_import_media_ids($existing_id) : array();

    if ($is_overwrite) {
        $post_id = (int) $existing_id;
    } else {
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
    }

    $media_ids = array();

    try {
        $media_ids = fbwp_sideload_media($post_id, $images);
        if (is_wp_error($media_ids)) {
            $media_error = $media_ids;
            $media_ids = array();
            throw new Exception($media_error->get_error_message());
        }

        $updated = wp_update_post(array(
            'ID' => $post_id,
            'post_title' => wp_strip_all_tags($title),
            'post_name' => fbwp_slug_for_post($post),
            'post_content' => fbwp_build_content($post, $media_ids),
            'post_status' => ($status === 'draft') ? 'draft' : 'publish',
            'post_date' => $date['local'],
            'post_date_gmt' => $date['gmt'],
            'post_category' => array((int) $category_id),
        ), true);
        if (is_wp_error($updated)) {
            throw new Exception($updated->get_error_message());
        }

        $tag_result = wp_set_post_tags($post_id, $tags, false);
        if (is_wp_error($tag_result)) {
            throw new Exception('Tags failed: ' . $tag_result->get_error_message());
        }

        if (!empty($media_ids)) {
            if (!set_post_thumbnail($post_id, (int) $media_ids[0])) {
                throw new Exception('Featured image could not be set.');
            }
        } else {
            delete_post_thumbnail($post_id);
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
        update_post_meta($post_id, '_fbwp_import_version', FBWP_VERSION);

        if ($is_overwrite) {
            fbwp_delete_media_ids($old_media_ids, $media_ids);
        }

        return array(
            'result' => $is_overwrite ? 'overwritten' : 'imported',
            'postId' => (int) $post_id,
            'editUrl' => get_edit_post_link($post_id, 'raw'),
            'title' => $title,
            'images' => count($media_ids),
            'tags' => count($tags),
        );
    } catch (Throwable $e) {
        fbwp_delete_media_ids($media_ids);

        if ($is_overwrite) {
            fbwp_restore_post_snapshot($post_id, $snapshot);
        } else {
            wp_delete_post((int) $post_id, true);
        }

        return new WP_Error('import_failed', $e->getMessage());
    }
}
