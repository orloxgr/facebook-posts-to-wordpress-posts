<?php
if (!defined('ABSPATH')) {
    exit;
}

function fbwp_admin_menu() {
    add_management_page(
        'Facebook Posts Import',
        'Facebook Posts Import',
        fbwp_admin_capability(),
        'facebook-posts-to-wordpress',
        'fbwp_render_admin_page'
    );
}
add_action('admin_menu', 'fbwp_admin_menu');

function fbwp_admin_assets($hook) {
    if ($hook !== 'tools_page_facebook-posts-to-wordpress') {
        return;
    }
    $base = plugin_dir_url(dirname(__DIR__) . '/facebook-posts-to-wordpress.php');
    wp_enqueue_style('fbwp-admin', $base . 'assets/admin.css', array(), FBWP_VERSION);
    wp_enqueue_script('fbwp-admin', $base . 'assets/admin.js', array(), FBWP_VERSION, true);
    wp_localize_script('fbwp-admin', 'FBWP_ADMIN', array(
        'ajaxUrl' => admin_url('admin-ajax.php'),
        'nonce' => wp_create_nonce('fbwp_admin'),
        'maxImagesPerPost' => FBWP_MAX_IMAGES_PER_POST,
    ));
}
add_action('admin_enqueue_scripts', 'fbwp_admin_assets');

function fbwp_render_admin_page() {
    if (!current_user_can(fbwp_admin_capability())) {
        wp_die(esc_html__('You do not have permission to access this page.', 'fbwp'));
    }
    ?>
    <div class="wrap fbwp-wrap">
        <h1>Facebook Posts → WordPress</h1>
        <p class="description">Upload the JSON exported by the Tampermonkey collector, validate it, test one post, then import the full archive.</p>
        <div class="fbwp-panel">
            <h2>1. JSON archive</h2>
            <input type="file" id="fbwp-json-file" accept="application/json,.json">
            <button type="button" class="button button-primary" id="fbwp-validate">Validate JSON</button>
            <button type="button" class="button" id="fbwp-clear-session">Clear session</button>
        </div>
        <div class="fbwp-panel">
            <h2>2. Import settings</h2>
            <table class="form-table" role="presentation">
                <tr><th><label for="fbwp-category">Category</label></th><td><input type="text" class="regular-text" id="fbwp-category" value="Δελτία Τύπου - Νέα - Ανακοινώσεις"></td></tr>
                <tr><th><label for="fbwp-status">Post status</label></th><td><select id="fbwp-status"><option value="publish" selected>Publish</option><option value="draft">Draft</option></select></td></tr>
                <tr><th>Existing posts</th><td><label><input type="checkbox" id="fbwp-overwrite" value="1"> Overwrite existing imported posts</label><p class="description">When enabled, matching posts are updated in place and their imported images are replaced. Leave unchecked to skip existing posts.</p></td></tr>
            </table>
        </div>
        <div class="fbwp-panel" id="fbwp-summary-panel" hidden><h2>3. Validation</h2><div class="fbwp-summary" id="fbwp-summary"></div></div>
        <div class="fbwp-panel" id="fbwp-import-panel" hidden>
            <h2>4. Import</h2>
            <p><button type="button" class="button" id="fbwp-import-one">Import 1</button> <button type="button" class="button button-primary" id="fbwp-import-all">Import ALL</button> <button type="button" class="button" id="fbwp-stop" disabled>Stop</button></p>
            <div class="fbwp-progress-wrap"><progress id="fbwp-progress" value="0" max="100"></progress><span id="fbwp-progress-text">0 / 0</span></div>
            <pre id="fbwp-log" aria-live="polite"></pre>
        </div>
    </div>
    <?php
}

function fbwp_ajax_guard() {
    if (!current_user_can(fbwp_admin_capability())) {
        wp_send_json_error(array('message' => 'Insufficient permissions.'), 403);
    }
    check_ajax_referer('fbwp_admin', 'nonce');
}

