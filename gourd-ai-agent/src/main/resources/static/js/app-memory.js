/* ===== app-memory.js ===== */
/* 心智记忆面板：查看工作空间 / 全局两个域的记忆条目（只读）。
   入口：chat 模式侧边栏 #memoryViewBtn；专注模式文件树面板顶部 #filerMemoryBtn。 */

(function() {
    if (document.getElementById('memoryPanelWrap')) return; // 防重复挂载

    var SCOPE_WORKSPACE = 'workspace';
    var SCOPE_GLOBAL = 'global';
    var currentScope = SCOPE_WORKSPACE;
    var panelOpen = false;

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
            return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
        });
    }

    function t(key) {
        return (window.GourdI18n && GourdI18n.t) ? GourdI18n.t(key) : key;
    }

    /* ---------- DOM 构建 ---------- */
    function buildPanel() {
        var wrap = document.createElement('div');
        wrap.id = 'memoryPanelWrap';
        wrap.className = 'memory-panel';
        wrap.innerHTML =
            '<div class="memory-panel-header">' +
                '<div class="memory-panel-tabs">' +
                    '<button class="memory-tab active" data-scope="workspace">' + escHtml(t('memory.tab_workspace')) + '</button>' +
                    '<button class="memory-tab" data-scope="global">' + escHtml(t('memory.tab_global')) + '</button>' +
                '</div>' +
                '<div class="memory-panel-actions">' +
                    '<button class="memory-icon-btn" id="memoryRefreshBtn" title="' + escHtml(t('memory.refresh')) + '">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>' +
                    '</button>' +
                    '<button class="memory-icon-btn" id="memoryCloseBtn" title="' + escHtml(t('memory.close')) + '">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="memory-panel-meta" id="memoryPanelMeta"></div>' +
            '<div class="memory-panel-body" id="memoryPanelBody">' +
                '<div class="memory-empty">' + escHtml(t('memory.loading')) + '</div>' +
            '</div>';
        document.body.appendChild(wrap);
        return wrap;
    }

    var panel = buildPanel();
    var body = panel.querySelector('#memoryPanelBody');
    var meta = panel.querySelector('#memoryPanelMeta');
    var tabs = panel.querySelectorAll('.memory-tab');

    /* ---------- 数据加载 ---------- */
    function loadMemories() {
        body.innerHTML = '<div class="memory-empty">' + escHtml(t('memory.loading')) + '</div>';
        meta.textContent = '';

        var headers = {};
        var cwd = (typeof getSessionCwd === 'function') ? getSessionCwd() : '';
        if (cwd) headers['X-Session-Cwd'] = cwd;

        fetch('/web/chat/memory/list?scope=' + encodeURIComponent(currentScope), { headers: headers })
            .then(function(r) { return r.json(); })
            .then(function(res) {
                var data = (res && res.data) ? res.data : {};
                renderList(data.items || [], data.total || 0);
            })
            .catch(function() {
                body.innerHTML = '<div class="memory-empty memory-error">' + escHtml(t('memory.load_failed')) + '</div>';
            });
    }

    function impClass(imp) {
        var v = Number(imp) || 0;
        if (v >= 10) return 'imp-critical';
        if (v >= 7) return 'imp-high';
        if (v >= 4) return 'imp-mid';
        return 'imp-low';
    }

    function renderList(items, total) {
        meta.textContent = t('memory.count').replace('{n}', total);

        if (!items.length) {
            body.innerHTML = '<div class="memory-empty">' + escHtml(t('memory.empty')) + '</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            html += '<div class="memory-item">' +
                '<div class="memory-item-head">' +
                    '<span class="memory-item-key" title="' + escHtml(it.key) + '">' + escHtml(it.key) + '</span>' +
                    '<span class="memory-item-imp ' + impClass(it.importance) + '">Imp ' + escHtml(it.importance) + '</span>' +
                    '<span class="memory-item-time">' + escHtml(it.time || '') + '</span>' +
                '</div>' +
                '<div class="memory-item-content">' + escHtml(it.content) + '</div>' +
            '</div>';
        }
        body.innerHTML = html;
    }

    /* ---------- 交互 ---------- */
    function setActiveTab(scope) {
        for (var i = 0; i < tabs.length; i++) {
            var b = tabs[i];
            if (b.getAttribute('data-scope') === scope) b.classList.add('active');
            else b.classList.remove('active');
        }
    }

    function openPanel() {
        panelOpen = true;
        panel.classList.add('show');
        loadMemories();
    }

    function closePanel() {
        panelOpen = false;
        panel.classList.remove('show');
    }

    function togglePanel() {
        if (panelOpen) closePanel(); else openPanel();
    }

    for (var i = 0; i < tabs.length; i++) {
        (function(btn) {
            btn.addEventListener('click', function() {
                var scope = btn.getAttribute('data-scope');
                if (scope === currentScope) return;
                currentScope = scope;
                setActiveTab(scope);
                loadMemories();
            });
        })(tabs[i]);
    }

    panel.querySelector('#memoryRefreshBtn').addEventListener('click', loadMemories);
    panel.querySelector('#memoryCloseBtn').addEventListener('click', closePanel);

    /* 点击面板外关闭 */
    document.addEventListener('mousedown', function(e) {
        if (!panelOpen) return;
        if (panel.contains(e.target)) return;
        if (e.target.closest && (e.target.closest('#memoryViewBtn') || e.target.closest('#filerMemoryBtn'))) return;
        closePanel();
    });

    /* ---------- 入口绑定 ---------- */
    var btnChat = document.getElementById('memoryViewBtn');
    var btnFiler = document.getElementById('filerMemoryBtn');
    if (btnChat) btnChat.addEventListener('click', togglePanel);
    if (btnFiler) btnFiler.addEventListener('click', togglePanel);
})();
