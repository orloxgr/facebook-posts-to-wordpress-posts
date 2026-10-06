// ==UserScript==
// @name         Facebook Page to WordPress Collector
// @namespace    iniotakis-tools
// @version      1.4.7-loader.5
// @description  Generic Facebook Page collector for exporting posts to the WordPress importer.
// @updateURL    https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js
// @downloadURL  https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress.user.js
// @require      https://raw.githubusercontent.com/orloxgr/facebook-posts-to-wordpress-posts/main/tampermonkey/facebook-posts-to-wordpress-v1.4.7.user.js
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    // The collector itself is loaded by @require above.
    // No eval/new Function is used, so Facebook's CSP does not block execution.
})();
