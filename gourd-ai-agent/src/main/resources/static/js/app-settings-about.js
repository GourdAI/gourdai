/* app-settings-about.js — 「关于与更新」设置页
 *
 * 桌面端（Electron）：展示桌面端版本 + 后端版本 + 自动更新面板
 *   （检查更新 / 下载进度 / 安装并重启；mac 等 notify 平台引导浏览器下载）。
 * 浏览器端（WebGate 直连）：仅展示后端版本，提示桌面端专属能力。
 *
 * 更新状态由主进程经 preload 桥推送（window.__GOURD_IPC__.onUpdaterState），
 * 状态机与 main/updater.js 保持一致：
 *   idle | checking | available | not-available | downloading | downloaded | error
 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabAbout';
    var core = window._settingsCore || {};
    var escapeHtml = core.escapeHtml || function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    var ipc = window.__GOURD_IPC__ || null;
    var isDesktop = !!(ipc && ipc.isDesktop);

    // 会话内状态缓存：事件推送与主动拉取共用同一份渲染入口
    var lastState = null;
    var desktopVersion = '';
    var backendVersion = '';
    var rendered = false;

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    function $c() { return $('#' + CONTAINER); }

    /* ── 静态骨架 ─────────────────────────────────────────────── */

    function card(title, desc, body) {
        var h = '<div class="general-card"><div class="general-card-header"><div class="general-card-text">';
        h += '<div class="general-card-title">' + escapeHtml(title) + '</div>';
        if (desc) h += '<div class="general-card-desc">' + escapeHtml(desc) + '</div>';
        h += '</div></div><div class="general-card-body">' + body + '</div></div>';
        return h;
    }

    function renderSkeleton() {
        var html = '';

        // 页头
        html += '<div class="settings-section-header settings-section-header-flat"><div>';
        html += '<span class="settings-section-title">' + escapeHtml(t('settings.about.title')) + '</span>';
        html += '<div class="settings-section-desc">' + escapeHtml(t('settings.about.desc')) + '</div>';
        html += '</div></div>';

        html += '<div class="general-card-group">';

        // 卡片一：版本信息
        var versionRows = '';
        versionRows += '<div class="about-version-row"><span class="about-version-label">' +
            escapeHtml(t('settings.about.desktop_version')) + '</span>' +
            '<span class="about-version-value" id="aboutDesktopVersion">-</span></div>';
        versionRows += '<div class="about-version-row"><span class="about-version-label">' +
            escapeHtml(t('settings.about.backend_version')) + '</span>' +
            '<span class="about-version-value" id="aboutBackendVersion">-</span></div>';
        versionRows += '<div class="about-version-row"><span class="about-version-label">' +
            escapeHtml(t('settings.about.homepage')) + '</span>' +
            '<span class="about-version-value"><a href="https://www.gourd-ai.cn/" target="_blank" rel="noopener">www.gourd-ai.cn</a></span></div>';
        html += card(t('settings.about.version_card'), '', versionRows);

        // 卡片二：检查更新（内容由 applyState 动态填充）
        html += card(t('settings.about.update_card'), '', '<div id="aboutUpdateArea"><div class="settings-section-desc">' +
            escapeHtml(t('settings.about.checking')) + '</div></div>');

        html += '</div>'; // /.general-card-group

        $c().html(html);
        rendered = true;
        fillVersions();
        applyState(lastState); // 已有缓存状态时立即回填
    }

    /* ── 版本信息 ─────────────────────────────────────────────── */

    function fillVersions() {
        if (isDesktop && typeof ipc.getAppVersion === 'function') {
            Promise.resolve(ipc.getAppVersion()).then(function (v) {
                desktopVersion = String(v || '');
                var el = document.getElementById('aboutDesktopVersion');
                if (el) el.textContent = desktopVersion ? ('v' + desktopVersion) : '-';
            }).catch(function () { /* ignore */ });
        } else {
            var eld = document.getElementById('aboutDesktopVersion');
            if (eld) eld.textContent = t('settings.about.web_na');
        }

        // 后端版本：来自 /web/chat/meta 的 appVersion（与启动横幅同一数据源）
        $.get('/web/chat/meta', function (res) {
            var meta = (res && res.data) ? res.data : res;
            backendVersion = String((meta && meta.appVersion) || '');
            var el = document.getElementById('aboutBackendVersion');
            if (el) el.textContent = backendVersion ? ('v' + backendVersion) : '-';
        }).fail(function () {
            var el = document.getElementById('aboutBackendVersion');
            if (el) el.textContent = '-';
        });
    }

    /* ── 更新状态渲染 ─────────────────────────────────────────── */

    function progressHtml(st) {
        var p = st.progress || {};
        var percent = isFinite(p.percent) ? p.percent : 0;
        var text = percent.toFixed(1) + '%';
        if (p.total > 0) text += '  (' + fmtBytes(p.transferred) + ' / ' + fmtBytes(p.total) + ')';
        return '<div class="about-progress-track"><div class="about-progress-fill" style="width:' +
            Math.max(0, Math.min(100, percent)) + '%"></div></div>' +
            '<div class="about-progress-text">' + escapeHtml(text) + '</div>';
    }

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }

    function notesHtml(st) {
        if (!st.releaseNotes) return '';
        return '<div class="about-notes-label">' + escapeHtml(t('settings.about.release_notes')) + '</div>' +
            '<pre class="about-notes">' + escapeHtml(st.releaseNotes) + '</pre>';
    }

    /** 按状态机渲染卡片二内容。非桌面端渲染占位说明。 */
    function applyState(st) {
        lastState = st || lastState;
        if (!rendered) return; // 骨架未建好，建好后会用 lastState 回填
        var $area = $('#aboutUpdateArea');
        if (!$area.length) return;

        if (!isDesktop) {
            $area.html('<div class="settings-section-desc">' + escapeHtml(t('settings.about.web_mode')) + '</div>');
            return;
        }
        if (!lastState) {
            // 快照尚未到达（首次打开 tab 的瞬间），中性占位，避免误报 dev_mode
            $area.html('<div class="about-status-line about-status-sub">…</div>');
            return;
        }
        if (lastState.mode === 'none') {
            $area.html('<div class="settings-section-desc">' + escapeHtml(t('settings.about.dev_mode')) + '</div>');
            return;
        }

        var html = '';
        var status = lastState.status;
        var notify = lastState.mode === 'notify';

        if (status === 'checking') {
            html += '<div class="about-status-line">' + escapeHtml(t('settings.about.checking')) + '</div>';
            html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                escapeHtml(t('settings.about.check_update')) + '</button></div>';
        } else if (status === 'available' || status === 'downloading') {
            html += '<div class="about-status-line about-status-accent">' +
                escapeHtml(t('settings.about.new_version', [lastState.version || ''])) + '</div>';
            if (status === 'downloading') {
                html += progressHtml(lastState);
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.downloading')) + '</div>';
                html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                    escapeHtml(t('settings.about.downloading')) + '</button></div>';
            } else if (notify) {
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.notify_hint')) + '</div>';
                html += notesHtml(lastState);
                html += '<div class="about-actions">' +
                    '<button class="btn-primary" id="aboutDownloadBtn">' + escapeHtml(t('settings.about.download_update')) + '</button>' +
                    '<button class="btn-secondary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.check_update')) + '</button>' +
                    '</div>';
            } else {
                // auto 模式：autoDownload=true，主进程已自动开始下载
                html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.auto_downloading')) + '</div>';
                html += notesHtml(lastState);
                html += '<div class="about-actions"><button class="btn-primary" disabled>' +
                    escapeHtml(t('settings.about.auto_downloading')) + '</button></div>';
            }
        } else if (status === 'downloaded') {
            html += '<div class="about-status-line about-status-accent">' +
                escapeHtml(t('settings.about.downloaded', [lastState.version || ''])) + '</div>';
            html += '<div class="about-status-sub">' + escapeHtml(t('settings.about.install_hint')) + '</div>';
            html += notesHtml(lastState);
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutInstallBtn">' + escapeHtml(t('settings.about.install_restart')) + '</button>' +
                '</div>';
        } else if (status === 'error') {
            html += '<div class="about-status-line about-status-error">' + escapeHtml(t('settings.about.check_failed')) + '</div>';
            if (lastState.error) {
                html += '<div class="about-status-sub about-status-sub-mono">' + escapeHtml(lastState.error) + '</div>';
            }
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.retry')) + '</button>' +
                '</div>';
        } else {
            // idle / not-available
            if (status === 'not-available') {
                html += '<div class="about-status-line">' + escapeHtml(t('settings.about.up_to_date')) + '</div>';
            } else {
                html += '<div class="about-status-line about-status-sub">' + escapeHtml(t('settings.about.idle_hint')) + '</div>';
            }
            html += '<div class="about-actions">' +
                '<button class="btn-primary" id="aboutCheckBtn">' + escapeHtml(t('settings.about.check_update')) + '</button>' +
                '</div>';
        }

        $area.html(html);
    }

    /* ── 事件（document 级委托，重渲染后仍有效）────────────────── */

    $(document).on('click', '#aboutCheckBtn', function () {
        if (!ipc || typeof ipc.updaterCheck !== 'function') return;
        $(this).prop('disabled', true);
        Promise.resolve(ipc.updaterCheck()).then(applyState).catch(function () {
            applyState(null);
        });
    });

    $(document).on('click', '#aboutDownloadBtn', function () {
        if (!ipc || typeof ipc.updaterDownload !== 'function') return;
        Promise.resolve(ipc.updaterDownload()).then(applyState).catch(function () { /* ignore */ });
    });

    $(document).on('click', '#aboutInstallBtn', function () {
        if (!ipc || typeof ipc.updaterInstall !== 'function') return;
        $(this).prop('disabled', true);
        Promise.resolve(ipc.updaterInstall()).then(applyState).catch(function () {
            applyState(null);
        });
    });

    // 订阅主进程推送（模块加载时注册一次，早于任何渲染）。
    // 全局新版提示：不依赖用户打开本页——后台检测到新版本即 toast 一次；
    // 按版本号去重（同版本每次应用生命周期只提示一次，6h 复检不重复打扰）。
    var toastedVersion = '';
    if (isDesktop && typeof ipc.onUpdaterState === 'function') {
        ipc.onUpdaterState(function (st) {
            if (st && st.status === 'available') {
                var v = String(st.version || '');
                if (v && toastedVersion !== v) {
                    toastedVersion = v;
                    if (typeof window.showToast === 'function') {
                        window.showToast(t('settings.about.new_version', [v]), 'success');
                    }
                }
            }
            applyState(st);
        });
    }

    /* ── 入口 ─────────────────────────────────────────────────── */

    function load() {
        if (!rendered) renderSkeleton();
        else {
            fillVersions();
            applyState(lastState);
        }
        // 主动拉一次快照，覆盖"事件早于页面打开"的竞态
        if (isDesktop && typeof ipc.updaterGetState === 'function') {
            Promise.resolve(ipc.updaterGetState()).then(applyState).catch(function () { /* ignore */ });
        }
    }

    window._settingsAbout = { load: load };
})();
