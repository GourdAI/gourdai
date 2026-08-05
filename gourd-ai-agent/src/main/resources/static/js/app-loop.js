/* ===== app-loop.js ===== */
/* 循环任务面板交互 */
/* 依赖: app-base.js */

(function() {
    var $welcomeLoopBtn = $('#welcomeLoopBtn');
    var $chatLoopBtn = $('#chatLoopBtn');
    var $welcomeLoopPanel = $('#welcomeLoopPanel');
    var $chatLoopPanel = $('#chatLoopPanel');
    var loopPanelVisible = false;
    var loopEditId = null; // 当前编辑的任务 ID，null 表示新建

    // 使用 layui layer 风格的浮动提示（与设置面板保存成功一致）
    function showToast(msg, type) {
        if (typeof layer !== 'undefined' && layer.msg) {
            layer.msg(msg, { icon: type === 'error' ? 2 : 1, time: 2500, offset: '120px' });
        }
    }

    // 获取当前激活的面板和按钮
    function getActivePanel() {
        return inChatMode ? $chatLoopPanel : $welcomeLoopPanel;
    }
    function getActiveBtn() {
        return inChatMode ? $chatLoopBtn : $welcomeLoopBtn;
    }

    // ========== 预设模板 ==========
    var LOOP_TEMPLATES = [
        {
            id: 'auto-fix',
            icon: 'AF',
            name: GourdI18n.t('loop.templates.auto_fix_name'),
            desc: GourdI18n.t('loop.templates.auto_fix_desc'),
            data: {
                prompt: GourdI18n.t('loop.templates.auto_fix_prompt'),
                intervalMinutes: 10,
                goalCondition: 'all tests pass',
                worktreeEnabled: true,
                maxIterations: 10,
                runNow: true
            }
        },
        {
            id: 'daily-review',
            icon: 'CR',
            name: GourdI18n.t('loop.templates.daily_review_name'),
            desc: GourdI18n.t('loop.templates.daily_review_desc'),
            data: {
                prompt: GourdI18n.t('loop.templates.daily_review_prompt'),
                cron: '0 9 * * *',
                goalCondition: null,
                worktreeEnabled: false,
                maxIterations: 20,
                runNow: false
            }
        },
        {
            id: 'daily-memory',
            icon: 'MR',
            name: GourdI18n.t('loop.templates.daily_memory_name'),
            desc: GourdI18n.t('loop.templates.daily_memory_desc'),
            data: {
                prompt: GourdI18n.t('loop.templates.daily_memory_prompt'),
                cron: '0 22 * * *',
                goalCondition: null,
                worktreeEnabled: false,
                maxIterations: 10,
                runNow: false
            }
        },
        {
            id: 'ci-monitor',
            icon: 'CI',
            name: GourdI18n.t('loop.templates.ci_monitor_name'),
            desc: GourdI18n.t('loop.templates.ci_monitor_desc'),
            data: {
                prompt: GourdI18n.t('loop.templates.ci_monitor_prompt'),
                intervalMinutes: 30,
                goalCondition: null,
                worktreeEnabled: false,
                maxIterations: 20,
                runNow: false
            }
        },
        {
            id: 'health-check',
            icon: 'HC',
            name: GourdI18n.t('loop.templates.health_check_name'),
            desc: GourdI18n.t('loop.templates.health_check_desc'),
            data: {
                prompt: GourdI18n.t('loop.templates.health_check_prompt'),
                intervalMinutes: 5,
                goalCondition: 'all services healthy',
                worktreeEnabled: false,
                maxIterations: 100,
                runNow: true
            }
        }
    ];

    // ========== 面板开关 ==========
    function toggleLoopPanel() {
        var $panel = getActivePanel();
        if ($panel.is(':visible')) {
            $panel.hide();
            loopPanelVisible = false;
            loopEditId = null;
        } else {
            closeAllToolbarPanels();
            $panel.show();
            loopPanelVisible = true;
            renderLoopList();
        }
    }

    // Esc 键关闭面板
    $(document).on('keydown.loopesc', function(e) {
        if (e.key === 'Escape' && loopPanelVisible) {
            hideLoopPanel();
        }
    });

    function hideLoopPanel() {
        $welcomeLoopPanel.hide();
        $chatLoopPanel.hide();
        loopPanelVisible = false;
        loopEditId = null;
    }

    $welcomeLoopBtn.on('click', function(e) {
        e.stopPropagation();
        toggleLoopPanel();
    });
    $chatLoopBtn.on('click', function(e) {
        e.stopPropagation();
        toggleLoopPanel();
    });

    // 面板内 click 不冒泡到 .input-box 和 document
    // 防止 click-to-focus、cmd-complete、model-dropdown 等全局处理器干扰面板交互
    // 注意：只拦截 click，不拦截 mousedown，避免影响 input/select/label 的原生聚焦行为
    $welcomeLoopPanel.add($chatLoopPanel).on('click', function(e) {
        e.stopPropagation();
    });

    // 点击面板外部关闭（用 mousedown 避免选择文字时误触关闭）
    $(document).on('mousedown', function(e) {
        if (loopPanelVisible) {
            if (!$(e.target).closest('#chatLoopPanel, #welcomeLoopPanel').length &&
                !$(e.target).closest('#chatLoopBtn, #welcomeLoopBtn').length) {
                hideLoopPanel();
            }
        }
    });

    // ========== API 调用 ==========
    function loopApi(action, params, callback) {
        var data = params || {};
        data.sessionId = SESSION_ID;
        $.ajax({
            url: '/web/chat/loop/' + action,
            method: (action === 'list' || action === 'get') ? 'GET' : 'POST',
            data: data,
            dataType: 'json',
            success: function(res) {
                if (callback) callback(res);
            },
            error: function() {
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
                // 错误时也触发回调（传 null），让调用方有机会恢复 UI 状态
                if (callback) callback(null);
            }
        });
    }

    // ========== 列表渲染 ==========
    function renderLoopList() {
        loopApi('list', null, function(res) {
            var items = (res && res.data) ? res.data : [];
            var html = '<div class="loop-panel-header">';
            html += '<span class="loop-panel-title">' + GourdI18n.t('settings.loop.loop_task_list', items.length) + '</span>';
            html += '<button class="loop-panel-add-btn" id="loopAddNewBtn" title="' + GourdI18n.t('settings.loop.new_loop') + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>';
            html += '</div>';
            html += '<div class="loop-panel-list">';

            if (items.length === 0) {
                html += '<div class="loop-panel-empty">' + GourdI18n.t('settings.loop.empty') + '</div>';
            } else {
                for (var i = 0; i < items.length; i++) {
                    var t = items[i];
                    var statusText = t.cancelled ? GourdI18n.t('settings.loop.status_cancelled') : (!t.enabled ? GourdI18n.t('settings.loop.status_disabled') : (t.running ? GourdI18n.t('settings.loop.status_running') : GourdI18n.t('settings.loop.status_ready')));
                    var statusClass = t.cancelled ? 'cancelled' : (!t.enabled ? 'disabled' : (t.running ? 'running' : 'ready'));
                    var scheduleText = t.cron ? GourdI18n.t('settings.loop.cron_format', t.cron) : GourdI18n.t('settings.loop.interval_format', t.intervalMinutes);
                    var lastInfo = '';
                    if (t.lastExecutedAt) {
                        var ago = formatTimeAgo(t.lastExecutedAt);
                        lastInfo = '<span class="loop-item-meta">' + GourdI18n.t('settings.loop.last_exec', ago) + '</span>';
                    }
                    if (t.currentIteration > 0) {
                        lastInfo += '<span class="loop-item-meta">' + GourdI18n.t('settings.loop.iteration', t.currentIteration) + '</span>';
                    }

                    html += '<div class="loop-item" data-id="' + t.id + '">';
                    // 功能标签（移到状态位置，替代"就绪"等文字）
                    var tags = [];
                    if (t.worktreeEnabled) tags.push('<span class="loop-tag loop-tag-wt">wt</span>');
                    if (t.runNow) tags.push('<span class="loop-tag loop-tag-now">now</span>');
                    if (t.goalCondition) {
                        var goalLabel = 'goal';
                        if (t.maxIterations > 0) {
                            goalLabel += ' ' + t.currentIteration + '/' + t.maxIterations;
                        }
                        tags.push('<span class="loop-tag loop-tag-goal">' + goalLabel + '</span>');
                    }
                    // running 状态保留显示
                    var statusHtml = (statusClass === 'running' || statusClass === 'cancelled')
                        ? '<span class="loop-item-status ' + statusClass + '">' + statusText + '</span>'
                        : '';

                    html += '<div class="loop-item-row">';
                    html += '<span class="loop-item-dot ' + statusClass + '"></span>';
                    html += '<span class="loop-item-name">#' + escapeHtml(t.id) + '</span>';
                    html += '<span class="loop-item-schedule">' + scheduleText + '</span>';
                    html += statusHtml;
                    if (tags.length) html += '<span class="loop-item-tags">' + tags.join('') + '</span>';
                    html += '<div class="loop-item-actions">';
                    var toggleIcon = t.enabled
                        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
                        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
                    if (!t.cancelled) {
                        html += '<button class="loop-action-btn" data-action="toggle" data-id="' + t.id + '" data-enabled="' + t.enabled + '" title="' + (t.enabled ? GourdI18n.t('settings.loop.disable') : GourdI18n.t('settings.loop.enable')) + '">' + toggleIcon + '</button>';
                        html += '<button class="loop-action-btn" data-action="trigger" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.trigger') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>';
                        html += '<button class="loop-action-btn" data-action="edit" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.edit') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
                    }
                    html += '<button class="loop-action-btn danger" data-action="remove" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.delete') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>';
                    html += '</div>';
                    html += '</div>';
                    html += '<div class="loop-item-prompt">' + escapeHtml(t.prompt) + '</div>';
                    // 底部信息行：时间 + 迭代
                    if (lastInfo) {
                        html += '<div class="loop-item-info">';
                        html += lastInfo;
                        html += '</div>';
                    }
                    html += '</div>';
                }
            }

            html += '</div>';

            var $panel = getActivePanel();
            $panel.html(html);
            bindListEvents();
        });
    }

    // ========== 列表事件绑定 ==========
    function bindListEvents() {
        var $panel = getActivePanel();

        $panel.find('#loopAddNewBtn').on('click', function(e) {
            e.stopPropagation();
            loopEditId = null;
            renderLoopForm();
        });

        // 委托事件绑定在面板自身而非 document（面板已拦截冒泡，document 收不到）
        // 每次绑定前先 off()，防止重复打开面板导致事件处理器无限叠加
        $(document).off('click.loopaction');
        $panel.off('click.loopaction').on('click.loopaction', '.loop-action-btn', function(e) {
            e.stopPropagation();
            var action = $(this).data('action');
            var id = $(this).data('id');

            if (action === 'toggle') {
                loopApi('toggle', { taskId: id }, function(res) {
                    if (res) { renderLoopList(); showToast(GourdI18n.t('settings.loop.operation_success'), 'success'); }
                });
            } else if (action === 'trigger') {
                loopApi('trigger', { taskId: id }, function(res) {
                    if (res) {
                        showToast(GourdI18n.t('settings.loop.triggered'), 'success');
                        // 切换到对话视图，让用户看到 AI 响应
                        if (typeof switchToChatMode === 'function') switchToChatMode();
                        hideLoopPanel();
                        // 列表项短暂闪烁反馈
                        var $item = $panel.find('.loop-item[data-id="' + id + '"]');
                        $item.css('background', 'var(--accent-light)');
                        setTimeout(function() { $item.css('background', ''); }, 600);
                    }
                });
            } else if (action === 'remove') {
                if (!confirm(GourdI18n.t('settings.loop.confirm_delete'))) return;
                loopApi('remove', { taskId: id }, function(res) {
                    if (res) { renderLoopList(); showToast(GourdI18n.t('settings.loop.deleted'), 'success'); }
                });
            } else if (action === 'edit') {
                loopEditId = id;
                renderLoopForm();
            }
        });


    }

    // ========== 表单渲染 ==========
    function renderLoopForm() {
        var html = '<div class="loop-panel-header">';
        html += '<button class="loop-panel-back-btn" id="loopBackBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>';
        html += '<span class="loop-panel-title">' + (loopEditId ? GourdI18n.t('settings.loop.edit_loop', escapeHtml(loopEditId)) : GourdI18n.t('settings.loop.new_loop')) + '</span>';
        // 模板按钮（仅新建时显示）
        if (!loopEditId) {
            html += '<div class="loop-tpl-dropdown" id="loopTplDropdown">';
            html += '<button class="loop-tpl-trigger" id="loopTplBtn" title="' + GourdI18n.t('loop.fill_template') + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></button>';
            html += '<div class="loop-tpl-menu" id="loopTplMenu">';
            for (var i = 0; i < LOOP_TEMPLATES.length; i++) {
                var tpl = LOOP_TEMPLATES[i];
                html += '<div class="loop-tpl-item" data-tpl="' + tpl.id + '">';
                html += '<span class="loop-tpl-icon">' + tpl.icon + '</span>';
                html += '<div class="loop-tpl-info">';
                html += '<span class="loop-tpl-name">' + escapeHtml(tpl.name) + '</span>';
                html += '<span class="loop-tpl-desc">' + escapeHtml(tpl.desc) + '</span>';
                html += '</div>';
                html += '</div>';
            }
            html += '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '<div class="loop-form">';
        html += '<div class="loop-form-group">';
        html += '<label>' + GourdI18n.t('settings.loop.loop_task_desc') + ' <span class="loop-required">*</span></label>';
        html += '<input type="text" class="loop-input" id="loopFormPrompt" placeholder=""/>';
        html += '</div>';
        html += '<div class="loop-form-group">';
        html += '<label>' + GourdI18n.t('settings.loop.loop_interval') + '</label>';
        html += '<div class="loop-interval-row">';
        html += '<label class="loop-radio"><input type="radio" name="loopScheduleType" value="interval" checked/> ' + GourdI18n.t('settings.loop.loop_fixed') + '</label>';
        html += '<input type="number" class="loop-input loop-input-sm" id="loopFormInterval" value="5" min="1" max="1440"/>';
        html += '<div class="layui-form" style="display:inline-block;margin-left:4px">';
        html += '<select class="loop-input loop-input-sm" id="loopFormIntervalUnit" lay-filter="loopFormIntervalUnit">';
        html += '<option value="m" selected>' + GourdI18n.t('settings.loop.minute') + '</option>';
        html += '<option value="h">' + GourdI18n.t('settings.loop.hour') + '</option>';
        html += '</select>';
        html += '</div>';
        html += '</div>';
        html += '<div class="loop-interval-row">';
        html += '<label class="loop-radio"><input type="radio" name="loopScheduleType" value="cron"/> ' + GourdI18n.t('settings.loop.loop_cron') + '</label>';
        html += '<input type="text" class="loop-input" id="loopFormCron" placeholder="0 */5 * * * ?"/>';
        html += '</div>';
        html += '</div>';
        html += '<div class="loop-form-advanced-toggle collapsed" id="loopAdvancedToggle"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg><span>' + GourdI18n.t('settings.loop.loop_exec_strategy') + '</span></div>';
        html += '<div class="loop-form-advanced" id="loopAdvanced">';
        html += '<div class="loop-form-group">';
        html += '<label>' + GourdI18n.t('settings.loop.loop_goal') + '</label>';
        html += '<input type="text" class="loop-input" id="loopFormGoal" placeholder=""/>';
        html += '</div>';
        html += '<div class="loop-form-group loop-form-inline">';
        html += '<div class="loop-form-inline-item"><label>' + GourdI18n.t('settings.loop.worktree_isolation') + '</label><label class="loop-checkbox"><input type="checkbox" id="loopFormWorktree"/> ' + GourdI18n.t('settings.loop.worktree_desc') + '</label></div>';
        html += '<div class="loop-form-inline-item"><label>' + GourdI18n.t('settings.loop.run_immediately') + '</label><label class="loop-checkbox"><input type="checkbox" id="loopFormRunNow"/> ' + GourdI18n.t('settings.loop.run_immediately_desc') + '</label></div>';
        html += '<div class="loop-form-inline-item"><label>' + GourdI18n.t('settings.loop.max_iter') + '</label><input type="number" class="loop-input loop-input-sm" id="loopFormMaxIter" value="20" min="1"/></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="loop-form-actions">';
        html += '<button class="loop-btn-secondary" id="loopFormTriggerBtn" style="display:' + (loopEditId ? 'inline-block' : 'none') + '">' + GourdI18n.t('settings.loop.loop_trigger_btn') + '</button>';
        html += '<button class="loop-btn-primary" id="loopFormSaveBtn">' + GourdI18n.t('settings.loop.loop_save') + '</button>';
        html += '</div>';
        html += '</div>';

        var $panel = getActivePanel();
        $panel.addClass('mode-form');
        // 动态计算面板最大高度（不超过可用视口空间）
        var panelTop = $panel[0].getBoundingClientRect().top;
        var safeMaxH = Math.max(370, Math.floor(panelTop) - 16);
        $panel.css('max-height', Math.min(safeMaxH, 560) + 'px');
        $panel.html(html);

        // 初始化 layui 组件
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('select');
        }

        bindFormEvents();

        // 如果是编辑，先禁用表单并显示加载状态
        if (loopEditId) {
            var $inputs = $panel.find('.loop-input, .loop-checkbox input, select');
            $inputs.prop('disabled', true);
            $panel.find('#loopFormSaveBtn').prop('disabled', true).text(GourdI18n.t('settings.loop.loading'));
            loopApi('get', { taskId: loopEditId }, function(res) {
                var t = (res && res.data) ? res.data : null;
                if (t) {
                    fillFormData(t);
                    // 在标题旁显示状态标签
                    var statusText = t.cancelled ? GourdI18n.t('settings.loop.status_cancelled') : (!t.enabled ? GourdI18n.t('settings.loop.status_disabled') : (t.running ? GourdI18n.t('settings.loop.status_running') : GourdI18n.t('settings.loop.status_ready')));
                    var statusText = t.cancelled ? GourdI18n.t('settings.loop.status_cancelled') : (!t.enabled ? GourdI18n.t('settings.loop.status_disabled') : (t.running ? GourdI18n.t('settings.loop.status_running') : GourdI18n.t('settings.loop.status_ready')));
                    var $title = $panel.find('.loop-panel-title');
                    $title.html(GourdI18n.t('settings.loop.edit_loop', escapeHtml(loopEditId)) + ' <span class="loop-item-status ' + statusClass + '" style="margin-left:6px;font-size:11px">' + statusText + '</span>' + (t.currentIteration > 0 ? '<span class="loop-item-meta" style="margin-left:6px">' + GourdI18n.t('settings.loop.executed_times', t.currentIteration) + '</span>' : ''));
                    $title.html(GourdI18n.t('settings.loop.edit_loop', escapeHtml(loopEditId)) + ' <span class="loop-item-status ' + statusClass + '" style="margin-left:6px;font-size:11px">' + statusText + '</span>' + (t.currentIteration > 0 ? '<span class="loop-item-meta" style="margin-left:6px">' + GourdI18n.t('settings.loop.executed_times', t.currentIteration) + '</span>' : ''));
                    showToast(GourdI18n.t('settings.loop.loop_not_found'), 'error');
                }
                // 恢复表单
                $inputs.prop('disabled', false);
                $panel.find('#loopFormSaveBtn').prop('disabled', false).text(GourdI18n.t('settings.loop.loop_save'));
            });
        }
    }

    function fillFormData(t) {
        var $panel = getActivePanel();
        $panel.find('#loopFormPrompt').val(t.prompt || '');
        if (t.cron) {
            $panel.find('input[name=loopScheduleType][value=cron]').prop('checked', true);
            $panel.find('#loopFormCron').val(t.cron);
        } else {
            $panel.find('input[name=loopScheduleType][value=interval]').prop('checked', true);
            var mins = t.intervalMinutes || 5;
            if (mins >= 60 && mins % 60 === 0) {
                $panel.find('#loopFormInterval').val(mins / 60);
                $panel.find('#loopFormIntervalUnit').val('h');
            } else {
                $panel.find('#loopFormInterval').val(mins);
                $panel.find('#loopFormIntervalUnit').val('m');
            }
            // 切换回间隔模式时清空 cron
            $panel.find('#loopFormCron').val('');
        }
        // 所有字段无条件赋值，null/undefined 时清空为默认值，避免模板切换残留
        $panel.find('#loopFormGoal').val(t.goalCondition || '');
        $panel.find('#loopFormWorktree').prop('checked', !!t.worktreeEnabled);
        $panel.find('#loopFormRunNow').prop('checked', !!t.runNow);
        $panel.find('#loopFormMaxIter').val(t.maxIterations || '');

        // 有高级字段时自动展开，否则折叠
        if (t.goalCondition || t.worktreeEnabled || t.runNow) {
            $panel.find('#loopAdvanced').show();
            $panel.find('#loopAdvancedToggle').removeClass('collapsed');
        } else {
            $panel.find('#loopAdvanced').hide();
            $panel.find('#loopAdvancedToggle').addClass('collapsed');
        }
    }

    // ========== 表单事件绑定 ==========
    function bindFormEvents() {
        var $panel = getActivePanel();

        $panel.find('#loopBackBtn').on('click', function() {
            loopEditId = null;
            renderLoopList();
        });

        // 模板下拉菜单
        var $tplBtn = $panel.find('#loopTplBtn');
        var $tplMenu = $panel.find('#loopTplMenu');
        if ($tplBtn.length) {
            $tplBtn.on('click', function(e) {
                e.stopPropagation();
                $tplMenu.toggleClass('show');
            });
            // 点击模板项，填充表单
            $tplMenu.on('click', '.loop-tpl-item', function(e) {
                e.stopPropagation();
                var tplId = $(this).data('tpl');
                var tpl = null;
                for (var i = 0; i < LOOP_TEMPLATES.length; i++) {
                    if (LOOP_TEMPLATES[i].id === tplId) { tpl = LOOP_TEMPLATES[i]; break; }
                }
                if (tpl && tpl.data) fillFormData(tpl.data);
                $tplMenu.removeClass('show');
            });
            // 点击其他地方关闭
            $(document).off('mousedown.looptpl').on('mousedown.looptpl', function(e) {
                if (!$(e.target).closest('#loopTplDropdown').length) {
                    $tplMenu.removeClass('show');
                }
            });
        }

        $panel.find('#loopAdvancedToggle').on('click', function() {
            var $adv = $panel.find('#loopAdvanced');
            if ($adv.is(':visible')) {
                $adv.hide();
                $(this).addClass('collapsed');
            } else {
                $adv.show();
                $(this).removeClass('collapsed');
            }
        });

        // 间隔类型切换
        $panel.find('input[name=loopScheduleType]').on('change', function() {
            var isCron = $(this).val() === 'cron';
            $panel.find('#loopFormInterval').prop('disabled', isCron);
            $panel.find('#loopFormIntervalUnit').prop('disabled', isCron);
            $panel.find('#loopFormCron').prop('disabled', !isCron);
        });

        // 保存（防重复点击 + loading 状态）
        var $saveBtn = $panel.find('#loopFormSaveBtn');
        $saveBtn.on('click', function() {
            if ($saveBtn.prop('disabled')) return; // 防重复

            var prompt = $panel.find('#loopFormPrompt').val().trim();
            if (!prompt) {
                showToast(GourdI18n.t('settings.loop.please_input_prompt'), 'error');
                return;
            }

            // 进入 loading 状态
            $saveBtn.prop('disabled', true).text(GourdI18n.t('settings.loop.saving'));

            var isCron = $panel.find('input[name=loopScheduleType]:checked').val() === 'cron';
            var cronVal = isCron ? $panel.find('#loopFormCron').val().trim() : null;
            var intervalVal = null;
            if (!isCron) {
                var num = parseInt($panel.find('#loopFormInterval').val()) || 5;
                var unit = $panel.find('#loopFormIntervalUnit').val();
                intervalVal = unit === 'h' ? num * 60 : num;
            }

            var params = {
                prompt: prompt,
                intervalMinutes: intervalVal,
                cron: cronVal,
                goalCondition: $panel.find('#loopFormGoal').val().trim() || null,
                worktreeEnabled: $panel.find('#loopFormWorktree').is(':checked'),
                runNow: $panel.find('#loopFormRunNow').is(':checked'),
                maxIterations: parseInt($panel.find('#loopFormMaxIter').val()) || null
            };

            function restoreBtn() {
                $saveBtn.prop('disabled', false).text(GourdI18n.t('settings.loop.loop_save'));
            }

            if (loopEditId) {
                params.taskId = loopEditId;
                loopApi('update', params, function(res) {
                    if (res && res.code === 200) {
                        showToast(GourdI18n.t('settings.loop.updated'), 'success');
                        loopEditId = null;
                        renderLoopList();
                    } else {
                        restoreBtn();
                        showToast((res && res.message) || GourdI18n.t('settings.loop.update_failed'), 'error');
                    }
                });
            } else {
                loopApi('add', params, function(res) {
                    if (res && res.code === 200) {
                        showToast(GourdI18n.t('settings.loop.created'), 'success');
                        loopEditId = null;
                        renderLoopList();
                    } else {
                        restoreBtn();
                        showToast((res && res.message) || GourdI18n.t('settings.loop.create_failed'), 'error');
                    }
                });
            }
        });

        // 测试运行
        $panel.find('#loopFormTriggerBtn').on('click', function() {
            if (loopEditId) {
                loopApi('trigger', { taskId: loopEditId }, function() {
                    showToast(GourdI18n.t('settings.loop.triggered'), 'success');
                    if (typeof switchToChatMode === 'function') switchToChatMode();
                    hideLoopPanel();
                });
            }
        });
    }

    // ========== 工具函数 ==========
    function formatTimeAgo(isoStr) {
        if (!isoStr) return '';
        try {
            var date = new Date(isoStr);
            var now = new Date();
            var diffMs = now - date;
            var diffSec = Math.floor(diffMs / 1000);
            if (diffSec < 60) return GourdI18n.t('settings.loop.seconds_ago', diffSec);
            var diffMin = Math.floor(diffSec / 60);
            if (diffMin < 60) return GourdI18n.t('settings.loop.minutes_ago', diffMin);
            var diffHour = Math.floor(diffMin / 60);
            if (diffHour < 24) return GourdI18n.t('settings.loop.hours_ago', diffHour);
            return GourdI18n.t('settings.loop.days_ago', Math.floor(diffHour / 24));
        } catch (e) {
            return isoStr;
        }
    }




    // ========== 公开 API ==========
    window.refreshLoopPanel = function() {
        if (loopPanelVisible) renderLoopList();
    };

    // 面板显示时移除表单模式 class
    var _origRenderLoopList = renderLoopList;
    renderLoopList = function() {
        var $p = getActivePanel();
        $p.removeClass('mode-form');
        $p.css('max-height', ''); // 清除手动高度，恢复 CSS 默认值
        _origRenderLoopList();
    };
})();