function fbwp_ajax_upload_json() {
    fbwp_ajax_guard();
    if (empty($_FILES['json']) || !isset($_FILES['json']['tmp_name'])) {
        wp_send_json_error(array('message' => 'Choose a JSON file first.'), 400);
    }
    $file = $_FILES['json'];
    if (!empty($file['error'])) {
        wp_send_json_error(array('message' => 'Upload failed with code ' . (int) $file['error'] . '.'), 400);
    }
    if ((int) $file['size'] > 20 * MB_IN_BYTES) {
        wp_send_json_error(array('message' => 'JSON file is larger than 20 MB.'), 400);
    }

    $decoded = json_decode(file_get_contents($file['tmp_name']), true);
    if (!is_array($decoded)) {
        wp_send_json_error(array('message' => 'Invalid JSON file.'), 400);
    }
    $validation = fbwp_validate_archive($decoded);
    if (is_wp_error($validation)) {
        wp_send_json_error(array('message' => $validation->get_error_message()), 400);
    }
    if (!$validation['valid']) {
        wp_send_json_error(array('message' => 'Archive validation failed.', 'validation' => $validation), 400);
    }

    $token = fbwp_store_session($decoded, $validation);
    if (is_wp_error($token)) {
        wp_send_json_error(array('message' => $token->get_error_message()), 500);
    }
    wp_send_json_success(array('token' => $token, 'validation' => $validation, 'page' => isset($decoded['page']) ? (string) $decoded['page'] : '', 'cutoff' => isset($decoded['cutoff']) ? (string) $decoded['cutoff'] : ''));
}
add_action('wp_ajax_fbwp_upload_json', 'fbwp_ajax_upload_json');

function fbwp_ajax_import_post() {
    fbwp_ajax_guard();
    $token = isset($_POST['token']) ? sanitize_text_field(wp_unslash($_POST['token'])) : '';
    $index = isset($_POST['index']) ? (int) $_POST['index'] : -1;
    $category = isset($_POST['category']) ? sanitize_text_field(wp_unslash($_POST['category'])) : '';
    $status = isset($_POST['status']) ? sanitize_key(wp_unslash($_POST['status'])) : 'publish';
    $overwrite = !empty($_POST['overwrite']) && sanitize_text_field(wp_unslash($_POST['overwrite'])) === '1';
    if (!in_array($status, array('publish', 'draft'), true)) {
        $status = 'publish';
    }

    $session = fbwp_get_session($token);
    if (is_wp_error($session)) {
        wp_send_json_error(array('message' => $session->get_error_message()), 400);
    }
    $posts = $session['data']['posts'];
    if ($index < 0 || !isset($posts[$index])) {
        wp_send_json_error(array('message' => 'Invalid post index.'), 400);
    }

    $result = fbwp_import_one_record($posts[$index], $category, $status, $overwrite);
    if (is_wp_error($result)) {
        wp_send_json_error(array('message' => $result->get_error_message()), 500);
    }
    $result['index'] = $index;
    $result['total'] = count($posts);
    wp_send_json_success($result);
}
add_action('wp_ajax_fbwp_import_post', 'fbwp_ajax_import_post');

function fbwp_ajax_clear_session() {
    fbwp_ajax_guard();
    $token = isset($_POST['token']) ? sanitize_text_field(wp_unslash($_POST['token'])) : '';
    if ($token === '') {
        wp_send_json_success(array('cleared' => false));
    }
    $key = fbwp_session_transient_key($token);
    $session = get_transient($key);
    if (is_array($session) && !empty($session['path']) && file_exists($session['path'])) {
        @unlink($session['path']);
    }
    delete_transient($key);
    wp_send_json_success(array('cleared' => true));
}
add_action('wp_ajax_fbwp_clear_session', 'fbwp_ajax_clear_session');
