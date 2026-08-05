/* ===== app-gitdiff.js ===== */
/* Filer Panel Git Diff 面板：三态检测、文件列表（带勾选）、Diff Viewer 内联查看、精确提交 */

(function() {
    // ---- DOM 元素 ----
    // 视图切换按钮现位于左侧主侧边栏（.sidebar-header-actions），data-view = files | gitdiff
    var tabs = document.querySelectorAll('.filer-view-btn');
    var tabContents = document.querySelectorAll('.filer-tab-content');
    var gitUnavailable = document.getElementById('gitUnavailable');
    var gitUninitialized = document.getElementById('gitUninitialized');
    var gitDiffPanel = document.getElementById('gitDiffPanel');
    var gitBadge = document.getElementById('gitBadge');
    var gitBranch = document.getElementById('gitBranch');
    var gitDiffFileList = document.getElementById('gitDiffFileList');
    var gitDiffEmpty = document.getElementById('gitDiffEmpty');
    var gitInitBtn = document.getElementById('gitInitBtn');
    var gitInitCommit = document.getElementById('gitInitCommit');
    var gitCommitBtn = document.getElementById('gitCommitBtn');
    var gitCommitMsg = document.getElementById('gitCommitMsg');
    var gitCommitBar = document.getElementById('gitCommitBar');
    var gitSelectAll = document.getElementById('gitSelectAll');
    var gitRefreshBtn = document.getElementById('gitRefreshBtn');

    // Diff Viewer / File Viewer 元素（内联在 main-area 内）
    var gitDiffViewer = document.getElementById('gitDiffViewer');
    var gitViewerLabel = document.getElementById('gitViewerLabel');
    var gitViewerFile = document.getElementById('gitViewerFile');
    var gitViewerContent = document.getElementById('gitViewerContent');
    var gitViewerClose = document.getElementById('gitViewerClose');
    // main-area 子视图引用
    var welcomeView = document.getElementById('welcomeView');
    var chatView = document.getElementById('chatView');
    var codeEditorPane = document.getElementById('codeEditorPane');

    // ---- 状态 ----
    var gitStatus = null;
    var isInitializing = false;

    // ---- Code 模式项目根：git 接口按所选项目重定向（chat 模式为空串）----
    function gitRoot() {
        return (window.appMode === 'code' && window.currentProjectRoot) ? window.currentProjectRoot : '';
    }
    function gitRootQ(sep) {
        var r = gitRoot();
        return r ? (sep || '&') + 'root=' + encodeURIComponent(r) : '';
    }
    var viewerMode = null; // 'diff' | 'file' | null

    // ---- 刷新按钮 ----
    if (gitRefreshBtn) {
        gitRefreshBtn.addEventListener('click', function() {
            loadGitStatus();
        });
    }

    // ---- 视图切换（项目 / Git 审查）----
    // 切换入口在左侧主侧边栏的 .filer-view-btn；内容面板仍是 #tabContentFiles / #tabContentGitdiff。
    // 同步 window.filerView + body[data-filer-view]，供 CSS 显隐中间编辑器、app-code.js 刷新中间区。
    function applyFilerView(view, opts) {
        opts = opts || {};
        // 切换视图前先关掉可能打开的 diff/文件浮层，避免它继续占据编辑器列
        if (diffViewerActive) closeDiffViewer();
        tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-view') === view); });
        var contentId = 'tabContent' + view.charAt(0).toUpperCase() + view.slice(1);
        tabContents.forEach(function(tc) { tc.classList.toggle('active', tc.id === contentId); });

        window.filerView = view;
        try { document.body.dataset.filerView = view; } catch (e) {}

        if (view === 'gitdiff') loadGitStatus();
        // 中间区按视图刷新（Git 视图隐藏 Code 编辑器）
        if (typeof window.refreshCenterPane === 'function') window.refreshCenterPane();
        if (opts.persist !== false) {
            try { localStorage.setItem('filer-active-tab', view); } catch (e) {}
        }
    }

    tabs.forEach(function(tab) {
        tab.addEventListener('click', function() {
            applyFilerView(this.getAttribute('data-view'));
        });
    });

    // 恢复上次视图（键名沿用 'filer-active-tab'）
    var savedTab = localStorage.getItem('filer-active-tab');
    // 历史遗留值 'tasks' 回退到 'files'
    if (savedTab === 'tasks') { savedTab = 'files'; try { localStorage.setItem('filer-active-tab', 'files'); } catch (e) {} }
    if (savedTab === 'gitdiff') {
        applyFilerView('gitdiff', { persist: false });
    } else {
        // 默认项目视图：仅初始化状态，不额外持久化
        window.filerView = 'files';
        try { document.body.dataset.filerView = 'files'; } catch (e) {}
    }

    // ---- 显示/隐藏状态区 ----
    function showState(state) {
        if (gitUnavailable) gitUnavailable.style.display = 'none';
        if (gitUninitialized) gitUninitialized.style.display = 'none';
        if (gitDiffPanel) gitDiffPanel.style.display = 'none';

        if (state === 'unavailable' && gitUnavailable) gitUnavailable.style.display = '';
        else if (state === 'uninitialized' && gitUninitialized) gitUninitialized.style.display = '';
        else if (state === 'ready' && gitDiffPanel) gitDiffPanel.style.display = '';
    }

    // ---- 加载 Git 状态 ----
    function loadGitStatus() {
        // Git 审查仅在 Code 模式且已选项目时才有意义：
        // - chat 模式没有文件树/审查面板，不应查询
        // - code 模式未选项目时，没有目标仓库，避免误显示启动工作区的变更
        if (window.appMode !== 'code' || !window.currentProjectRoot) {
            updateBadge(0);
            return;
        }
        var rootQ = '?root=' + encodeURIComponent(window.currentProjectRoot);
        fetch('/web/chat/git/status' + rootQ)
            .then(function(r) { return r.json(); })
            .then(function(res) {
                var data = (res && res.data) ? res.data : {};
                gitStatus = data;

                if (!data.gitAvailable) {
                    showState('unavailable');
                    return;
                }
                if (!data.initialized) {
                    showState('uninitialized');
                    updateBadge(0);
                    return;
                }

                showState('ready');
                renderBranch(data.branch);
                renderFileList(data);
                updateBadge(
                    (data.changed || []).length +
                    (data.staged || []).length +
                    (data.untracked || []).length
                );
            })
            .catch(function(e) {
                console.error('[gitdiff] status error', e);
                showState('unavailable');
            });
    }

    // ---- 渲染分支名 ----
    function renderBranch(branch) {
        if (gitBranch) gitBranch.textContent = branch || '--';
    }

    // ---- 渲染文件列表（带 checkbox）----
    function renderFileList(data) {
        if (!gitDiffFileList) return;

        // 在清空列表前，记录当前已勾选的文件路径
        var prevChecked = {};
        var hasPrevState = false;
        gitDiffFileList.querySelectorAll('.git-file-checkbox').forEach(function(cb) {
            hasPrevState = true;
            if (cb.checked) prevChecked[cb.getAttribute('data-path')] = true;
        });

        gitDiffFileList.innerHTML = '';

        var files = [];

        // 已暂存
        (data.staged || []).forEach(function(p) {
            files.push({ path: p, status: 'S' });
        });
        // 已修改（未暂存）
        (data.changed || []).forEach(function(p) {
            files.push({ path: p, status: 'M' });
        });
        // 未跟踪
        (data.untracked || []).forEach(function(p) {
            files.push({ path: p, status: '?' });
        });

        if (files.length === 0) {
            if (gitDiffEmpty) gitDiffEmpty.style.display = '';
            gitDiffFileList.style.display = 'none';
            if (gitCommitBar) gitCommitBar.style.display = 'none';
            return;
        }
        if (gitDiffEmpty) gitDiffEmpty.style.display = 'none';
        gitDiffFileList.style.display = '';
        if (gitCommitBar) gitCommitBar.style.display = '';

        files.forEach(function(file) {
            var item = document.createElement('div');
            item.className = 'git-file-item';

            // checkbox：如果之前有选中状态则恢复，否则默认全选
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'git-file-checkbox';
            cb.checked = hasPrevState ? !!prevChecked[file.path] : true;
            cb.setAttribute('data-path', file.path);
            cb.addEventListener('click', function(e) {
                e.stopPropagation(); // 防止触发外层 click 打开 diff
                syncSelectAll();
            });

            // 状态字母
            var statusSpan = document.createElement('span');
            statusSpan.className = 'git-status-letter ' + file.status;
            statusSpan.textContent = file.status;

            // 文件名（主）+ 所在目录（次）：优先保证文件名可见，长路径不再把名字挤没
            var slash = file.path.lastIndexOf('/');
            var fileName = slash >= 0 ? file.path.substring(slash + 1) : file.path;
            var dirPath = slash >= 0 ? file.path.substring(0, slash) : '';

            var pathSpan = document.createElement('span');
            pathSpan.className = 'git-file-path';
            pathSpan.title = file.path;
            var nameEl = document.createElement('span');
            nameEl.className = 'git-file-name';
            nameEl.textContent = fileName;
            pathSpan.appendChild(nameEl);
            if (dirPath) {
                var dirEl = document.createElement('span');
                dirEl.className = 'git-file-dir';
                dirEl.textContent = dirPath;
                pathSpan.appendChild(dirEl);
            }

            item.appendChild(cb);
            item.appendChild(statusSpan);
            item.appendChild(pathSpan);

            item.setAttribute('data-status', file.status);

            // 点击文件行打开 diff viewer
            item.addEventListener('click', function(e) {
                // 避免点 checkbox 时也触发
                if (e.target === cb) return;
                openDiffViewer(file.path, file.status);
            });

            gitDiffFileList.appendChild(item);
        });
    }

    // ---- 同步全选 checkbox 状态 ----
    function syncSelectAll() {
        if (!gitSelectAll || !gitDiffFileList) return;
        var all = gitDiffFileList.querySelectorAll('.git-file-checkbox');
        var checked = gitDiffFileList.querySelectorAll('.git-file-checkbox:checked');
        gitSelectAll.checked = (all.length > 0 && all.length === checked.length);
    }

    // ---- 全选/取消全选 ----
    if (gitSelectAll) {
        gitSelectAll.addEventListener('change', function() {
            if (!gitDiffFileList) return;
            var cbs = gitDiffFileList.querySelectorAll('.git-file-checkbox');
            var val = this.checked;
            cbs.forEach(function(cb) { cb.checked = val; });
        });
    }

    // ---- 获取选中的文件路径列表 ----
    function getSelectedFiles() {
        if (!gitDiffFileList) return [];
        var checked = gitDiffFileList.querySelectorAll('.git-file-checkbox:checked');
        var paths = [];
        checked.forEach(function(cb) {
            var p = cb.getAttribute('data-path');
            if (p) paths.push(p);
        });
        return paths;
    }

    // ---- 根据文件扩展名推测语言（用于 hljs）----
    function guessLang(path) {
        var ext = (path || '').replace(/.*\./, '').toLowerCase();
        var map = {
            js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
            java: 'java', kt: 'kotlin', kts: 'kotlin',
            py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
            c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
            cs: 'csharp', fs: 'fsharp',
            scala: 'scala', clj: 'clojure', ex: 'elixir', exs: 'elixir',
            html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
            css: 'css', scss: 'scss', less: 'less', sass: 'scss',
            json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
            md: 'markdown', markdown: 'markdown',
            sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
            dockerfile: 'dockerfile', makefile: 'makefile',
            gradle: 'groovy', groovy: 'groovy',
            lua: 'lua', r: 'r', pl: 'perl', pm: 'perl',
            swift: 'swift', dart: 'dart',
            vue: 'xml', svelte: 'xml',
            properties: 'properties', conf: 'nginx', nginx: 'nginx',
            ini: 'ini', cfg: 'ini',
            txt: 'plaintext'
        };
        // 特殊文件名
        var name = (path || '').replace(/.*\//, '').toLowerCase();
        if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
        if (name === 'dockerfile') return 'dockerfile';
        if (name === '.gitignore' || name === '.gitattributes') return 'bash';
        if (name === 'jenkinsfile') return 'groovy';
        if (name === 'vagrantfile') return 'ruby';
        return map[ext] || '';
    }

    // ---- 格式化文件大小 ----
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ---- File Viewer：打开文件内容（在 main-area 内）----
    var diffViewerActive = false;

    // 在 code 模式下，main-area 是横向 flex：编辑器(#codeEditorPane, flex:1) 与
    // diff 浮层(#gitDiffViewer, flex:1) 是同级列。若只显示浮层而不隐藏编辑器面板，
    // 二者会各占一半，右侧残留「代码审查」占位空白。用 body.viewer-open 类让 CSS
    // 在 viewer 打开时隐藏编辑器面板（纯类控制，避免与 refreshCenterPane 的内联样式打架）。
    function showViewer() {
        if (welcomeView) welcomeView.style.display = 'none';
        // code 模式：diff 浮层占据中间列，与右侧对话栏(#chatView, order:3)是正交的两列，
        // 不能隐藏对话栏（否则新开/切换对话会连带把中间 diff 顶掉）。仅 chat 模式下
        // diff 是全屏覆盖，才需要隐藏聊天视图。
        if (chatView && window.appMode !== 'code') chatView.style.display = 'none';
        try { document.body.classList.add('viewer-open'); } catch (e) {}
        gitDiffViewer.style.display = 'flex';
        diffViewerActive = true;
    }

    function openFileViewer(path, name) {
        if (!gitDiffViewer) return;

        viewerMode = 'file';
        if (gitViewerContent) gitViewerContent.classList.remove('git-viewer-split');

        // 显示 viewer（隐藏欢迎页/聊天视图，并在 code 模式接管编辑器列）
        showViewer();

        // 更新 header
        if (gitViewerLabel) gitViewerLabel.textContent = GourdI18n.t('git.file_content');
        if (gitViewerFile) gitViewerFile.textContent = path;

        // 清理操作栏
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        if (gitViewerContent) gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">' + GourdI18n.t('git.loading') + '</div>';

        fetch('/web/chat/filer/read?path=' + encodeURIComponent(path))
            .then(function(r) { return r.json(); })
            .then(function(res) {
                var d = (res && res.data) ? res.data : {};
                if (res && res.code !== 200) {
                    gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--color-danger)">'
                        + escapeHtml((res && res.data && res.data.message) || res.description || GourdI18n.t('git.cannot_read'))
                        + '</div>';
                    return;
                }
                renderFileContent(d.content, d.name || name, d.size, path);
            })
            .catch(function(e) {
                if (gitViewerContent) gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--color-danger)">' + GourdI18n.t('git.load_failed', escapeHtml(e.message)) + '</div>';
            });
    }

    // ---- File Viewer：渲染文件内容（语法高亮 + 行号）----
    function renderFileContent(content, fileName, fileSize, filePath) {
        if (!gitViewerContent) return;

        var lang = guessLang(filePath || fileName);
        var lines = (content || '').split('\n');
        var totalLines = lines.length;

        // 构建带行号的代码行
        var codeHtml = '';
        for (var i = 0; i < totalLines; i++) {
            var escapedLine = escapeHtml(lines[i]);
            // 空行保留高度
            if (escapedLine === '') escapedLine = ' ';
            codeHtml += '<div class="file-view-line">'
                + '<span class="file-view-num">' + (i + 1) + '</span>'
                + '<span class="file-view-text">' + escapedLine + '</span>'
                + '</div>';
        }

        // 信息栏
        var infoBar = '<div class="file-view-info">'
            + '<span>' + escapeHtml(fileName || '') + '</span>'
            + '<span class="file-view-info-sep">|</span>'
            + '<span>' + GourdI18n.t('git.total_lines', totalLines) + '</span>'
            + '<span class="file-view-info-sep">|</span>'
            + '<span>' + formatSize(fileSize || 0) + '</span>'
            + (lang ? '<span class="file-view-info-sep">|</span><span>' + escapeHtml(lang) + '</span>' : '')
            + '<span class="file-view-copy-btn" title="' + GourdI18n.t('git.copy_file') + '">' + GourdI18n.t('git.copy') + '</span>'
            + '</div>';

        gitViewerContent.innerHTML = infoBar
            + '<div class="file-view-code' + (lang ? ' hljs-language-' + lang : '') + '">' + codeHtml + '</div>';

        // 如果有 hljs 且能识别语言，对代码区进行语法高亮
        if (lang && typeof hljs !== 'undefined') {
            var codeBlock = gitViewerContent.querySelector('.file-view-code');
            if (codeBlock) {
                try {
                    // 将纯文本替换为高亮后的 HTML
                    var rawText = content || '';
                    var highlighted = hljs.highlight(rawText, { language: lang, ignoreIllegals: true });
                    var hlLines = highlighted.value.split('\n');
                    var hlHtml = '';
                    for (var j = 0; j < hlLines.length; j++) {
                        var hlLine = hlLines[j] || ' ';
                        hlHtml += '<div class="file-view-line">'
                            + '<span class="file-view-num">' + (j + 1) + '</span>'
                            + '<span class="file-view-text">' + hlLine + '</span>'
                            + '</div>';
                    }
                    codeBlock.innerHTML = hlHtml;
                } catch (e) {
                    // highlight 失败时保留纯文本
                }
            }
        }

        // 复制按钮
        var copyBtn = gitViewerContent.querySelector('.file-view-copy-btn');
        if (copyBtn) {
            (function(rawContent, btn) {
                btn.addEventListener('click', function() {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(rawContent).then(function() {
                            btn.textContent = GourdI18n.t('git.copied');
                            setTimeout(function() { btn.textContent = GourdI18n.t('git.copy'); }, 1500);
                        }).catch(function() {
                            fallbackCopy(rawContent, btn);
                        });
                    } else {
                        fallbackCopy(rawContent, btn);
                    }
                });
            })(content, copyBtn);
        }

        gitViewerContent.scrollTop = 0;
    }

    // 复制兜底方法
    function fallbackCopy(text, btn) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch(e) {}
        document.body.removeChild(ta);
        btn.textContent = GourdI18n.t('git.copied');
        setTimeout(function() { btn.textContent = GourdI18n.t('git.copy'); }, 1500);
    }

    // ---- Diff Viewer：打开内联 diff（在 main-area 内）----

    function openDiffViewer(path, status) {
        if (!gitDiffViewer) return;

        viewerMode = 'diff';
        // 先复位为普通布局；确认是可 diff 的文本时 renderViewerDiff 会重新加回并排类
        if (gitViewerContent) gitViewerContent.classList.remove('git-viewer-split');

        // 显示 diff viewer（隐藏欢迎页/聊天视图，并在 code 模式接管编辑器列）
        showViewer();

        if (gitViewerLabel) gitViewerLabel.textContent = GourdI18n.t('git.change_detail');
        if (gitViewerFile) gitViewerFile.textContent = path;

        // 判断是否是目录（以 / 结尾）
        var isDir = path.endsWith('/');

        if (isDir) {
            // 目录：显示提示信息，不调用 diff 接口
            if (gitViewerContent) {
                gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">'
                    + '<div style="margin-bottom:8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg> ' + escapeHtml(path) + '</div>'
                    + '<div>' + GourdI18n.t('git.no_diff_dir') + '</div>'
                    + '</div>';
            }
            renderViewerActions(path, status);
            return;
        }

        if (gitViewerContent) gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">' + GourdI18n.t('git.loading') + '</div>';

        fetch('/web/chat/git/diff?path=' + encodeURIComponent(path) + gitRootQ())
            .then(function(r) { return r.json(); })
            .then(function(res) {
                var d = (res && res.data) ? res.data : {};
                var diffText = d.diff || '';
                if (!diffText.trim()) {
                    gitViewerContent.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">'
                        + (status === '?' ? GourdI18n.t('git.no_diff_untracked') : GourdI18n.t('git.no_diff'))
                        + '</div>';
                } else {
                    renderViewerDiff(diffText);
                }
            })
            .catch(function(e) {
                if (gitViewerContent) gitViewerContent.innerHTML = '<div style="padding:20px;color:#cb2431">' + GourdI18n.t('git.load_failed', escapeHtml(e.message)) + '</div>';
            })
            .finally(function() {
                renderViewerActions(path, status);
            });
    }

    // ---- Diff Viewer：渲染操作按钮（添加到Git / 移出暂存）----
    function renderViewerActions(path, status) {
        // 移除旧的操作栏（如有）
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        if (status !== '?' && status !== 'S') return; // 只有未跟踪和已暂存需要操作按钮

        var actionBar = document.createElement('div');
        actionBar.className = 'git-viewer-actions';

        if (status === '?') {
            // 未跟踪 -> 提供 "添加到 Git" 按钮
            var addBtn = document.createElement('button');
            addBtn.className = 'git-action-btn git-action-add';
            addBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.add_to_git');
            addBtn.addEventListener('click', function() {
                addBtn.disabled = true;
                addBtn.textContent = GourdI18n.t('git.adding');
                fetch('/web/chat/git/stage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, root: gitRoot() })
                })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                        closeDiffViewer();
                    } else {
                        layAlert(GourdI18n.t('git.op_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.op_failed', e.message));
                    addBtn.disabled = false;
                });
            });
            actionBar.appendChild(addBtn);
        }

        if (status === 'S') {
            // 已暂存 -> 提供 "移出暂存" 按钮
            var unstageBtn = document.createElement('button');
            unstageBtn.className = 'git-action-btn git-action-unstage';
            unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
            unstageBtn.addEventListener('click', function() {
                unstageBtn.disabled = true;
                unstageBtn.textContent = GourdI18n.t('git.unstaging');
                fetch('/web/chat/git/unstage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, root: gitRoot() })
                })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                        closeDiffViewer();
                    } else {
                        layAlert(GourdI18n.t('git.op_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                        unstageBtn.disabled = false;
                        unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.op_failed', e.message));
                    unstageBtn.disabled = false;
                    unstageBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.unstage_from_git');
                });
            });
            actionBar.appendChild(unstageBtn);
        }

        // 插入到 header 后面、content 前面
        var content = gitDiffViewer.querySelector('.git-viewer-content');
        if (content) {
            gitDiffViewer.insertBefore(actionBar, content);
        }
    }

    // ---- Diff Viewer：渲染 diff 文本（左右并排：基础版本 | 本地修改）----
    // 后端返回标准 unified diff，这里解析为两列对照视图：
    // 删除行落左侧，新增行落右侧；一段连续的删/增按行配对（左旧右新 = 修改），
    // 数量不等时多出的行另一侧留空占位；上下文行两侧同时显示。
    function renderViewerDiff(raw) {
        if (!gitViewerContent) return;
        var lines = (raw || '').split('\n');
        var hunkRe = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
        var oldNo = 0, newNo = 0;
        var rows = [];              // {hunk:true,text} | {lcls,ln,lt,rcls,rn,rt}
        var delBuf = [], addBuf = [];

        // 把缓冲的删除/新增行按位配对刷入 rows
        function flushPair() {
            var n = Math.max(delBuf.length, addBuf.length);
            for (var k = 0; k < n; k++) {
                var d = delBuf[k], a = addBuf[k];
                rows.push({
                    lcls: d ? 'del' : 'empty', ln: d ? d.no : '', lt: d ? d.text : '',
                    rcls: a ? 'add' : 'empty', rn: a ? a.no : '', rt: a ? a.text : ''
                });
            }
            delBuf = []; addBuf = [];
        }

        for (var i = 0; i < lines.length; i++) {
            var rawLine = lines[i];
            // 跳过 diff 元信息行（两列视图中无意义）
            if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ')
                || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')
                || rawLine.startsWith('new file') || rawLine.startsWith('deleted file')
                || rawLine.startsWith('old mode') || rawLine.startsWith('new mode')
                || rawLine.startsWith('similarity ') || rawLine.startsWith('rename ')
                || rawLine.startsWith('\\ No newline')) {
                continue;
            }
            if (rawLine.startsWith('@@')) {
                flushPair();
                var m = rawLine.match(hunkRe);
                if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
                rows.push({ hunk: true, text: rawLine });
            } else if (rawLine.startsWith('-')) {
                delBuf.push({ no: oldNo++, text: rawLine.substring(1) });
            } else if (rawLine.startsWith('+')) {
                addBuf.push({ no: newNo++, text: rawLine.substring(1) });
            } else {
                // 上下文行（以空格开头或空行）
                flushPair();
                var ctx = rawLine.startsWith(' ') ? rawLine.substring(1) : rawLine;
                rows.push({ lcls: 'ctx', ln: oldNo++, lt: ctx, rcls: 'ctx', rn: newNo++, rt: ctx });
            }
        }
        flushPair();

        function cell(cls, num, text) {
            return '<div class="git-split-side git-split-' + cls + '">'
                + '<span class="git-split-num">' + (num !== '' ? num : '') + '</span>'
                + '<span class="git-split-text">' + (text === '' ? ' ' : escapeHtml(text)) + '</span>'
                + '</div>';
        }

        var html = '<div class="git-split-head">'
            + '<div class="git-split-head-cell">' + GourdI18n.t('git.base_version') + '</div>'
            + '<div class="git-split-head-cell">' + GourdI18n.t('git.local_mod') + '</div>'
            + '</div>';
        html += '<div class="git-split-body">';
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            if (row.hunk) {
                html += '<div class="git-split-hunk">' + escapeHtml(row.text) + '</div>';
            } else {
                html += '<div class="git-split-row">' + cell(row.lcls, row.ln, row.lt) + cell(row.rcls, row.rn, row.rt) + '</div>';
            }
        }
        html += '</div>';
        gitViewerContent.innerHTML = html;
        gitViewerContent.classList.add('git-viewer-split');
        gitViewerContent.scrollTop = 0;
    }

    // ---- Diff Viewer：关闭，恢复原始视图 ----
    function closeDiffViewer() {
        if (!gitDiffViewer) return;
        gitDiffViewer.style.display = 'none';
        diffViewerActive = false;

        // 清理操作栏
        var oldActions = gitDiffViewer.querySelector('.git-viewer-actions');
        if (oldActions) oldActions.remove();

        // 解除对编辑器列的接管（code 模式下让 #codeEditorPane 重新显示）
        try { document.body.classList.remove('viewer-open'); } catch (e) {}

        // 关键：必须先清除两个视图的内联 display 样式
        // 因为 chatView 的可见性由 CSS .active 类控制（.chat-view.active { display: flex }）
        // 如果残留 style="display:none"，会覆盖 CSS 类规则，导致视图空白
        if (chatView) chatView.style.display = '';
        if (welcomeView) welcomeView.style.display = '';

        // code 模式：中间编辑器列的三态（欢迎/空态/编辑器/审查占位）由 refreshCenterPane 统一恢复
        if (window.appMode === 'code' && typeof window.refreshCenterPane === 'function') {
            window.refreshCenterPane();
            return;
        }

        // chat 模式：根据当前视图恢复正确的可见性
        // chatView 可见性由 .active 类控制（CSS 规则），无需额外操作
        // welcomeView 仅在非聊天模式下可见
        if (chatView && chatView.classList.contains('active')) {
            welcomeView.style.display = 'none';
        }
    }

    if (gitViewerClose) {
        gitViewerClose.addEventListener('click', closeDiffViewer);
    }

    // ESC 关闭 diff viewer
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && diffViewerActive) {
            closeDiffViewer();
        }
    });

    // ---- AI 生成变更摘要（专用 HTTP 接口）----
    var gitSummaryBtn = document.getElementById('gitSummaryBtn');
    var isGeneratingSummary = false;

    if (gitSummaryBtn) {
        gitSummaryBtn.addEventListener('click', function() {
            if (isGeneratingSummary) return;

            var files = getSelectedFiles();
            if (files.length === 0) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.check_at_least_one'), 'error');
                else layAlert(GourdI18n.t('git.check_at_least_one'));
                return;
            }

            isGeneratingSummary = true;
            gitSummaryBtn.disabled = true;
            gitSummaryBtn.classList.add('loading');
            gitSummaryBtn.innerHTML = GourdI18n.t('git.generating');
            if (gitCommitMsg) gitCommitMsg.value = '';

            // 获取当前会话的 sessionId
            var currentSessionId = (typeof activeSessionId !== 'undefined') ? activeSessionId : '';

            fetch('/web/chat/git/summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'sessionId=' + encodeURIComponent(currentSessionId)
                    + '&paths=' + encodeURIComponent(JSON.stringify(files))
                    + (gitRoot() ? '&root=' + encodeURIComponent(gitRoot()) : '')
            })
            .then(function(r) { return r.json(); })
            .then(function(res) {
                if (res && res.code === 200 && res.data) {
                    var summary = res.data.summary || '';
                    if (gitCommitMsg) {
                        gitCommitMsg.value = summary;
                        gitCommitMsg.style.height = 'auto';
                        gitCommitMsg.style.height = Math.min(gitCommitMsg.scrollHeight, 80) + 'px';
                    }
                } else {
                    var errMsg = (res && res.description) || GourdI18n.t('git.unknown_error');
                    if (typeof showToast === 'function') showToast(GourdI18n.t('git.summary_failed', errMsg), 'error');
                    else layAlert(GourdI18n.t('git.summary_failed', errMsg));
                }
            })
            .catch(function(e) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.summary_failed', e.message), 'error');
                else layAlert(GourdI18n.t('git.summary_failed', e.message));
            })
            .finally(function() {
                isGeneratingSummary = false;
                if (gitSummaryBtn) {
                    gitSummaryBtn.disabled = false;
                    gitSummaryBtn.classList.remove('loading');
                    gitSummaryBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4V2"/><path d="M15 16v-2"/><path d="M8 9h2"/><path d="M20 9h2"/><path d="M17.8 11.8L19 13"/><path d="M15 9h.01"/><path d="M17.8 6.2L19 5"/><path d="m3 21 9-9"/><path d="M12.2 6.2L11 5"/></svg> ' + GourdI18n.t('git.gen_summary');
                }
            });
        });
    }

    // ---- Git 提交（精确文件列表）----
    var isCommitting = false;
    if (gitCommitBtn) {
        gitCommitBtn.addEventListener('click', function() {
            if (isCommitting) return;
            var msg = (gitCommitMsg && gitCommitMsg.value.trim()) || '';
            if (!msg) {
                gitCommitMsg && gitCommitMsg.focus();
                gitCommitMsg && gitCommitMsg.classList.add('shake');
                var origPH = gitCommitMsg.placeholder;
                gitCommitMsg.placeholder = GourdI18n.t('git.input_commit_msg');
                setTimeout(function() {
                    gitCommitMsg && gitCommitMsg.classList.remove('shake');
                    gitCommitMsg.placeholder = origPH;
                }, 1200);
                return;
            }
            var files = getSelectedFiles();
            if (files.length === 0) {
                if (typeof showToast === 'function') showToast(GourdI18n.t('git.check_at_least_one'), 'error');
                return;
            }

            isCommitting = true;
            gitCommitBtn.disabled = true;
            gitCommitBtn.innerHTML = '<span style="opacity:0.7">' + GourdI18n.t('git.committing') + '</span>';

            fetch('/web/chat/git/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg, files: files, root: gitRoot() })
            })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        if (gitCommitMsg) {
                            gitCommitMsg.value = '';
                            gitCommitMsg.style.height = '30px';
                        }
                        loadGitStatus();
                        // 提交成功，不显示提示
                    } else {
                        layAlert(GourdI18n.t('git.commit_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.commit_failed', e.message));
                })
                .finally(function() {
                    isCommitting = false;
                    gitCommitBtn.disabled = false;
                    gitCommitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ' + GourdI18n.t('git.commit');
                });
        });

        // Enter 键提交
        if (gitCommitMsg) {
            gitCommitMsg.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    gitCommitBtn.click();
                }
            });
            // textarea 自动增高（最多4行）
            gitCommitMsg.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 80) + 'px';
            });
        }
    }

    // ---- 初始化 Git 仓库 ----
    if (gitInitBtn) {
        gitInitBtn.addEventListener('click', function() {
            if (isInitializing) return;
            isInitializing = true;
            gitInitBtn.disabled = true;
            gitInitBtn.textContent = GourdI18n.t('git.initializing');

            var doCommit = gitInitCommit && gitInitCommit.checked;
            fetch('/web/chat/git/init?initialCommit=' + (doCommit ? 'true' : 'false') + gitRootQ(), { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function(res) {
                    if (res && res.code === 200) {
                        loadGitStatus();
                    } else {
                        layAlert(GourdI18n.t('git.init_failed', (res && res.data && res.data.message) || GourdI18n.t('git.unknown_error')));
                        gitInitBtn.disabled = false;
                        gitInitBtn.innerHTML =
                            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.init_repo');
                    }
                })
                .catch(function(e) {
                    layAlert(GourdI18n.t('git.init_failed', e.message));
                    gitInitBtn.disabled = false;
                    gitInitBtn.innerHTML =
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> ' + GourdI18n.t('git.init_repo');
                })
                .finally(function() {
                    isInitializing = false;
                });
        });
    }

    // ---- Badge 更新 ----
    function updateBadge(count) {
        if (!gitBadge) return;
        if (count > 0) {
            gitBadge.textContent = count > 99 ? '99+' : count;
            gitBadge.style.display = 'inline';
        } else {
            gitBadge.style.display = 'none';
        }
    }

    // ---- WebSocket 联动：文件变更时刷新 git status ----
    var origOnFilerChange = window.onFilerChange;
    window.onFilerChange = function(chunk) {
        if (origOnFilerChange) origOnFilerChange(chunk);

        // 如果当前在 Git 视图上且面板可见，debounce 后刷新
        if (window.filerView === 'gitdiff' && gitDiffPanel && gitDiffPanel.style.display !== 'none') {
            clearTimeout(window._gitDiffRefreshTimer);
            window._gitDiffRefreshTimer = setTimeout(loadGitStatus, 1500);
        } else {
            // 不在 Git 视图上，后台静默刷新 badge
            clearTimeout(window._gitBadgeRefreshTimer);
            window._gitBadgeRefreshTimer = setTimeout(loadGitStatus, 2000);
        }
    };

    // ---- 工具函数 ----
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // ---- 初始化 ----
    loadGitStatus();
    // 每60秒兜底刷新
    setInterval(loadGitStatus, 60000);

    // 暴露全局（供 app-filer.js / app-message.js 调用）
    window.loadGitStatus = loadGitStatus;
    window.openFileViewer = openFileViewer;
    window.closeDiffViewer = closeDiffViewer;
    window.guessLang = guessLang;
})();
