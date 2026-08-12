/* ===== app-code.js ===== */
/* Code 模式控制器：模式切换 + CodeMirror 编辑器（多标签/保存）+ 项目选择器
   依赖：app-base.js（appMode/currentProjectRoot/newSessionId/getSessionCwd）、
        app-filer.js（window.loadTree/clearFilerTree）、app-history.js（loadSessionHistory 等）
   本文件最后加载，可安全覆盖 window.openFileViewer 等。 */

(function () {
    // ---------- DOM ----------
    var $body = $('body');
    var modeBtn = document.getElementById('modeSwitchBtn');
    var projSelector = document.getElementById('projectSelector');
    var projCurrent = document.getElementById('projectSelectorCurrent');
    var projName = document.getElementById('projectSelectorName');
    var projDropdown = document.getElementById('projectDropdown');

    var editorPane = document.getElementById('codeEditorPane');
    var editorEmpty = document.getElementById('codeEditorEmpty');
    var gitEmpty = document.getElementById('codeGitEmpty');
    var editorMainEl = document.getElementById('codeEditorMain');
    // 未选项目时的欢迎面板
    var welcomePane = document.getElementById('codeProjectWelcome');
    var welcomeRecentEl = document.getElementById('codeWelcomeRecent');
    var welcomeOpenBtn = document.getElementById('codeWelcomeOpenBtn');
    var welcomeNewBtn = document.getElementById('codeWelcomeNewBtn');
    var tabbar = document.getElementById('codeEditorTabbar');
    var editorHost = document.getElementById('codeEditorHost');
    var statusPath = document.getElementById('codeEditorStatusPath');
    var statusLang = document.getElementById('codeEditorStatusLang');
    var dirtyEl = document.getElementById('codeEditorDirty');
    var saveBtn = document.getElementById('codeEditorSaveBtn');

    // ---------- 状态 ----------
    var LS_MODE = 'gourdai-app-mode';
    var LS_PROJECT = 'gourdai-code-project';
    var projects = [];            // [{name, path}]
    var projectsLoaded = false;     // 项目列表是否已加载过（供新窗口启动判断能否立即 selectProject）
    var homeDir = '';             // 用户主目录（/web/chat/meta 提供，用于新建项目预填父目录）
    var openFiles = [];           // [{path, name, doc, cm-independent state}]
    var activeFilePath = null;
    var cm = null;                // CodeMirror 实例（单实例，切换 doc）
    var docs = {};                // path -> {doc, clean(generation), lang}

    // 一次性拉取用户主目录，作为“新建项目”对话框的默认父目录
    // （桌面端等后端就绪再拉，避免冷启动占用连接；浏览器端立即执行）
    __whenBackendReady(function () {
        $.get('/web/chat/meta', function (resp) {
            var meta = (resp && resp.data) ? resp.data : resp;
            if (meta && meta.homeDir) homeDir = meta.homeDir;
        });
    });

    // ---------- CodeMirror 初始化 ----------
    function ensureEditor() {
        if (cm) return cm;
        if (typeof CodeMirror === 'undefined') return null;
        cm = CodeMirror(editorHost, {
            value: '',
            lineNumbers: true,
            lineWrapping: false,
            matchBrackets: true,
            autoCloseBrackets: true,
            styleActiveLine: true,
            scrollbarStyle: 'overlay',
            indentUnit: 4,
            tabSize: 4,
            theme: currentCmTheme()
        });
        cm.setSize('100%', '100%');
        cm.on('change', function () {
            if (!activeFilePath) return;
            var st = docs[activeFilePath];
            if (!st) return;
            var isClean = cm.isClean(st.clean);
            markDirty(activeFilePath, !isClean);
        });
        // Ctrl/Cmd+S 保存
        cm.setOption('extraKeys', {
            'Ctrl-S': function () { saveActive(); },
            'Cmd-S': function () { saveActive(); }
        });
        return cm;
    }

    function currentCmTheme() {
        var theme = document.body.getAttribute('data-theme');
        return theme === 'dark' ? 'material-darker' : 'default';
    }
    // 主题切换时同步编辑器主题（监听 body data-theme 变化）
    if (window.MutationObserver) {
        new MutationObserver(function () {
            if (cm) cm.setOption('theme', currentCmTheme());
        }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
    }

    function guessCmMode(fileName) {
        if (typeof CodeMirror !== 'undefined' && CodeMirror.findModeByFileName) {
            var info = CodeMirror.findModeByFileName(fileName);
            if (info) return { mode: info.mode, mime: info.mime, label: info.name };
        }
        return { mode: null, mime: 'text/plain', label: '' };
    }

    // ---------- 模式切换 ----------
    function isCode() { return window.appMode === 'code'; }

    function enterCodeMode(opts) {
        if (isCode()) return;
        // 关闭进入前 chat 模式可能残留的文件查看浮层（与 #gitDiffViewer 共用），
        // 否则切到 code 后 body.viewer-open 会连带隐藏编辑器面板、悬留旧浮层。
        if (typeof window.closeDiffViewer === 'function') window.closeDiffViewer();
        window.appMode = 'code';
        // 项目新窗口启动直达 code 模式时不写持久化（opts.persistMode===false）：
        // 避免连带把主窗口的模式记忆改成 code（各窗口模式互不干扰）
        if (!opts || opts.persistMode !== false) {
            try { localStorage.setItem(LS_MODE, 'code'); } catch (e) {}
        }
        $body.addClass('code-mode');
        if (modeBtn) { modeBtn.classList.add('code-active'); modeBtn.title = GourdI18n.t('code.switch_to_chat'); }
        // 项目选择器位于文件树顶部，随 code 模式面板一并显示（CSS 控制），无需手动 toggle
        // code 模式始终使用 chatInput 输入
        window.inChatMode = true;
        if (typeof switchToChatMode === 'function') switchToChatMode();
        // 同步文件视图状态（app-gitdiff.js 初始化时已按 localStorage 设好 window.filerView，
        // 这里确保 body[data-filer-view] 反映之，驱动 CSS 显隐中间编辑器）
        if (!window.filerView) window.filerView = 'files';
        try { document.body.dataset.filerView = window.filerView; } catch (e) {}
        // 先记住上次活动会话：下面的 startFreshSession() 会 forgetActiveSession() 清掉它，
        // 而 code 会话列表是异步加载的、其回调里才调 restoreActiveSession()——若不先存下来，
        // 冷启动进 code 模式就永远恢复不了上次会话（只会停在新草稿）。加载完列表后再写回。
        var savedActive = null;
        try { savedActive = localStorage.getItem('gourdai-active-session'); } catch (e) {}
        // 只有 code 前缀的会话才需要恢复（web 前缀说明用户上次在 chat 模式）
        var isCodeSession = savedActive && savedActive.indexOf('code-') === 0;
        // 先建一个当前模式（code-）的空会话，右栏立即可见
        startFreshSession();
        // 立即按当前项目状态刷新中间区（未选项目→欢迎面板），避免异步加载前闪现旧空态
        refreshCenterPane();
        // 恢复上次项目
        var saved = null;
        try { saved = localStorage.getItem(LS_PROJECT); } catch (e) {}
        loadProjects(function () {
            // 项目新窗口启动时携带的目标项目根（__bootProjectOverride），优先打开它
            var bootProj = window.__bootProjectOverride;
            window.__bootProjectOverride = null;
            if (bootProj) {
                selectProject(bootProj, true);
            } else if (saved && projects.some(function (p) { return p.path === saved; })) {
                selectProject(saved, true);
            } else if (projects.length > 0) {
                selectProject(projects[0].path, true);
            } else {
                // 无项目：清空树与编辑器，提示选择
                window.currentProjectRoot = '';
                if (typeof window.clearFilerTree === 'function') window.clearFilerTree();
                refreshEditorEmpty();
                if (projName) projName.textContent = GourdI18n.t('code.select_project');
            }
            // 写回上次活动会话 id，供 loadSessionHistory 响应后的 restoreActiveSession 命中并恢复
            if (isCodeSession && typeof window.rememberActiveSession === 'function') {
                window.rememberActiveSession(savedActive);
            }
            // 若没有可恢复的 code 会话，直接选中列表中第一个（最近的对话）
            if (!isCodeSession) {
                setTimeout(function () {
                    if ((window.chatHistory || []).length > 0 && window.currentChatIndex === -1) {
                        if (typeof selectSession === 'function') selectSession(0);
                    }
                }, 350);
            }
            // 项目根已确定，此时才按所选项目加载 code 会话列表
            // （必须放在 loadProjects 回调内：否则会用空 root 抓到安装目录的全局会话）
            reloadSessionsForMode();
        });
    }

    function exitCodeMode() {
        if (!isCode()) return;
        // 先缓存当前 code 会话 ID，稍后在 startFreshSession 清空 localStorage 后写回
        var codeSessionId = window.SESSION_ID;
        window.appMode = 'chat';
        try { localStorage.setItem(LS_MODE, 'chat'); } catch (e) {}
        $body.removeClass('code-mode');
        if (modeBtn) { modeBtn.classList.remove('code-active'); modeBtn.title = GourdI18n.t('code.switch_to_code'); }
        window.currentProjectRoot = '';
        // 关闭可能残留的「变更详情」Git 审查浮层：它靠内联 display + body.viewer-open 控制显隐，
        // 不受 body.code-mode CSS 约束，若不显式关闭，切回 chat 后会继续悬留在中间区。
        if (typeof window.closeDiffViewer === 'function') window.closeDiffViewer();
        // 回到 chat：新建 chat 会话 + 刷新 chat 会话列表
        startFreshSession();
        // 在 startFreshSession 之后写回，避免被其内部的 forgetActiveSession 清空
        if (typeof rememberActiveSession === 'function') rememberActiveSession(codeSessionId);
        reloadSessionsForMode();
    }

    function toggleMode() { if (isCode()) exitCodeMode(); else enterCodeMode(); }

    // 新建当前模式的空会话（不切欢迎页，code 模式保持右栏对话可见）
    function startFreshSession() {
        if (typeof forgetActiveSession === 'function') forgetActiveSession();
        window.SESSION_ID = window.newSessionId();
        // 继承当前对话的模型/思考档位到新会话（写缓存），必须在 setActiveSession 之前，
        // 否则 code 模式下同样会被 refreshSessionModel 拉后端默认覆盖。
        if (typeof window.inheritSelectionToSession === 'function') window.inheritSelectionToSession(window.SESSION_ID);
        window.currentChatIndex = -1;
        if (typeof deactivateSession === 'function') deactivateSession();
        if (isCode()) {
            window.inChatMode = true;
            if (typeof setActiveSession === 'function') setActiveSession(window.SESSION_ID);
            $(document.getElementById('welcomeView')).hide();
            $(document.getElementById('chatView')).addClass('active');
        } else {
            if (typeof switchToWelcomeMode === 'function') switchToWelcomeMode();
        }
        if (typeof updateHistoryUI === 'function') updateHistoryUI();
    }

    function reloadSessionsForMode() {
        if (typeof loadSessionHistory === 'function') loadSessionHistory();
        // 稍后渲染右栏会话下拉（loadSessionHistory 是异步的，用短延迟拿到最新 chatHistory）
        setTimeout(renderCodeSessions, 300);
    }

    // ---------- Code 模式右栏：会话标签页 + 新建 ----------
    var codeChatTabs = document.getElementById('codeChatTabs');
    var codeChatNewBtn = document.getElementById('codeChatNewBtn');
    var _codeTabsLastHtml = '';    // 差异守卫：流式重渲染时不重写 innerHTML（避免重置横向滚动）
    var _codeTabsLastActive = -1;  // 仅当 active 变化时才 scrollIntoView

    function renderCodeSessions() {
        if (!codeChatTabs) return;
        var hist = window.chatHistory || [];
        var html = '';
        // 标签只显示序号（不再塞入长标题，避免会话一多就挤成一团）；完整标题作为鼠标悬停提示。
        // 序号按会话创建先后：最早的为 1，越新序号越大并排在越靠后（右侧），新建的追加到末尾。
        // chatHistory 是「最新在前」（index 0 = 最新），故倒序遍历，序号 = hist.length - i。
        for (var i = hist.length - 1; i >= 0; i--) {
            var sess = (typeof sessionMap !== 'undefined') ? sessionMap[hist[i].sessionId] : null;
            var streaming = sess && sess.isStreaming;
            var active = (i === window.currentChatIndex);
            var num = hist.length - i;   // 最早的会话序号为 1
            html += '<div class="code-chat-tab' + (active ? ' active' : '') + (streaming ? ' streaming' : '') + '" data-idx="' + i + '" title="' + escAttr(hist[i].label) + '">'
                + (streaming ? '<span class="code-chat-tab-spin"></span>' : '')
                + '<span class="code-chat-tab-label">' + num + '</span>'
                + '<button class="code-chat-tab-close" data-idx="' + i + '" title="' + GourdI18n.t('code.close_session') + '">&times;</button>'
                + '</div>';
        }
        // 新建但未发送的会话（尚未进入 chatHistory）：追加到末尾，用空心点 + 下一个序号标识
        if (window.currentChatIndex === -1) {
            html += '<div class="code-chat-tab active draft" data-idx="-1" title="' + GourdI18n.t('code.new_dialog_unsent') + '">'
                + '<span class="code-chat-tab-dot"></span>'
                + '<span class="code-chat-tab-label">' + (hist.length + 1) + '</span>'
                + '<button class="code-chat-tab-close" data-idx="-1" title="' + GourdI18n.t('code.close') + '">&times;</button>'
                + '</div>';
        }
        if (html !== _codeTabsLastHtml) { codeChatTabs.innerHTML = html; _codeTabsLastHtml = html; }
        renderCodeChatListMenu(hist);
        if (window.currentChatIndex !== _codeTabsLastActive) {
            _codeTabsLastActive = window.currentChatIndex;
            var el = codeChatTabs.querySelector('.code-chat-tab.active');
            if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    window.renderCodeSessions = renderCodeSessions;

    var codeChatList = document.getElementById('codeChatList');
    var codeChatListBtn = document.getElementById('codeChatListBtn');
    var codeChatListMenu = document.getElementById('codeChatListMenu');

    // 「所有会话」下拉：列出全部会话的完整标题，一键跳转。会话再多也能一眼定位、直接切换。
    function renderCodeChatListMenu(hist) {
        if (!codeChatListMenu) return;
        hist = hist || (window.chatHistory || []);
        var html = '';
        if (hist.length === 0) {
            html = '<div class="code-chat-list-empty">' + GourdI18n.t('code.no_sessions') + '</div>';
        } else {
            // 与标签一致：序号最早为 1，菜单里按序号升序（最早在上）排列
            for (var i = hist.length - 1; i >= 0; i--) {
                var sess = (typeof sessionMap !== 'undefined') ? sessionMap[hist[i].sessionId] : null;
                var streaming = sess && sess.isStreaming;
                var active = (i === window.currentChatIndex);
                var num = hist.length - i;
                html += '<div class="code-chat-list-item' + (active ? ' active' : '') + '" data-idx="' + i + '">'
                    + '<span class="code-chat-list-item-num">' + num + '</span>'
                    + '<span class="code-chat-list-item-title">' + escHtml(hist[i].label || (GourdI18n.t('code.session') + ' ' + num)) + '</span>'
                    + (streaming ? '<span class="code-chat-list-item-spin"></span>' : '')
                    + '</div>';
            }
        }
        codeChatListMenu.innerHTML = html;
    }

    if (codeChatListBtn) {
        codeChatListBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            $(codeChatList).toggleClass('open');
        });
    }
    if (codeChatListMenu) {
        codeChatListMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.code-chat-list-item');
            if (!item) return;
            $(codeChatList).removeClass('open');
            var idx = parseInt(item.getAttribute('data-idx'));
            if (idx === window.currentChatIndex) return;
            if (typeof selectSession === 'function') selectSession(idx);
        });
    }
    document.addEventListener('click', function () { $(codeChatList).removeClass('open'); });

    if (codeChatTabs) {
        codeChatTabs.addEventListener('click', function (e) {
            var close = e.target.closest('.code-chat-tab-close');
            if (close) {
                e.stopPropagation();
                var di = parseInt(close.getAttribute('data-idx'));
                if (di === -1) {
                    // 关闭未发送的草稿：有历史则切到最近一个，否则重开一个空草稿
                    if ((window.chatHistory || []).length > 0) {
                        if (typeof selectSession === 'function') selectSession(0);
                    } else {
                        startFreshSession();
                    }
                    renderCodeSessions();
                    return;
                }
                if (typeof deleteSession === 'function') deleteSession(di); // 异步、带 layConfirm；经 updateHistoryUI 重渲染
                return;
            }
            var tab = e.target.closest('.code-chat-tab');
            if (tab) {
                var idx = parseInt(tab.getAttribute('data-idx'));
                if (idx === -1) return; // 草稿标签已激活，无需切换
                if (typeof selectSession === 'function') selectSession(idx); // → updateHistoryUI → renderCodeSessions
            }
        });
    }
    if (codeChatNewBtn) {
        codeChatNewBtn.addEventListener('click', function () {
            startFreshSession();
            renderCodeSessions();
        });
    }

    // ---------- 项目选择器 ----------
    function loadProjects(cb) {
        $.get('/web/chat/projects', function (resp) {
            projects = (resp && resp.data) ? resp.data : [];
            projectsLoaded = true;
            renderProjectDropdown();
            renderWelcomeRecent();
            if (cb) cb();
        }).fail(function () { projectsLoaded = true; if (cb) cb(); });
    }

    function renderProjectDropdown() {
        if (!projDropdown) return;
        var html = '';
        if (projects.length === 0) {
            html += '<div class="project-dropdown-empty">' + GourdI18n.t('code.no_projects') + '</div>';
        } else {
            for (var i = 0; i < projects.length; i++) {
                var p = projects[i];
                var active = (p.path === window.currentProjectRoot) ? ' active' : '';
                html += '<div class="project-dropdown-item' + active + '" data-path="' + escAttr(p.path) + '">'
                    + '<div class="project-dropdown-item-info">'
                    + '<div class="project-dropdown-item-name">' + escHtml(p.name) + '</div>'
                    + '<div class="project-dropdown-item-path">' + escHtml(p.path) + '</div>'
                    + '</div>'
                    + '<button class="project-dropdown-item-del" title="' + GourdI18n.t('code.remove_no_delete') + '" data-path="' + escAttr(p.path) + '">'
                    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
                    + '</button>'
                    + '</div>';
            }
        }
        html += '<div class="project-dropdown-add" id="projectAddBtn">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + GourdI18n.t('code.open_folder') + '</div>';
        html += '<div class="project-dropdown-add" id="projectNewBtn">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>'
            + GourdI18n.t('code.new_project') + '</div>';
        projDropdown.innerHTML = html;
    }

    // ---------- 项目打开方式：本窗口 / 新窗口 ----------
    // 桌面端（Electron）选择其它项目时，先询问在本窗口打开还是新窗口打开；
    // 「新窗口」经 IPC 由主进程新开一个原生窗体（非浏览器窗口）加载同一 UI 并打开该项目。
    // 浏览器端无 IPC，或重新选择当前项目时，退回原有的本窗口切换行为。
    function askHowToOpenProject(path) {
        if (!path) return;
        if (path === window.currentProjectRoot) { $(projSelector).removeClass('open'); return; }
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.openProjectWindow !== 'function') { selectProject(path); return; }
        var name = path;
        for (var i = 0; i < projects.length; i++) { if (projects[i].path === path) { name = projects[i].name; break; } }
        var html = '<div class="kd-confirm">'
            + '<div class="kd-confirm-msg">' + GourdI18n.t('code.open_project_where', [name]) + '</div>'
            + '<div class="kd-confirm-btns">'
            + '<button class="kd-btn kd-btn-cancel" id="opwCancel">' + GourdI18n.t('base.cancel') + '</button>'
            + '<button class="kd-btn" id="opwThis">' + GourdI18n.t('code.open_in_this_window') + '</button>'
            + '<button class="kd-btn kd-btn-ok" id="opwNew">' + GourdI18n.t('code.open_in_new_window') + '</button>'
            + '</div></div>';
        var idx = layer.open({
            type: 1, content: html, title: false, closeBtn: 0, shade: 0.3, shadeClose: false,
            skin: 'kd-layer', area: 'auto',
            success: function (layero) {
                layero.find('#opwCancel').on('click', function () { layer.close(idx); });
                layero.find('#opwThis').on('click', function () { layer.close(idx); selectProject(path); });
                layero.find('#opwNew').on('click', function () { layer.close(idx); openProjectInNewWindow(path); });
            }
        });
    }

    // 新窗口打开项目：由主进程新开一个原生窗体（BrowserWindow），
    // 共享同一本地 UI 服务器与后端，直接以 code 模式打开该项目。
    // IPC 异常时回退为本窗口切换，不丢失用户操作。
    function openProjectInNewWindow(path) {
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.openProjectWindow !== 'function') { selectProject(path); return; }
        Promise.resolve(ipc.openProjectWindow(path)).catch(function () { selectProject(path); });
    }

    function selectProject(path, silent) {
        // 切项目会关闭全部打开文件；有未保存改动时先确认，取消则中止切换、保留文件与当前项目。
        // 启动期无打开文件，hasUnsavedFiles() 为假，不会打断自动恢复流程。
        if (path !== window.currentProjectRoot && !confirmDiscardUnsavedIfAny()) return;
        window.currentProjectRoot = path;
        // 同步项目相关视图 + 持久化项目根（名称/下拉/文件树/已开文件/Git/终端）
        syncProjectContext(path);
        // 刷新 code 会话列表（按该项目）——仅项目选择器主动切项目时需要；
        // 从「会话切换」间接触发时不重载列表（避免把当前历史列表刷掉）。
        if (!silent) reloadSessionsForMode();
    }

    // 把「所选项目」相关的 UI 副作用集中到一处，供 selectProject 与「切换历史会话时恢复项目根」共用。
    // 负责持久化项目根 + 刷新项目相关视图；不写 currentProjectRoot（由各调用方先设好），
    // 也不重载会话列表（避免递归/覆盖当前列表）。
    function syncProjectContext(path) {
        try { localStorage.setItem(LS_PROJECT, path); } catch (e) {}
        var p = null;
        for (var i = 0; i < projects.length; i++) { if (projects[i].path === path) { p = projects[i]; break; } }
        if (projName) projName.textContent = p ? p.name : (path || GourdI18n.t('code.select_project'));
        renderProjectDropdown();
        // 重新加载文件树
        if (typeof window.loadTree === 'function') window.loadTree();
        // 登记后端文件监听根：项目目录的外部修改才能实时推送 filer_change
        notifyWatchRoot(path);
        // 关闭所有已打开文件（切项目后旧文件失效）
        closeAllFiles();
        // 刷新 Git 审查（按所选项目仓库）
        if (typeof window.loadGitStatus === 'function') window.loadGitStatus();
        // 通知终端：项目根变更，若终端开着则重连到新目录
        if (typeof window.onCodeProjectChanged === 'function') window.onCodeProjectChanged();
        // 桌面端：同步窗口标题为当前项目名（主窗口与项目新窗口共用此逻辑）
        updateWindowTitle(p ? p.name : path);
    }
    // 桌面端窗口标题：显示当前项目名，多窗口并存时便于区分
    function updateWindowTitle(name) {
        var ipc = window.__GOURD_IPC__;
        if (!ipc || typeof ipc.setWindowTitle !== 'function') return;
        var base = GourdI18n.t('app.title');
        ipc.setWindowTitle(name ? (base + ' - ' + name) : base);
    }
    window.syncProjectContext = syncProjectContext;

    // 语言切换时：刷新项目选择器显示名称（有选中项目则显示名称，否则更新翻译后的提示）
    document.addEventListener('i18n:localeChanged', function () {
        if (!projName) return;
        var p = null;
        if (currentProjectRoot) {
            for (var i = 0; i < projects.length; i++) {
                if (projects[i].path === currentProjectRoot) { p = projects[i]; break; }
            }
        }
        projName.textContent = p ? p.name : GourdI18n.t('code.select_project');
    });

    function addProject() {
        var doAdd = function (path) {
            if (!path) return;
            $.ajax({
                url: '/web/chat/projects/add', method: 'POST', contentType: 'application/json',
                data: JSON.stringify({ path: path })
            }).done(function (resp) {
                if (resp && resp.code === 200) {
                    projects = resp.data || [];
                    renderProjectDropdown();
                    renderWelcomeRecent();
                    // 新加的项目：与其它项目入口一致，询问「本窗口打开 / 新窗口打开」
                    if (projects.length) {
                        var addedPath = '';
                        for (var j = 0; j < projects.length; j++) {
                            if (projects[j].path === path) { addedPath = path; break; }
                        }
                        if (!addedPath) addedPath = projects[0].path;
                        if (addedPath !== window.currentProjectRoot) askHowToOpenProject(addedPath);
                    }
                    if (typeof showToast === 'function') showToast(GourdI18n.t('code.project_added'), 'success');
                } else {
                    if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.add_failed_no_dir'), 'error');
                }
            }).fail(function () {
                if (typeof showToast === 'function') showToast(GourdI18n.t('code.add_failed'), 'error');
            });
        };
        openDirPicker(doAdd);
    }

    // ---------- 新建项目（在父目录下建一个新目录并登记为项目）----------
    function newProject() {
        var defaultParent = homeDir ? joinPath(homeDir, 'gourdai-projects') : '';
        var html = ''
            + '<div class="new-project-dialog">'
            + '  <div class="new-project-row">'
            + '    <label class="new-project-label">' + GourdI18n.t('code.parent_dir') + '</label>'
            + '    <div class="new-project-parent">'
            + '      <input type="text" class="new-project-input" id="npParent" placeholder="' + GourdI18n.t('code.parent_dir_placeholder') + '" />'
            + '      <button class="new-project-browse" id="npBrowse" title="' + GourdI18n.t('code.browse_dir') + '">'
            + '        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            + '      </button>'
            + '    </div>'
            + '  </div>'
            + '  <div class="new-project-row">'
            + '    <label class="new-project-label">' + GourdI18n.t('code.project_name') + '</label>'
            + '    <input type="text" class="new-project-input" id="npName" placeholder="Project_name" />'
            + '  </div>'
            + '  <div class="new-project-foot">'
            + '    <button class="btn-secondary" id="npCancel">' + GourdI18n.t('code.cancel') + '</button>'
            + '    <button class="btn-primary" id="npConfirm">' + GourdI18n.t('code.confirm') + '</button>'
            + '  </div>'
            + '</div>';

        var idx = layer.open({
            type: 1, title: GourdI18n.t('code.new_project_title'), area: '460px', skin: 'kd-layer',
            content: html,
            success: function (layero) {
                var $parent = layero.find('#npParent');
                var $name = layero.find('#npName');
                $parent.val(defaultParent);
                setTimeout(function () { $name[0] && $name[0].focus(); }, 0);

                // 浏览父目录（复用服务端目录选择器）
                layero.find('#npBrowse').on('click', function () {
                    openDirPicker(function (picked) { if (picked) $parent.val(picked); });
                });

                function submit() {
                    var parent = $parent.val().trim();
                    var name = $name.val().trim();
                    if (!name) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.please_input_project_name'), 'error'); return; }
                    $.ajax({
                        url: '/web/chat/projects/create', method: 'POST', contentType: 'application/json',
                        data: JSON.stringify({ parent: parent, name: name })
                    }).done(function (resp) {
                        if (resp && resp.code === 200) {
                            layer.close(idx);
                            projects = resp.data || [];
                            renderProjectDropdown();
                            renderWelcomeRecent();
                            if (projects.length) selectProject(projects[0].path);
                            if (typeof showToast === 'function') showToast(GourdI18n.t('code.project_created'), 'success');
                        } else {
                            if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.create_failed'), 'error');
                        }
                    }).fail(function () {
                        if (typeof showToast === 'function') showToast(GourdI18n.t('code.create_failed'), 'error');
                    });
                }

                layero.find('#npConfirm').on('click', submit);
                layero.find('#npCancel').on('click', function () { layer.close(idx); });
                $name.on('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
            }
        });
    }

    // ---------- 服务端目录选择器（浏览器无法直接拿本地绝对路径，改由后端浏览）----------
    function openDirPicker(onPick) {
        var state = { current: '', parent: null, sep: '\\' };

        var html = ''
            + '<div class="dir-picker">'
            + '  <div class="dir-picker-bar">'
            + '    <button class="dir-picker-up" id="dpUp" title="' + GourdI18n.t('code.go_up') + '">'
            + '      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'
            + '    </button>'
            + '    <input type="text" class="dir-picker-path" id="dpPath" placeholder="' + GourdI18n.t('code.current_dir') + '" />'
            + '    <button class="dir-picker-go" id="dpGo">' + GourdI18n.t('code.go') + '</button>'
            + '  </div>'
            + '  <div class="dir-picker-list" id="dpList"></div>'
            + '  <div class="dir-picker-foot">'
            + '    <span class="dir-picker-hint">' + GourdI18n.t('code.select_dir_hint') + '</span>'
            + '    <div class="dir-picker-actions">'
            + '      <button class="btn-secondary" id="dpCancel">' + GourdI18n.t('code.cancel') + '</button>'
            + '      <button class="btn-primary" id="dpChoose">' + GourdI18n.t('code.select_this_dir') + '</button>'
            + '    </div>'
            + '  </div>'
            + '</div>';

        var idx = layer.open({
            type: 1, title: GourdI18n.t('code.select_project_dir'), area: ['520px', '520px'], skin: 'kd-layer',
            content: html,
            success: function (layero) {
                var $list = layero.find('#dpList');
                var $path = layero.find('#dpPath');

                function browse(p) {
                    $list.html('<div class="dir-picker-loading">' + GourdI18n.t('code.dir_loading') + '</div>');
                    $.get('/web/chat/projects/browse' + (p ? '?path=' + encodeURIComponent(p) : ''), function (resp) {
                        if (!resp || resp.code !== 200) {
                            $list.html('<div class="dir-picker-empty">' + GourdI18n.t('code.dir_access_failed') + '</div>');
                            return;
                        }
                        var d = resp.data || {};
                        state.current = d.current || '';
                        state.parent = d.parent;
                        state.sep = d.separator || '\\';
                        $path.val(state.current);
                        var dirs = d.dirs || [];
                        var h = '';
                        if (dirs.length === 0) {
                            h = '<div class="dir-picker-empty">' + GourdI18n.t('code.no_subdirs') + '</div>';
                        } else {
                            for (var i = 0; i < dirs.length; i++) {
                                h += '<div class="dir-picker-item" data-path="' + escAttr(dirs[i].path) + '">'
                                    + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                                    + '<span class="dir-picker-item-name">' + escHtml(dirs[i].name) + '</span>'
                                    + '</div>';
                            }
                        }
                        $list.html(h);
                    }).fail(function () {
                        $list.html('<div class="dir-picker-empty">' + GourdI18n.t('code.dir_load_failed') + '</div>');
                    });
                }

                // 进入子目录（单击）
                $list.on('click', '.dir-picker-item', function () {
                    browse($(this).attr('data-path'));
                });
                // 上一级
                layero.find('#dpUp').on('click', function () {
                    browse(state.parent || ''); // parent 为空回到起点（盘符列表）
                });
                // 手动前往
                layero.find('#dpGo').on('click', function () {
                    var v = $path.val().trim();
                    if (v) browse(v);
                });
                $path.on('keydown', function (e) { if (e.key === 'Enter') { var v = $path.val().trim(); if (v) browse(v); } });
                // 选定 / 取消
                layero.find('#dpChoose').on('click', function () {
                    if (!state.current) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.please_enter_dir'), 'error'); return; }
                    layer.close(idx);
                    onPick(state.current);
                });
                layero.find('#dpCancel').on('click', function () { layer.close(idx); });

                browse(''); // 起点
            }
        });
    }

    function removeProject(path) {
        $.ajax({
            url: '/web/chat/projects/remove', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ path: path })
        }).done(function (resp) {
            projects = (resp && resp.data) ? resp.data : [];
            renderProjectDropdown();
            if (path === window.currentProjectRoot) {
                if (projects.length) selectProject(projects[0].path);
                else {
                    window.currentProjectRoot = '';
                if (projName) projName.textContent = GourdI18n.t('code.select_project');
                    if (typeof window.clearFilerTree === 'function') window.clearFilerTree();
                    closeAllFiles();
                }
            }
        });
    }

    // 项目下拉交互
    if (projCurrent) {
        projCurrent.addEventListener('click', function (e) {
            e.stopPropagation();
            $(projSelector).toggleClass('open');
        });
    }
    if (projDropdown) {
        projDropdown.addEventListener('click', function (e) {
            var del = e.target.closest('.project-dropdown-item-del');
            if (del) { e.stopPropagation(); removeProject(del.getAttribute('data-path')); return; }
            var add = e.target.closest('#projectAddBtn');
            if (add) { e.stopPropagation(); $(projSelector).removeClass('open'); addProject(); return; }
            var create = e.target.closest('#projectNewBtn');
            if (create) { e.stopPropagation(); $(projSelector).removeClass('open'); newProject(); return; }
            var item = e.target.closest('.project-dropdown-item');
            if (item) {
                $(projSelector).removeClass('open');
                var picked = item.getAttribute('data-path');
                // 桌面端选择其它项目时先询问「本窗口打开 / 新窗口打开」；同项目则不动
                if (picked !== window.currentProjectRoot) askHowToOpenProject(picked);
            }
        });
    }
    document.addEventListener('click', function () { $(projSelector).removeClass('open'); });

    // ---------- 编辑器：打开 / 标签 / 保存 ----------
    // 中间区三态：未选项目→欢迎面板；已选项目未开文件→空态提示；开了文件→编辑器
    // Git 审查视图：隐藏上述编辑器三态，改显示审查占位（点变更文件仍走 #gitDiffViewer 浮层）
    function refreshCenterPane() {
        var gitView = isCode() && window.filerView === 'gitdiff';
        if (gitEmpty) gitEmpty.style.display = gitView ? 'flex' : 'none';
        if (gitView) {
            if (welcomePane) welcomePane.style.display = 'none';
            if (editorEmpty) editorEmpty.style.display = 'none';
            if (editorMainEl) editorMainEl.style.display = 'none';
            return;
        }
        var noProject = isCode() && !window.currentProjectRoot;
        var hasOpen = openFiles.length > 0;
        if (welcomePane) welcomePane.style.display = noProject ? 'flex' : 'none';
        if (editorEmpty) editorEmpty.style.display = (!noProject && !hasOpen) ? 'flex' : 'none';
        if (editorMainEl) editorMainEl.style.display = (!noProject && hasOpen) ? 'flex' : 'none';
        if (noProject) renderWelcomeRecent();
    }
    window.refreshCenterPane = refreshCenterPane;
    // 兼容旧调用点：统一走三态切换
    function refreshEditorEmpty() { refreshCenterPane(); }

    // 欢迎面板的「最近项目」列表
    function renderWelcomeRecent() {
        if (!welcomeRecentEl) return;
        if (!projects || projects.length === 0) {
            welcomeRecentEl.innerHTML = '<div class="code-welcome-recent-empty">' + GourdI18n.t('code.no_projects_empty') + '</div>';
            return;
        }
        var html = '<div class="code-welcome-recent-title">' + GourdI18n.t('code.recent_projects') + '</div>';
        for (var i = 0; i < projects.length; i++) {
            var p = projects[i];
            html += '<div class="code-welcome-recent-item" data-path="' + escAttr(p.path) + '" title="' + escAttr(p.path) + '">'
                + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                + '<div class="code-welcome-recent-info">'
                + '<div class="code-welcome-recent-name">' + escHtml(p.name) + '</div>'
                + '<div class="code-welcome-recent-path">' + escHtml(p.path) + '</div>'
                + '</div>'
                + '</div>';
        }
        welcomeRecentEl.innerHTML = html;
    }
    if (welcomeRecentEl) {
        welcomeRecentEl.addEventListener('click', function (e) {
            var item = e.target.closest('.code-welcome-recent-item');
            if (item) {
                var picked = item.getAttribute('data-path');
                if (picked === window.currentProjectRoot) return;
                askHowToOpenProject(picked);
            }
        });
    }
    if (welcomeOpenBtn) welcomeOpenBtn.addEventListener('click', function () { addProject(); });
    if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', function () { newProject(); });

    function openInEditor(path, name) {
        if (!isCode()) {
            // chat 模式仍走原只读查看器（若存在）
            if (window._origOpenFileViewer) return window._origOpenFileViewer(path, name);
            return;
        }
        ensureEditor();
        if (!cm) { if (typeof showToast === 'function') showToast(GourdI18n.t('code.editor_not_loaded'), 'error'); return; }

        // 已打开则直接激活
        if (docs[path]) { activateFile(path); return; }

        var url = '/web/chat/filer/read?path=' + encodeURIComponent(path) + rootQuery();
        $.get(url, function (resp) {
            if (!resp || resp.code !== 200) {
                if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.cannot_read_file'), 'error');
                return;
            }
            var d = resp.data || {};
            var info = guessCmMode(d.name || name || path);
            var doc = CodeMirror.Doc(d.content || '', info.mime);
            docs[path] = { doc: doc, clean: doc.changeGeneration(), lang: info.label || '', mime: info.mime };
            openFiles.push({ path: path, name: d.name || name || baseName(path) });
            renderTabs();
            activateFile(path);
        }).fail(function () {
            if (typeof showToast === 'function') showToast(GourdI18n.t('code.read_failed'), 'error');
        });
    }

    function activateFile(path) {
        var st = docs[path];
        if (!st || !cm) return;
        activeFilePath = path;
        cm.swapDoc(st.doc);
        cm.setOption('mode', st.mime);
        if (statusPath) statusPath.textContent = path;
        if (statusLang) statusLang.textContent = st.lang || '';
        markDirty(path, !cm.isClean(st.clean));
        renderTabs();
        refreshEditorEmpty();
        setTimeout(function () { if (cm) cm.refresh(); cm.focus(); }, 0);
    }

    function renderTabs() {
        if (!tabbar) return;
        var html = '';
        for (var i = 0; i < openFiles.length; i++) {
            var f = openFiles[i];
            var st = docs[f.path];
            var active = (f.path === activeFilePath) ? ' active' : '';
            var dirty = (st && st.dirty) ? ' dirty' : '';
            var diskChanged = (st && st.diskChanged && st.dirty) ? ' disk-changed' : '';
            html += '<div class="code-editor-tab' + active + dirty + diskChanged + '" data-path="' + escAttr(f.path) + '" title="' + escAttr(f.path) + '">'
                + '<span class="code-editor-tab-name">' + escHtml(f.name) + '</span>'
                + '<span class="code-editor-tab-dot"></span>'
                + '<button class="code-editor-tab-close" data-path="' + escAttr(f.path) + '">&times;</button>'
                + '</div>';
        }
        tabbar.innerHTML = html;
        scrollActiveTabIntoView();
    }

    // 文件很多、标签栏出现横向滚动时，确保当前激活标签滚动到可见处
    function scrollActiveTabIntoView() {
        if (!tabbar || !activeFilePath) return;
        var el = tabbar.querySelector('.code-editor-tab.active');
        if (!el) return;
        // 用 rAF 等布局稳定后再滚，避免 innerHTML 重排时机问题
        (window.requestAnimationFrame || function (fn) { setTimeout(fn, 0); })(function () {
            var tabLeft = el.offsetLeft;
            var tabRight = tabLeft + el.offsetWidth;
            var viewLeft = tabbar.scrollLeft;
            var viewRight = viewLeft + tabbar.clientWidth;
            if (tabRight > viewRight) {
                tabbar.scrollLeft = tabRight - tabbar.clientWidth;
            } else if (tabLeft < viewLeft) {
                tabbar.scrollLeft = tabLeft;
            }
        });
    }

    if (tabbar) {
        tabbar.addEventListener('click', function (e) {
            var close = e.target.closest('.code-editor-tab-close');
            if (close) { e.stopPropagation(); closeFile(close.getAttribute('data-path')); return; }
            var tab = e.target.closest('.code-editor-tab');
            if (tab) activateFile(tab.getAttribute('data-path'));
        });
    }

    function markDirty(path, dirty) {
        var st = docs[path];
        if (!st) return;
        st.dirty = dirty;
        // 更新标签点
        var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
        if (tab) tab.classList.toggle('dirty', dirty);
        // 更新状态栏（仅当前文件）
        if (path === activeFilePath) {
            if (dirtyEl) dirtyEl.style.display = dirty ? '' : 'none';
            if (saveBtn) saveBtn.disabled = !dirty;
        }
    }

    function closeFile(path) {
        var st = docs[path];
        if (st && st.dirty) {
            if (!window.confirm(GourdI18n.t('code.unsaved_confirm', baseName(path)))) return;
        }
        delete docs[path];
        openFiles = openFiles.filter(function (f) { return f.path !== path; });
        if (activeFilePath === path) {
            activeFilePath = null;
            if (openFiles.length) activateFile(openFiles[openFiles.length - 1].path);
            else { if (cm) cm.swapDoc(CodeMirror.Doc('', 'text/plain')); refreshEditorEmpty(); renderTabs(); }
        } else {
            renderTabs();
        }
    }

    function closeAllFiles() {
        openFiles = [];
        docs = {};
        activeFilePath = null;
        if (cm) cm.swapDoc(CodeMirror.Doc('', 'text/plain'));
        renderTabs();
        refreshEditorEmpty();
    }

    // 是否存在未保存（dirty）的打开文件。用于切项目/跨项目切会话前提示，避免静默丢弃改动。
    function hasUnsavedFiles() {
        for (var i = 0; i < openFiles.length; i++) {
            var st = docs[openFiles[i].path];
            if (st && st.dirty) return true;
        }
        return false;
    }

    // 切换项目（含跨项目切历史会话）会关闭全部打开文件。若有未保存改动，先聚合确认一次；
    // 用户取消则返回 false，调用方据此中止切换、保留文件。无未保存改动时直接放行。
    function confirmDiscardUnsavedIfAny() {
        if (!hasUnsavedFiles()) return true;
        return window.confirm(GourdI18n.t('code.unsaved_switch_confirm'));
    }
    window.confirmDiscardUnsavedIfAny = confirmDiscardUnsavedIfAny;

    function saveActive() {
        if (!activeFilePath) return;
        var st = docs[activeFilePath];
        if (!st) return;
        if (!st.dirty) return;
        var content = st.doc.getValue();
        var path = activeFilePath;
        if (saveBtn) { saveBtn.disabled = true; }
        $.ajax({
            url: '/web/chat/filer/write', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ path: path, content: content, root: window.currentProjectRoot || '' })
        }).done(function (resp) {
            if (resp && resp.code === 200) {
                st.clean = st.doc.changeGeneration();
                // 保存即以当前内容为准，清除「磁盘已变更」标记（否则下次编辑时红点会错误重现）
                st.diskChanged = false;
                var tab2 = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (tab2) tab2.classList.remove('disk-changed');
                markDirty(path, false);
                if (typeof showToast === 'function') showToast(GourdI18n.t('code.file_saved', baseName(path)), 'success');
            } else {
                if (saveBtn) saveBtn.disabled = false;
                if (typeof showToast === 'function') showToast((resp && resp.description) || GourdI18n.t('code.save_failed'), 'error');
            }
        }).fail(function () {
            if (saveBtn) saveBtn.disabled = false;
            if (typeof showToast === 'function') showToast(GourdI18n.t('code.save_failed'), 'error');
        });
    }

    if (saveBtn) saveBtn.addEventListener('click', saveActive);

    // ---------- 外部修改同步：监听 filer_change，编辑器内容按需刷新 ----------
    // 后端 WorkspaceWatcher 监听启动工作区 + Code 当前项目根，变更经 WebSocket 广播 filer_change。
    // clean 文件静默重载磁盘内容（保留光标/滚动）；dirty 文件不覆盖用户改动，
    // 标签显示「磁盘已变更」提示点，点击标签时确认后重载。
    function notifyWatchRoot(root) {
        if (!root) return;
        $.ajax({
            url: '/web/chat/filer/watch', method: 'POST', contentType: 'application/json',
            data: JSON.stringify({ root: root })
        });
    }

    function onCodeFilerChange(chunk) {
        if (!chunk || !chunk.changes || chunk.changes.length === 0) return;
        chunk.changes.forEach(function (rel) {
            var abs = changeRelToOpenPath(rel);
            if (abs) handleDiskChanged(abs);
        });
    }

    // 后端 filer_change 的 changes 是「相对其所属监听根」的路径。已打开文件必然位于当前项目根下，
    // 且后端对嵌套根取最长前缀相对化，故用「项目根 + rel」精确匹配即可，不做文件名兜底（避免同名文件误触发）。
    function changeRelToOpenPath(rel) {
        var root = window.currentProjectRoot;
        if (!root || !rel) return null;
        var cand = root + '/' + rel;
        for (var i = 0; i < openFiles.length; i++) {
            if (openFiles[i].path === cand) return cand;
        }
        return null;
    }

    function handleDiskChanged(path) {
        var st = docs[path];
        if (!st) return;
        if (st.dirty) {
            // 有未保存改动：不覆盖，标记「磁盘已变更」，点击标签时确认重载
            if (!st.diskChanged) {
                st.diskChanged = true;
                var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
                if (tab) tab.classList.add('disk-changed');
            }
            return;
        }
        reloadFileFromDisk(path);
    }

    // 静默重载磁盘内容：保留光标与滚动位置，重置 clean 基线
    function reloadFileFromDisk(path) {
        var st = docs[path];
        if (!st) return;
        $.get('/web/chat/filer/read?path=' + encodeURIComponent(path) + rootQuery(), function (resp) {
            if (!resp || resp.code !== 200 || !docs[path]) return;
            var cur = docs[path];
            var cursor = null, scroll = null;
            if (cm && activeFilePath === path) {
                cursor = cm.getCursor();
                scroll = cm.getScrollInfo();
            }
            cur.doc.setValue(resp.data.content || '');
            cur.clean = cur.doc.changeGeneration();
            cur.diskChanged = false;
            markDirty(path, false);
            var tab = tabbar ? tabbar.querySelector('.code-editor-tab[data-path="' + cssEsc(path) + '"]') : null;
            if (tab) tab.classList.remove('disk-changed');
            if (cursor) {
                var maxLine = cur.doc.lineCount() - 1;
                if (cursor.line > maxLine) cursor = { line: maxLine, ch: 0 };
                cm.setCursor(cursor);
            }
            if (scroll) cm.scrollTo(scroll.left, scroll.top);
        });
    }

    // 标签点击：disk-changed 文件先确认是否放弃本地未保存改动、重载磁盘内容（捕获阶段先于激活逻辑）
    if (tabbar) {
        tabbar.addEventListener('click', function (e) {
            if (e.target.closest('.code-editor-tab-close')) return;
            var tab = e.target.closest('.code-editor-tab');
            if (!tab) return;
            var p = tab.getAttribute('data-path');
            var st = docs[p];
            if (st && st.diskChanged && st.dirty) {
                if (window.confirm(GourdI18n.t('code.disk_changed_confirm', baseName(p)))) {
                    reloadFileFromDisk(p);
                }
            }
        }, true);
    }

    // 挂接 filer_change 事件链（app-gitdiff 可能已包装 window.onFilerChange，保留原调用）
    var _origOnFilerChange = window.onFilerChange;
    window.onFilerChange = function (chunk) {
        onCodeFilerChange(chunk);
        if (typeof _origOnFilerChange === 'function') _origOnFilerChange(chunk);
    };

    // ---------- helpers ----------
    function rootQuery() {
        return (window.currentProjectRoot) ? '&root=' + encodeURIComponent(window.currentProjectRoot) : '';
    }
    function baseName(p) { return (p || '').replace(/.*\//, ''); }
    // 用与父目录一致的分隔符拼接子目录（Windows 用反斜杠，Unix 用正斜杠）
    function joinPath(parent, child) {
        if (!parent) return child;
        var sep = (parent.indexOf('\\') >= 0 && parent.indexOf('/') < 0) ? '\\' : '/';
        return parent.replace(/[\/\\]+$/, '') + sep + child;
    }
    function escHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
    function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }
    function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

    // ---------- 覆盖 openFileViewer：code 模式进编辑器，chat 模式保留原只读查看器 ----------
    window._origOpenFileViewer = window.openFileViewer;
    window.openFileViewer = openInEditor;

    // ---------- 绑定模式切换按钮 ----------
    if (modeBtn) modeBtn.addEventListener('click', toggleMode);

    // ---------- 启动：恢复上次模式 ----------
    (function initMode() {
        var saved = null;
        try { saved = localStorage.getItem(LS_MODE); } catch (e) {}
        if (saved === 'code') {
            // 延迟一拍，确保 app-history 等已初始化
            setTimeout(enterCodeMode, 0);
        }
    })();

    // ---------- 启动：项目新窗口直达 code 模式并打开指定项目 ----------
    // 主进程新建项目窗体时把项目根记录在窗口上，并经 URL hash 携带。
    // 优先经 IPC 查询（权威来源），hash 作兜底。携带项目时覆盖常规的模式恢复：
    // 直接进入 code 模式并打开该项目（不沿用 localStorage 里的上次项目）。
    (function initWindowProject() {
        function fromHash() {
            var m = (location.hash || '').match(/[#&]project=([^&]+)/);
            if (!m) return '';
            try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
        }
        function boot(project) {
            if (!project) return;
            // 置覆盖标记：若 enterCodeMode 尚未跑过，其 loadProjects 回调会优先消费它；
            // 若已跑过（回调消费了空标记），则由下面的 trySelect 轮询到列表加载完成后补选中，
            // 两种时序下新窗口都能打开指定项目。
            // 注意写 null 而非空串：enterCodeMode 的 loadProjects 回调用真值判断消费覆盖标记，
            // 若这里残留空串会误判为有项目（''为假值→正常）但保持语义明确；boot('') 已在上方拦截。
            window.__bootProjectOverride = project || null;
            enterCodeMode({ persistMode: false });
            var tries = 0;
            var trySelect = function () {
                if (projectsLoaded) {
                    if (window.currentProjectRoot !== project) selectProject(project);
                    return;
                }
                // 列表尚未加载（后端未就绪/请求在途）：短暂轮询，最多约 10s，超时则停在欢迎面板
                if (++tries > 100) return;
                setTimeout(trySelect, 100);
            };
            trySelect();
        }
        var ipc = window.__GOURD_IPC__;
        if (ipc && typeof ipc.getWindowProject === 'function') {
            Promise.resolve(ipc.getWindowProject())
                .then(function (project) { boot(project || fromHash()); })
                .catch(function () { boot(fromHash()); });
        } else {
            boot(fromHash());
        }
    })();

    // ---------- 右侧对话栏：拖拽调宽 + 收起/展开 ----------
    // 布局回顾：code 模式 .main-area 为 flex row，编辑器(order:1) | 手柄(order:2) | 对话栏(order:3)。
    // 对话栏宽度由 CSS 变量 --code-chat-width 驱动（.chat-view: flex 0 1 var(--code-chat-width)，可收缩至 min-width:320px）。
    var LS_CHAT_WIDTH = 'code-chat-width';
    var LS_CHAT_COLLAPSED = 'code-chat-collapsed';
    var CHAT_MIN_WIDTH = 320;
    var CHAT_MAX_WIDTH = 900;

    // 布局变化后刷新 CodeMirror（否则行号/光标定位错乱）
    function refreshEditor() { if (cm) setTimeout(function () { cm.refresh(); }, 0); }
    window.refreshCodeEditor = refreshEditor;

    function setChatWidth(px) {
        var w = Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, px));
        document.documentElement.style.setProperty('--code-chat-width', w + 'px');
        return w;
    }

    (function initChatResizeCollapse() {
        var handle = document.getElementById('codeChatResizeHandle');
        var collapseBtn = document.getElementById('codeChatCollapseBtn');
        var expandBtn = document.getElementById('codeChatExpandBtn');
        var chatView = document.getElementById('chatView');

        // 恢复持久化宽度（即使当前非 code 模式也无妨：变量待 code 模式生效）
        try {
            var savedW = parseInt(localStorage.getItem(LS_CHAT_WIDTH), 10);
            if (savedW) setChatWidth(savedW);
        } catch (e) {}

        // 恢复收起态（.chat-collapsed 仅在 body.code-mode 下由 CSS 生效，故此处可无条件加类）
        try {
            if (localStorage.getItem(LS_CHAT_COLLAPSED) === '1') $body.addClass('chat-collapsed');
        } catch (e) {}

        // ---- 拖拽调宽 ----
        if (handle && chatView) {
            var dragging = false, startX = 0, startWidth = 0;
            handle.addEventListener('mousedown', function (e) {
                dragging = true;
                startX = e.clientX;
                startWidth = chatView.offsetWidth;
                handle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });
            document.addEventListener('mousemove', function (e) {
                if (!dragging) return;
                // 对话栏在右侧：手柄向左拖（clientX 变小）→ 变宽
                var w = setChatWidth(startWidth + (startX - e.clientX));
                try { localStorage.setItem(LS_CHAT_WIDTH, w); } catch (er) {}
            });
            document.addEventListener('mouseup', function () {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                refreshEditor();
            });
        }

        // ---- 收起 / 展开 ----
        function setCollapsed(collapsed) {
            $body.toggleClass('chat-collapsed', collapsed);
            try { localStorage.setItem(LS_CHAT_COLLAPSED, collapsed ? '1' : '0'); } catch (e) {}
            refreshEditor();
        }
        if (collapseBtn) collapseBtn.addEventListener('click', function () { setCollapsed(true); });
        if (expandBtn) expandBtn.addEventListener('click', function () { setCollapsed(false); });
    })();

    // 暴露给其它模块
    window.enterCodeMode = enterCodeMode;
    window.exitCodeMode = exitCodeMode;
    window.toggleAppMode = toggleMode;
    window.codeSaveActive = saveActive;
    window.startFreshCodeSession = startFreshSession;
})();
