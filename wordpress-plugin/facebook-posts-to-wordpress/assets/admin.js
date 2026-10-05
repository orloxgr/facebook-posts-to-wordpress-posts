(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const storageKey = 'fbwp-import-session-v1';
    const state = { token: '', total: 0, validation: null, stopped: false, running: false, nextIndex: 0 };

    function log(message) {
        const el = $('fbwp-log');
        if (!el) return;
        el.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
        el.scrollTop = el.scrollHeight;
    }

    function setBusy(busy) {
        state.running = busy;
        $('fbwp-validate').disabled = busy;
        $('fbwp-import-one').disabled = busy || !state.token;
        $('fbwp-import-all').disabled = busy || !state.token;
        $('fbwp-stop').disabled = !busy;
    }

    function saveState() {
        if (!state.token) {
            sessionStorage.removeItem(storageKey);
            return;
        }
        sessionStorage.setItem(storageKey, JSON.stringify({ token: state.token, total: state.total, validation: state.validation, nextIndex: state.nextIndex }));
    }

    function renderSummary(validation, extra = {}) {
        const el = $('fbwp-summary');
        if (!el || !validation) return;
        const items = [['Posts', validation.total], ['Dated', validation.dated], ['Unresolved', validation.unresolved], ['Image risk', validation.imageRisk], ['Max images/post', validation.maxImages]];
        el.innerHTML = items.map(([label, value]) => `<div class="fbwp-stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
        if (extra.page || extra.cutoff) {
            const meta = document.createElement('p');
            meta.className = 'fbwp-meta';
            meta.textContent = [extra.page ? `Page: ${extra.page}` : '', extra.cutoff ? `Cutoff: ${extra.cutoff}` : ''].filter(Boolean).join(' · ');
            el.appendChild(meta);
        }
    }

    function updateProgress(done, total) {
        const progress = $('fbwp-progress');
        progress.max = Math.max(total, 1);
        progress.value = Math.min(done, total);
        $('fbwp-progress-text').textContent = `${done} / ${total}`;
    }

    function restoreState() {
        try {
            const raw = sessionStorage.getItem(storageKey);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (!saved.token || !saved.total) return;
            state.token = saved.token;
            state.total = saved.total;
            state.validation = saved.validation || null;
            state.nextIndex = Number.isInteger(saved.nextIndex) ? saved.nextIndex : 0;
            renderSummary(state.validation);
            $('fbwp-summary-panel').hidden = false;
            $('fbwp-import-panel').hidden = false;
            updateProgress(state.nextIndex, state.total);
            log('Restored the current browser session.');
        } catch (_) {
            sessionStorage.removeItem(storageKey);
        }
    }

    async function ajax(action, fields = {}, file = null) {
        const body = new FormData();
        body.append('action', action);
        body.append('nonce', FBWP_ADMIN.nonce);
        Object.entries(fields).forEach(([key, value]) => body.append(key, value));
        if (file) body.append('json', file);

        const response = await fetch(FBWP_ADMIN.ajaxUrl, { method: 'POST', credentials: 'same-origin', body });
        let data;
        try { data = await response.json(); } catch (_) { throw new Error(`Server returned HTTP ${response.status} without JSON.`); }
        if (!data.success) {
            const err = new Error(data?.data?.message || `Request failed with HTTP ${response.status}.`);
            err.payload = data?.data || null;
            throw err;
        }
        return data.data;
    }

    async function validateJson() {
        const file = $('fbwp-json-file').files[0];
        if (!file) { alert('Choose the exported JSON first.'); return; }
        setBusy(true);
        $('fbwp-log').textContent = '';
        log(`Uploading and validating ${file.name}...`);
        try {
            const data = await ajax('fbwp_upload_json', {}, file);
            state.token = data.token;
            state.total = data.validation.total;
            state.validation = data.validation;
            state.nextIndex = 0;
            state.stopped = false;
            renderSummary(data.validation, { page: data.page, cutoff: data.cutoff });
            $('fbwp-summary-panel').hidden = false;
            $('fbwp-import-panel').hidden = false;
            updateProgress(0, state.total);
            saveState();
            log(`Validation OK: ${state.total} posts, ${data.validation.unresolved} unresolved, image-risk ${data.validation.imageRisk}.`);
        } catch (e) {
            const validation = e.payload?.validation;
            if (validation) {
                renderSummary(validation);
                $('fbwp-summary-panel').hidden = false;
                (validation.errors || []).forEach((msg) => log(`ERROR: ${msg}`));
            }
            log(`Validation failed: ${e.message}`);
        } finally { setBusy(false); }
    }

    async function importIndex(index) {
        const category = $('fbwp-category').value.trim();
        if (!category) throw new Error('Category is required.');
        return ajax('fbwp_import_post', {
            token: state.token,
            index,
            category,
            status: $('fbwp-status').value,
            overwrite: $('fbwp-overwrite').checked ? '1' : '0',
        });
    }

    function resultLine(data) {
        const prefix = data.result === 'skipped' ? 'SKIP' : (data.result === 'overwritten' ? 'OVERWRITE' : 'OK');
        const parts = [`${prefix} #${data.index + 1}/${data.total}`, data.title || '(no title)', `images=${data.images}`, `tags=${data.tags}`];
        if (data.postId) parts.push(`post=${data.postId}`);
        return parts.join(' | ');
    }

    async function importOne() {
        if (!state.token || state.running) return;
        const index = Math.min(state.nextIndex, Math.max(state.total - 1, 0));
        setBusy(true);
        state.stopped = false;
        log(`Importing one post: #${index + 1}${$('fbwp-overwrite').checked ? ' (overwrite ON)' : ''}...`);
        try {
            const data = await importIndex(index);
            log(resultLine(data));
            state.nextIndex = Math.max(state.nextIndex, index + 1);
            updateProgress(state.nextIndex, state.total);
            saveState();
            if (data.editUrl) log(`Edit: ${data.editUrl}`);
        } catch (e) { log(`ERROR #${index + 1}: ${e.message}`); }
        finally { setBusy(false); }
    }

    async function importAll() {
        if (!state.token || state.running) return;
        const overwrite = $('fbwp-overwrite').checked;
        const warning = overwrite
            ? `Import all ${state.total} posts with OVERWRITE enabled?\n\nMatching imported posts will be updated in place and their imported images will be replaced.`
            : `Import all ${state.total} posts?\n\nExisting imported posts will be skipped.`;
        if (!confirm(`${warning}\n\nThe importer runs one post at a time and stops on the first error.`)) return;
        setBusy(true);
        state.stopped = false;
        try {
            for (let i = 0; i < state.total; i++) {
                if (state.stopped) { log(`Stopped before #${i + 1}.`); break; }
                const data = await importIndex(i);
                log(resultLine(data));
                state.nextIndex = i + 1;
                updateProgress(state.nextIndex, state.total);
                saveState();
            }
            if (!state.stopped && state.nextIndex >= state.total) log('Import ALL complete.');
        } catch (e) {
            log(`ERROR: ${e.message}`);
            log('Import stopped. Fix the problem, then run Import ALL again.');
        } finally { setBusy(false); }
    }

    async function clearSession() {
        if (state.running) return;
        try { if (state.token) await ajax('fbwp_clear_session', { token: state.token }); }
        catch (e) { log(`Clear session warning: ${e.message}`); }
        state.token = '';
        state.total = 0;
        state.validation = null;
        state.nextIndex = 0;
        state.stopped = false;
        sessionStorage.removeItem(storageKey);
        $('fbwp-summary-panel').hidden = true;
        $('fbwp-import-panel').hidden = true;
        $('fbwp-log').textContent = '';
        updateProgress(0, 0);
    }

    document.addEventListener('DOMContentLoaded', () => {
        $('fbwp-validate').addEventListener('click', validateJson);
        $('fbwp-import-one').addEventListener('click', importOne);
        $('fbwp-import-all').addEventListener('click', importAll);
        $('fbwp-stop').addEventListener('click', () => { state.stopped = true; $('fbwp-stop').disabled = true; log('Stop requested. The current request will finish first.'); });
        $('fbwp-clear-session').addEventListener('click', clearSession);
        restoreState();
        setBusy(false);
    });
})();
