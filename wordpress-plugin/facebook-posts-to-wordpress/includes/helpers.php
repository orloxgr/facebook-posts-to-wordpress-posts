<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_admin_capability() {
    return 'manage_options';
}

function fbwp_normalize_text_key($value) {
    $value = wp_strip_all_tags((string) $value);
    $value = remove_accents($value);
    $value = function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
    $value = preg_replace('/\s+/u', ' ', $value);
    return trim((string) $value);
}

function fbwp_real_source_id($post) {
    $id = isset($post['id']) ? (string) $post['id'] : '';
    if ($id !== '' && strpos($id, 'fp-') !== 0) {
        return $id;
    }

    $permalink = isset($post['permalink']) ? (string) $post['permalink'] : '';
    if ($permalink && preg_match('/(?:fbid=|\/posts\/|\/videos\/|\/reel\/)(\d+)/', $permalink, $m)) {
        return $m[1];
    }

    return '';
}

function fbwp_archive_identity_key($post) {
    $source_id = fbwp_real_source_id($post);
    if ($source_id !== '') {
        return 'id:' . $source_id;
    }

    $archive_key = isset($post['archiveKey']) ? trim((string) $post['archiveKey']) : '';
    if ($archive_key !== '') {
        return 'key:' . $archive_key;
    }

    $fingerprint = isset($post['fingerprint']) ? trim((string) $post['fingerprint']) : '';
    if ($fingerprint !== '') {
        return 'fp:' . $fingerprint;
    }

    return '';
}

function fbwp_get_or_create_category($name) {
    $name = trim((string) $name);
    if ($name === '') {
        return new WP_Error('category_missing', 'Category name is required.');
    }

    $term = get_term_by('name', $name, 'category');
    if ($term && !is_wp_error($term)) {
        return (int) $term->term_id;
    }

    $created = wp_insert_term($name, 'category');
    if (is_wp_error($created)) {
        return $created;
    }

    return (int) $created['term_id'];
}

function fbwp_title_from_text($text, $date_iso) {
    $raw = str_replace(array("\r\n", "\r"), "\n", (string) $text);
    $raw = preg_replace('~https?://\S+~u', '', $raw);
    $raw = ltrim((string) $raw);

    if ($raw === '') {
        $ts = strtotime((string) $date_iso) ?: time();
        return 'Facebook ' . wp_date('d/m/Y', $ts, wp_timezone());
    }

    $newline_pos = strpos($raw, "\n");
    $end = ($newline_pos === false) ? strlen($raw) : $newline_pos;

    if (preg_match('/[.!;;?](?=\s|$)/u', $raw, $m, PREG_OFFSET_CAPTURE)) {
        $sentence_pos = $m[0][1];
        if ($sentence_pos < $end) {
            $end = $sentence_pos;
        }
    }

    $title = substr($raw, 0, $end);
    $title = preg_replace('/\s+/u', ' ', (string) $title);
    $title = preg_replace('/[.!;;?]+$/u', '', (string) $title);
    $title = trim((string) $title);

    if ($title !== '') {
        return $title;
    }

    foreach (preg_split('/\R/u', $raw) as $line) {
        $line = trim(preg_replace('/\s+/u', ' ', (string) $line));
        if ($line !== '') {
            return preg_replace('/[.!;;?]+$/u', '', $line);
        }
    }

    return 'Facebook post';
}

function fbwp_extract_hashtags($text) {
    $tags = array();
    $seen = array();

    if (preg_match_all('/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/u', (string) $text, $matches)) {
        foreach ($matches[1] as $tag) {
            $tag = trim((string) $tag);
            if ($tag === '') {
                continue;
            }

            $key = fbwp_normalize_text_key($tag);
            if ($key === '' || isset($seen[$key])) {
                continue;
            }

            $seen[$key] = true;
            $tags[] = $tag;
        }
    }

    return $tags;
}

function fbwp_slug_for_post($post) {
    $date_iso = isset($post['dateIso']) ? trim((string) $post['dateIso']) : '';
    $ts = $date_iso !== '' ? strtotime($date_iso) : false;

    if ($ts) {
        $date_prefix = wp_date('Ymd', $ts, wp_timezone());
    } else {
        $date_prefix = wp_date('Ymd', time(), wp_timezone());
    }

    $title = fbwp_title_from_text(
        isset($post['text']) ? (string) $post['text'] : '',
        $date_iso
    );

    $title_slug = sanitize_title($title);
    if ($title_slug === '') {
        $source_id = fbwp_real_source_id($post);
        if ($source_id !== '') {
            $title_slug = 'facebook-' . $source_id;
        } else {
            $fingerprint = isset($post['fingerprint']) ? (string) $post['fingerprint'] : '';
            if ($fingerprint === '' && isset($post['archiveKey'])) {
                $fingerprint = (string) $post['archiveKey'];
            }
            if ($fingerprint === '') {
                $fingerprint = md5((string) ($post['text'] ?? '') . '|' . $date_iso);
            }
            $title_slug = 'facebook-' . preg_replace('/[^a-zA-Z0-9_-]/', '-', $fingerprint);
        }
    }

    return sanitize_title($date_prefix . '-' . $title_slug);
}

function fbwp_date_parts($date_iso) {
    $ts = strtotime((string) $date_iso);
    if (!$ts) {
        return new WP_Error('bad_date', 'Invalid source date.');
    }

    $local = wp_date('Y-m-d H:i:s', $ts, wp_timezone());
    return array('local' => $local, 'gmt' => get_gmt_from_date($local));
}

function fbwp_strip_trailing_hashtag_block($text) {
    $text = str_replace(array("\r\n", "\r"), "\n", (string) $text);
    $lines = preg_split('/\n/u', rtrim($text));

    if (!is_array($lines)) {
        return rtrim($text);
    }

    while (!empty($lines)) {
        $line = trim((string) end($lines));

        if ($line === '') {
            array_pop($lines);
            continue;
        }

        if (preg_match('/^(?:#[\p{L}\p{N}_]+(?:\s+|$))+$/u', $line)) {
            array_pop($lines);
            continue;
        }

        break;
    }

    return rtrim(implode("\n", $lines));
}

function fbwp_text_to_content($text) {
    $clean_text = fbwp_strip_trailing_hashtag_block($text);
    return wpautop(make_clickable(esc_html($clean_text)));
}
