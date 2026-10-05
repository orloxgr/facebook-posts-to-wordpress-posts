<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_validate_archive($decoded) {
    if (!is_array($decoded) || !isset($decoded['posts']) || !is_array($decoded['posts'])) {
        return new WP_Error('invalid_json_shape', 'JSON must contain a posts array.');
    }

    $seen_ids = array();
    $seen_keys = array();
    $dated = 0;
    $unresolved = 0;
    $image_risk = 0;
    $max_images = 0;
    $errors = array();

    foreach ($decoded['posts'] as $i => $post) {
        if (!is_array($post)) {
            $errors[] = 'Post #' . ($i + 1) . ': invalid record.';
            continue;
        }

        $date_iso = isset($post['dateIso']) ? trim((string) $post['dateIso']) : '';
        if ($date_iso === '' || strtotime($date_iso) === false) {
            $unresolved++;
            $errors[] = 'Post #' . ($i + 1) . ': unresolved/invalid date.';
        } else {
            $dated++;
        }

        $images = isset($post['images']) && is_array($post['images']) ? $post['images'] : array();
        $count = count($images);
        $max_images = max($max_images, $count);
        if ($count > FBWP_MAX_IMAGES_PER_POST) {
            $image_risk++;
            $errors[] = 'Post #' . ($i + 1) . ': ' . $count . ' images exceeds safety limit.';
        }

        $real_id = fbwp_real_source_id($post);
        if ($real_id !== '') {
            if (isset($seen_ids[$real_id])) {
                $errors[] = 'Duplicate Facebook ID: ' . $real_id;
            }
            $seen_ids[$real_id] = true;
        }

        $identity = fbwp_archive_identity_key($post);
        if ($identity !== '') {
            if (isset($seen_keys[$identity])) {
                $errors[] = 'Duplicate archive identity: ' . $identity;
            }
            $seen_keys[$identity] = true;
        }
    }

    $total = count($decoded['posts']);
    return array(
        'total' => $total,
        'dated' => $dated,
        'unresolved' => $unresolved,
        'imageRisk' => $image_risk,
        'maxImages' => $max_images,
        'errors' => array_values(array_unique($errors)),
        'valid' => empty($errors) && $dated === $total,
    );
}

function fbwp_session_dir() {
    $upload = wp_upload_dir();
    $dir = trailingslashit($upload['basedir']) . 'fbwp-import';
    if (!is_dir($dir)) {
        wp_mkdir_p($dir);
    }
    if (is_dir($dir)) {
        $index = trailingslashit($dir) . 'index.php';
        if (!file_exists($index)) {
            @file_put_contents($index, "<?php\n// Silence is golden.\n");
        }
    }
    return $dir;
}

function fbwp_session_transient_key($token) {
    return 'fbwp_' . preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $token);
}

function fbwp_session_file_path($token) {
    $token = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $token);
    return trailingslashit(fbwp_session_dir()) . 'session-' . $token . '.json';
}

function fbwp_store_session($decoded, $validation) {
    $token = wp_generate_password(32, false, false);
    $dir = fbwp_session_dir();
    if (!is_dir($dir) || !is_writable($dir)) {
        return new WP_Error('session_dir', 'Cannot write import session directory.');
    }

    foreach ($decoded['posts'] as $i => &$post) {
        if (is_array($post)) {
            $post['_fbwpOriginalOrder'] = $i;
        }
    }
    unset($post);

    usort($decoded['posts'], function ($a, $b) {
        $at = isset($a['dateIso']) ? strtotime((string) $a['dateIso']) : 0;
        $bt = isset($b['dateIso']) ? strtotime((string) $b['dateIso']) : 0;
        if ($at === $bt) {
            return ((int) ($a['_fbwpOriginalOrder'] ?? 0)) <=> ((int) ($b['_fbwpOriginalOrder'] ?? 0));
        }
        return $at <=> $bt;
    });

    $path = fbwp_session_file_path($token);
    $written = file_put_contents(
        $path,
        wp_json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT)
    );
    if ($written === false) {
        return new WP_Error('session_write', 'Could not save import session.');
    }

    set_transient(
        fbwp_session_transient_key($token),
        array('path' => $path, 'total' => $validation['total'], 'created' => time()),
        FBWP_SESSION_TTL
    );
    return $token;
}

function fbwp_get_session($token) {
    $token = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $token);
    if ($token === '') {
        return new WP_Error('missing_session', 'Missing import session.');
    }

    $key = fbwp_session_transient_key($token);
    $session = get_transient($key);

    if (!is_array($session) || empty($session['path'])) {
        $path = fbwp_session_file_path($token);
        if (!file_exists($path)) {
            return new WP_Error('expired_session', 'Import session expired. Upload the JSON again.');
        }
        $session = array(
            'path' => $path,
            'total' => 0,
            'created' => (int) @filemtime($path),
        );
    }

    if (empty($session['path']) || !file_exists($session['path'])) {
        return new WP_Error('expired_session', 'Import session expired. Upload the JSON again.');
    }

    $created = !empty($session['created']) ? (int) $session['created'] : (int) @filemtime($session['path']);
    if ($created > 0 && (time() - $created) > FBWP_SESSION_TTL) {
        @unlink($session['path']);
        delete_transient($key);
        return new WP_Error('expired_session', 'Import session expired. Upload the JSON again.');
    }

    $decoded = json_decode(file_get_contents($session['path']), true);
    if (!is_array($decoded) || !isset($decoded['posts']) || !is_array($decoded['posts'])) {
        return new WP_Error('bad_session', 'Stored import session is invalid.');
    }

    $session['total'] = count($decoded['posts']);
    if (empty($session['created'])) {
        $session['created'] = $created ?: time();
    }
    set_transient($key, $session, FBWP_SESSION_TTL);

    return array('meta' => $session, 'data' => $decoded);
}
