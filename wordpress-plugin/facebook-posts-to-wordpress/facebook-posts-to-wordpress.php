<?php
/**
 * Plugin Name: Facebook Posts to WordPress Posts
 * Description: One-time JSON importer for Facebook posts collected by the companion Tampermonkey script.
 * Version: 1.0.4
 * Author: iniotakis-tools
 * Requires at least: 6.0
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

const FBWP_VERSION = '1.0.4';
const FBWP_MAX_IMAGES_PER_POST = 20;
const FBWP_SESSION_TTL = 12 * HOUR_IN_SECONDS;

require_once __DIR__ . '/includes/helpers.php';
require_once __DIR__ . '/includes/session.php';
require_once __DIR__ . '/includes/media.php';
require_once __DIR__ . '/includes/importer.php';
require_once __DIR__ . '/includes/admin.php';
