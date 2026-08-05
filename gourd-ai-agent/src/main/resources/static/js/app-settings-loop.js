/* app-settings-loop.js — 定时任务设置页 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabLoop';
    var editId = null;
    var initialized = false;
    var escapeHtml = window._settingsCore ? window._settingsCore.escapeHtml : function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

    function showToast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type === 'error' ? 'error' : 'success');
        else if (typeof layer !== 'undefined') layer.msg(msg, { icon: type === 'error' ? 2 : 1, time: 2500 });
    }

    function api(action, params, cb) {
        var isGet = action === 'list';
        var data = $.extend({ sessionId: activeSessionId }, params || {});
        console.log('[Loop Settings API] action:', action, 'data:', data);
        $.ajax({
            url: '/web/chat/loop/' + action,
            method: isGet ? 'GET' : 'POST',
            data: data,
            dataType: 'json',
            success: function (r) {
                console.log('[Loop Settings API] success:', action, r);
                if (cb) cb(r);
            },
            error: function (xhr, status, error) {
                console.error('[Loop Settings API] error:', action, status, error, xhr);
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
                if (cb) cb(null);
            }
        });
    }

    function $c() { return $('#' + CONTAINER); }

    function formatAgo(isoStr) {
        if (!isoStr) return '';
        try {
            var d = Math.floor((new Date() - new Date(isoStr)) / 1000);
            if (d < 60) return GourdI18n.t('settings.loop.seconds_ago', [d]);
            if (d < 3600) return GourdI18n.t('settings.loop.minutes_ago', [Math.floor(d / 60)]);
            if (d < 86400) return GourdI18n.t('settings.loop.hours_ago', [Math.floor(d / 3600)]);
            return GourdI18n.t('settings.loop.days_ago', [Math.floor(d / 86400)]);
        } catch (e) { return isoStr; }
    }

    // 根据 daily/interval 生成 cron 表达式
    function buildCron(activeTab) {
        if (activeTab === 'cron') {
            return $('#slCron').val().trim();
        }
        if (activeTab === 'daily') {
            var time = $('#slDailyTime').val() || '09:00';
            var parts = time.split(':');
            var h = parseInt(parts[0]) || 0;
            var m = parseInt(parts[1]) || 0;
            var selectedDays = [];
            // Quartz cron 星期: 1=SUN, 2=MON, 3=TUE, 4=WED, 5=THU, 6=FRI, 7=SAT
            // 但我们的界面是: 1=MON, 2=TUE, ..., 7=SUN
            $('#slWeekdays .loop-weekday-btn.active').each(function () {
                var d = parseInt($(this).data('day'));
                if (d >= 1 && d <= 7) {
                    // 转换为 Quartz 格式: MON(1)=>2, TUE(2)=>3, ..., SUN(7)=>1
                    var quartzDay = d === 7 ? 1 : (d + 1);
                    selectedDays.push(quartzDay);
                }
            });
            selectedDays.sort(function(a, b) { return a - b; });
            var daysStr = selectedDays.length === 7 || selectedDays.length === 0 ? '*' : selectedDays.join(',');
            return '0 ' + m + ' ' + h + ' ? * ' + daysStr;
        }
        // interval
        var num = parseInt($('#slInterval').val()) || 5;
        var mins = $('#slIntervalUnit').val() === 'h' ? num * 60 : num;
        var selectedDays = [];
        $('#slIntervalWeekdays .loop-weekday-btn.active').each(function () {
            var d = parseInt($(this).data('day'));
            if (d >= 1 && d <= 7) {
                var quartzDay = d === 7 ? 1 : (d + 1);
                selectedDays.push(quartzDay);
            }
        });
        selectedDays.sort(function(a, b) { return a - b; });
        var daysStr = selectedDays.length === 7 || selectedDays.length === 0 ? '*' : selectedDays.join(',');
        return '0 */' + mins + ' * ? * ' + daysStr;
    }

    function switchSchedTab(tab) {
        $('.loop-schedule-tab').removeClass('active');
        $('.loop-schedule-tab[data-sched="' + tab + '"]').addClass('active');
        $('#slSchedDaily, #slSchedInterval, #slSchedCron').hide();
        if (tab === 'daily') $('#slSchedDaily').show();
        else if (tab === 'interval') $('#slSchedInterval').show();
        else $('#slSchedCron').show();
    }

    // 事件只初始化一次，绑定在容器上（事件委托），内容重绘不影响
    function initEvents() {
        if (initialized) return;
        initialized = true;

        $('#' + CONTAINER).on('click', '#slAddBtn', function () {
            editId = null;
            showForm();
        });

        $('#' + CONTAINER).on('click', '.sl-action', function (e) {
            e.stopPropagation();
            var action = $(this).data('action');
            var id = $(this).data('id');
            if (action === 'toggle') {
                api('toggle', { taskId: id }, function (r) {
                    if (r && r.code === 200) { showToast(GourdI18n.t('settings.loop.operation_success'), 'success'); showList(); }
                });
            } else if (action === 'trigger') {
                api('trigger', { taskId: id }, function (r) {
                    if (r && r.code === 200) showToast(GourdI18n.t('settings.loop.triggered'), 'success');
                });
            } else if (action === 'remove') {
                layConfirm(GourdI18n.t('settings.loop.confirm_delete'), function() {
                    api('remove', { taskId: id }, function (r) {
                        if (r && r.code === 200) { showToast(GourdI18n.t('settings.loop.deleted'), 'success'); showList(); }
                    });
                });
            } else if (action === 'edit') {
                editId = id;
                showForm();
            }
        });
    }

    // ===== 列表视图 =====
    function showList() {
        editId = null;
        console.log('[Loop Settings] showList called, activeSessionId:', window.activeSessionId);
        api('list', null, function (res) {
            console.log('[Loop Settings] API response:', res);
            var items = (res && res.data) ? res.data : [];
            console.log('[Loop Settings] items.length:', items.length);
            var html = '<div class="settings-section">';
            html += '<div class="settings-section-header"><div><span class="settings-section-title">' + GourdI18n.t('settings.loop.title') + '</span><div class="settings-section-desc">' + GourdI18n.t('settings.loop.desc') + '</div></div>';
            html += '<button class="settings-add-btn" id="slAddBtn">+ ' + GourdI18n.t('settings.loop.add_task') + '</button></div>';

            if (items.length === 0) {
                html += '<div style="padding:32px 0;text-align:center;color:var(--text-muted)">' + GourdI18n.t('settings.loop.empty') + '</div>';
            } else {
                html += '<div class="loop-panel-list" style="margin-top:12px">';
                for (var i = 0; i < items.length; i++) {
                    var t = items[i];
                    var statusText = t.cancelled ? GourdI18n.t('settings.loop.status_cancelled') : (!t.enabled ? GourdI18n.t('settings.loop.status_disabled') : (t.running ? GourdI18n.t('settings.loop.status_running') : GourdI18n.t('settings.loop.status_ready')));
                    var statusClass = t.cancelled ? 'cancelled' : (!t.enabled ? 'disabled' : (t.running ? 'running' : 'ready'));
                    var scheduleText = t.cron ? GourdI18n.t('settings.loop.cron_format', [t.cron]) : GourdI18n.t('settings.loop.interval_format', [t.intervalMinutes]);
                    var toggleIcon = t.enabled
                        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
                        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';

                    html += '<div class="loop-item" data-id="' + t.id + '">';
                    html += '<div class="loop-item-row">';
                    html += '<span class="loop-item-dot ' + statusClass + '"></span>';
                    html += '<span class="loop-item-name">' + escapeHtml(t.name || ('#' + t.id)) + '</span>';
                    html += '<span class="loop-item-schedule">' + scheduleText + '</span>';
                    html += '<span class="loop-item-status ' + statusClass + '">' + statusText + '</span>';
                    if (t.channelNotify) {
                        html += '<span class="loop-tag" style="margin-left:6px;font-size:11px;padding:1px 6px;background:var(--accent-muted,rgba(99,102,241,.15));color:var(--accent,#6366f1);border-radius:4px">' + escapeHtml(t.channelNotify) + '</span>';
                    }
                    html += '<div class="loop-item-actions">';
                    if (!t.cancelled) {
                        html += '<button class="loop-action-btn sl-action" data-action="toggle" data-id="' + t.id + '" title="' + (t.enabled ? GourdI18n.t('settings.loop.disable') : GourdI18n.t('settings.loop.enable')) + '">' + toggleIcon + '</button>';
                        html += '<button class="loop-action-btn sl-action" data-action="trigger" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.trigger') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>';
                        html += '<button class="loop-action-btn sl-action" data-action="edit" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.edit') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
                    }
                    html += '<button class="loop-action-btn sl-action danger" data-action="remove" data-id="' + t.id + '" title="' + GourdI18n.t('settings.loop.delete') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>';
                    html += '</div></div>';
                    html += '<div class="loop-item-prompt">' + escapeHtml(t.prompt) + '</div>';

                    var tags = [];
                    if (t.goalCondition) tags.push('<span class="loop-tag loop-tag-goal">goal</span>');
                    if (t.makerAgent) tags.push('<span class="loop-tag loop-tag-mc">m/c</span>');
                    if (t.worktreeEnabled) tags.push('<span class="loop-tag loop-tag-wt">wt</span>');
                    var info = '';
                    if (t.lastExecutedAt) info += '<span class="loop-item-meta">' + GourdI18n.t('settings.loop.last_exec', [formatAgo(t.lastExecutedAt)]) + '</span>';
                    if (t.currentIteration > 0) info += '<span class="loop-item-meta">' + GourdI18n.t('settings.loop.iteration', [t.currentIteration]) + '</span>';
                    var tagsHtml = tags.length ? '<span class="loop-item-tags">' + tags.join('') + '</span>' : '';
                    if (info || tagsHtml) html += '<div class="loop-item-info">' + info + tagsHtml + '</div>';

                    if (t.lastResult) {
                        var rs = t.lastResult.length > 80 ? t.lastResult.substring(0, 80) + '...' : t.lastResult;
                        var rc = t.lastResult.indexOf('[GOAL_ACHIEVED]') >= 0 ? 'achieved' : (t.lastResult.indexOf('error') >= 0 ? 'error' : '');
                        html += '<div class="loop-item-result ' + rc + '">' + escapeHtml(rs) + '</div>';
                    }
                    if (t.goalCondition && t.maxIterations > 0) {
                        var pct = Math.min(100, Math.round(t.currentIteration / t.maxIterations * 100));
                        html += '<div class="loop-item-progress"><div class="loop-progress-bar" style="width:' + pct + '%"></div><span class="loop-progress-text">' + t.currentIteration + '/' + t.maxIterations + '</span></div>';
                    }
                    html += '</div>';
                }
                html += '</div>';
            }
            html += '</div>';
            $c().html(html);
        });
    }

    // ===== 表单视图 =====
    function showForm() {
        var days = [GourdI18n.t('settings.loop.weekday_1'), GourdI18n.t('settings.loop.weekday_2'), GourdI18n.t('settings.loop.weekday_3'), GourdI18n.t('settings.loop.weekday_4'), GourdI18n.t('settings.loop.weekday_5'), GourdI18n.t('settings.loop.weekday_6'), GourdI18n.t('settings.loop.weekday_7')];
        var wHtml = '';
        for (var d = 0; d < 7; d++) {
            wHtml += '<button type="button" class="loop-weekday-btn active" data-day="' + (d + 1) + '">' + days[d] + '</button>';
        }

        var html = '<div class="settings-section">';
        html += '<div class="settings-section-header"><div class="settings-title-row">';
        html += '<button class="settings-back-btn" id="slBackBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>';
        html += '<span class="settings-section-title">' + (editId ? GourdI18n.t('settings.loop.edit_task') : GourdI18n.t('settings.loop.new_task')) + '</span></div></div>';
        html += '<div style="margin-top:16px">';

        html += '<div class="form-row-2col">';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.task_name') + ' <span class="required">*</span></label><input type="text" id="slName" placeholder="' + GourdI18n.t('settings.loop.task_name_placeholder') + '"/></div>';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.push_channel') + '</label>';
        html += '<div class="layui-form">';
        html += '<select id="slChannel" lay-filter="slChannel">';
        html += '<option value="">' + GourdI18n.t('settings.loop.no_push') + '</option>';
        html += '<option value="wechat">' + GourdI18n.t('settings.loop.wechat') + '</option>';
        html += '<option value="feishu">' + GourdI18n.t('settings.loop.feishu') + '</option>';
        html += '<option value="dingtalk">' + GourdI18n.t('settings.loop.dingtalk') + '</option>';
        html += '</select>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        html += '<div class="form-row-2col">';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.bind_session') + '</label>';
        html += '<div class="layui-form">';
        html += '<select id="slBoundSession" lay-filter="slBoundSession">';
        html += '<option value="">' + GourdI18n.t('settings.loop.no_bind') + '</option>';
        html += '</select>';
        html += '</div>';
        html += '</div>';
        html += '<div class="form-group"></div>'; // 占位，保持2列布局
        html += '</div>';

        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.task_prompt') + ' <span class="required">*</span></label>';
        html += '<textarea id="slPrompt" rows="4" placeholder="' + GourdI18n.t('settings.loop.task_prompt_placeholder') + '" style="resize:vertical"></textarea></div>';

        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.exec_time') + ' <span class="required">*</span></label>';
        html += '<div class="loop-schedule-tabs">';
        html += '<button type="button" class="loop-schedule-tab active" data-sched="daily">' + GourdI18n.t('settings.loop.daily') + '</button>';
        html += '<button type="button" class="loop-schedule-tab" data-sched="interval">' + GourdI18n.t('settings.loop.interval') + '</button>';
        html += '<button type="button" class="loop-schedule-tab" data-sched="cron">' + GourdI18n.t('settings.loop.loop_cron') + '</button>';
        html += '</div>';

        // 每天面板
        html += '<div id="slSchedDaily" style="margin-top:10px">';
        html += '<div class="layui-form">';
        html += '<div class="form-group" style="margin-bottom:8px">';
        html += '<input type="text" id="slDailyTime" class="layui-input" placeholder="' + GourdI18n.t('settings.loop.daily_time_placeholder') + '" value="09:00" readonly/>';
        html += '</div>';
        html += '</div>';
        html += '<div class="loop-weekdays" id="slWeekdays">' + wHtml + '</div>';
        html += '</div>';

        // 按间隔面板
        html += '<div id="slSchedInterval" style="display:none;margin-top:10px">';
        html += '<div class="layui-form">';
        html += '<div class="layui-form-item" style="margin-bottom:12px">';
        html += '<div class="layui-input-block" style="margin-left:0">';
        html += '<div style="display:flex;align-items:center;gap:8px">';
        html += '<span style="color:var(--text-primary)">' + GourdI18n.t('settings.loop.every') + '</span>';
        html += '<input type="number" id="slInterval" class="layui-input" value="5" min="1" max="1440" style="width:80px;display:inline-block"/>';
        html += '<div style="width:auto;min-width:80px">';
        html += '<select id="slIntervalUnit" lay-filter="slIntervalUnit">';
        html += '<option value="m">' + GourdI18n.t('settings.loop.minute') + '</option>';
        html += '<option value="h">' + GourdI18n.t('settings.loop.hour') + '</option>';
        html += '</select>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="layui-form-item" style="margin-bottom:8px">';
        html += '<label class="layui-form-label" style="width:auto;padding-left:0;padding-right:10px">' + GourdI18n.t('settings.loop.effective_time') + '</label>';
        html += '<div class="layui-input-block" style="margin-left:110px">';
        html += '<div style="display:flex;align-items:center;gap:8px">';
        html += '<input type="text" id="slIntervalStartTime" class="layui-input" placeholder="00:00" style="width:100px" readonly/>';
        html += '<span style="color:var(--text-secondary)">→</span>';
        html += '<input type="text" id="slIntervalEndTime" class="layui-input" placeholder="23:59" style="width:100px" readonly/>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="loop-weekdays" id="slIntervalWeekdays">' + wHtml + '</div>';
        html += '</div>';

        // Cron 面板
        html += '<div id="slSchedCron" style="display:none;margin-top:10px">';
        html += '<div class="form-group" style="margin-bottom:0"><input type="text" id="slCron" placeholder="0 */5 * * * ?"/></div>';
        html += '</div></div>'; // close 执行时间 form-group

        html += '<div class="loop-form-advanced-toggle" id="slAdvancedToggle" style="margin-top:4px"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg><span>' + GourdI18n.t('settings.loop.advanced') + '</span></div>';
        html += '<div class="loop-form-advanced" id="slAdvanced">';
        html += '<div class="form-row-2col">';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.maker_agent') + '</label><input type="text" id="slMaker" placeholder="@coder"/></div>';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.checker_agent') + '</label><input type="text" id="slChecker" placeholder="@reviewer"/></div>';
        html += '</div>';
        html += '<div class="form-row-2col">';
        html += '<div class="form-group"><label>' + GourdI18n.t('settings.loop.max_iter') + '</label><input type="number" id="slMaxIter" value="20" min="1"/></div>';
        html += '<div class="form-group" style="display:flex;align-items:flex-end;padding-bottom:1px"><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="slWorktree" style="width:auto"/>' + GourdI18n.t('settings.loop.worktree_isolation') + '</label></div>';
        html += '</div>';
        html += '</div>';

        html += '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">';
        html += '<button class="btn-secondary" id="slTriggerBtn" style="display:' + (editId ? 'inline-block' : 'none') + '">' + GourdI18n.t('settings.loop.test_run') + '</button>';
        html += '<button class="btn-primary" id="slSaveBtn">' + GourdI18n.t('settings.loop.save') + '</button>';
        html += '</div></div></div>';
        $c().html(html);

        // 初始化 layui 组件
        if (typeof layui !== 'undefined' && layui.form && layui.laydate) {
            // 渲染下拉框
            layui.form.render('select');

            // 加载会话列表到绑定会话下拉框
            loadSessionsForBinding();

            // 初始化时间选择器
            layui.laydate.render({
                elem: '#slDailyTime',
                type: 'time',
                format: 'HH:mm',
                theme: '#6366f1'
            });

            layui.laydate.render({
                elem: '#slIntervalStartTime',
                type: 'time',
                format: 'HH:mm',
                theme: '#6366f1'
            });

            layui.laydate.render({
                elem: '#slIntervalEndTime',
                type: 'time',
                format: 'HH:mm',
                theme: '#6366f1'
            });
        }

        // Tab 切换（直接绑定，每次渲染后新 DOM）
        $('#settingsTabLoop').off('click.schedtab').on('click.schedtab', '.loop-schedule-tab', function () {
            switchSchedTab($(this).data('sched'));
        });

        // 星期按钮切换
        $('#settingsTabLoop').off('click.weekdaybtn').on('click.weekdaybtn', '.loop-weekday-btn', function () {
            $(this).toggleClass('active');
        });

        $('#slAdvancedToggle').on('click', function () {
            var $a = $('#slAdvanced');
            $a.toggle();
            $(this).toggleClass('collapsed', !$a.is(':visible'));
        });
        $('#slBackBtn').on('click', function () { showList(); });
        $('#slTriggerBtn').on('click', function () {
            if (editId) api('trigger', { taskId: editId }, function () { showToast(GourdI18n.t('settings.loop.triggered'), 'success'); });
        });

        var $saveBtn = $('#slSaveBtn');
        $saveBtn.on('click', function () {
            if ($saveBtn.prop('disabled')) return;
            var name = $('#slName').val().trim();
            if (!name) { showToast(GourdI18n.t('settings.loop.please_input_name'), 'error'); return; }
            var prompt = $('#slPrompt').val().trim();
            if (!prompt) { showToast(GourdI18n.t('settings.loop.please_input_prompt'), 'error'); return; }
            var activeTab = $('.loop-schedule-tab.active').data('sched');
            var cronVal = buildCron(activeTab);
            if (!cronVal) { showToast(GourdI18n.t('settings.loop.please_fill_time'), 'error'); return; }
            var intervalVal = null;
            if (activeTab === 'interval') {
                var num = parseInt($('#slInterval').val()) || 5;
                intervalVal = $('#slIntervalUnit').val() === 'h' ? num * 60 : num;
            }
            $saveBtn.prop('disabled', true).text(GourdI18n.t('settings.loop.saving'));
            var boundSessionVal = $('#slBoundSession').val();
            var params = {
                name: name,
                prompt: prompt,
                intervalMinutes: intervalVal,
                cron: cronVal,
                makerAgent: $('#slMaker').val().trim() || null,
                checkerAgent: $('#slChecker').val().trim() || null,
                worktreeEnabled: $('#slWorktree').is(':checked'),
                maxIterations: parseInt($('#slMaxIter').val()) || null,
                channelNotify: $('#slChannel').val() || null,
                boundSessionId: (boundSessionVal && boundSessionVal.trim()) ? boundSessionVal.trim() : null
            };
            function restoreBtn() { $saveBtn.prop('disabled', false).text(GourdI18n.t('settings.loop.save')); }
            if (editId) {
                params.taskId = editId;
                api('update', params, function (r) {
                    if (r && r.code === 200) { showToast(GourdI18n.t('settings.loop.updated'), 'success'); showList(); }
                    else { restoreBtn(); showToast((r && r.message) || GourdI18n.t('settings.loop.update_failed'), 'error'); }
                });
            } else {
                api('add', params, function (r) {
                    if (r && r.code === 200) { showToast(GourdI18n.t('settings.loop.created'), 'success'); showList(); }
                    else { restoreBtn(); showToast((r && r.message) || GourdI18n.t('settings.loop.create_failed'), 'error'); }
                });
            }
        });

        if (editId) {
            var $inputs = $('#slName, #slPrompt, #slDailyTime, #slInterval, #slIntervalUnit, #slCron, #slMaker, #slChecker, #slMaxIter, #slWorktree, #slChannel');
            $inputs.prop('disabled', true);
            $saveBtn.prop('disabled', true).text(GourdI18n.t('settings.loop.loading'));
            api('list', null, function (res) {
                var items = (res && res.data) ? res.data : [];
                for (var i = 0; i < items.length; i++) {
                    if (items[i].id === editId) { fillForm(items[i]); break; }
                }
                $inputs.prop('disabled', false);
                $saveBtn.prop('disabled', false).text(GourdI18n.t('settings.loop.save'));
            });
        }
    }

    function fillForm(t) {
        $('#slName').val(t.name || '');
        $('#slPrompt').val(t.prompt || '');
        if (t.channelNotify) {
            $('#slChannel').val(t.channelNotify);
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        }
        if (t.boundSessionId) {
            $('#slBoundSession').val(t.boundSessionId);
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        }
        if (t.makerAgent) $('#slMaker').val(t.makerAgent);
        if (t.checkerAgent) $('#slChecker').val(t.checkerAgent);
        if (t.worktreeEnabled) $('#slWorktree').prop('checked', true);
        if (t.maxIterations) $('#slMaxIter').val(t.maxIterations);

        // 判断调度类型并切换 tab
        if (t.intervalMinutes && !t.cron) {
            switchSchedTab('interval');
            var mins = t.intervalMinutes;
            if (mins >= 60 && mins % 60 === 0) { $('#slInterval').val(mins / 60); $('#slIntervalUnit').val('h'); }
            else { $('#slInterval').val(mins); $('#slIntervalUnit').val('m'); }
        } else if (t.cron) {
            var cronParts = t.cron.split(' ');
            // 尝试识别是否为 interval 格式: "0 */M * ? * DAYS"（新格式）或 "0 */M * * DAYS ?"（旧格式）
            var isIntervalLike = cronParts.length === 6 && cronParts[0] === '0' && cronParts[1].indexOf('*/') === 0
                && (cronParts[3] === '?' || cronParts[5] === '?');
            if (isIntervalLike) {
                switchSchedTab('interval');
                var mins = parseInt(cronParts[1].substring(2)) || 5;
                if (mins >= 60 && mins % 60 === 0) { $('#slInterval').val(mins / 60); $('#slIntervalUnit').val('h'); }
                else { $('#slInterval').val(mins); $('#slIntervalUnit').val('m'); }
                // 星期：新格式在 cronParts[5]，旧格式在 cronParts[4]
                var daysPart = cronParts[3] === '?' ? cronParts[5] : cronParts[4];
                if (daysPart && daysPart !== '*') {
                    $('#slIntervalWeekdays .loop-weekday-btn').removeClass('active');
                    var activeDays = daysPart.split(',');
                    for (var i = 0; i < activeDays.length; i++) {
                        var quartzDay = parseInt(activeDays[i]);
                        if (!isNaN(quartzDay)) {
                            var uiDay = quartzDay === 1 ? 7 : (quartzDay - 1);
                            $('#slIntervalWeekdays .loop-weekday-btn[data-day="' + uiDay + '"]').addClass('active');
                        }
                    }
                }
            } else {
                // 尝试识别是否为 daily 格式: "0 M H ? * DAYS"
                var isDailyLike = cronParts.length === 6 && cronParts[0] === '0' && cronParts[3] === '?';
                if (isDailyLike) {
                    switchSchedTab('daily');
                    var h = cronParts[2], m = cronParts[1];
                    $('#slDailyTime').val(('0' + h).slice(-2) + ':' + ('0' + m).slice(-2));
                    // Quartz cron 星期: 1=SUN, 2=MON, 3=TUE, 4=WED, 5=THU, 6=FRI, 7=SAT
                    // 界面星期: 1=MON, 2=TUE, 3=WED, 4=THU, 5=FRI, 6=SAT, 7=SUN
                    if (cronParts[5] !== '*') {
                        $('#slWeekdays .loop-weekday-btn').removeClass('active');
                        var activeDays = cronParts[5].split(',');
                        for (var i = 0; i < activeDays.length; i++) {
                            var quartzDay = parseInt(activeDays[i]);
                            if (!isNaN(quartzDay)) {
                                // 转换: Quartz => 界面格式: 1(SUN)=>7, 2(MON)=>1, 3(TUE)=>2, ...
                                var uiDay = quartzDay === 1 ? 7 : (quartzDay - 1);
                                $('#slWeekdays .loop-weekday-btn[data-day="' + uiDay + '"]').addClass('active');
                            }
                        }
                    }
                } else {
                    switchSchedTab('cron');
                    $('#slCron').val(t.cron);
                }
            }
        }

        if (t.makerAgent || t.checkerAgent || t.worktreeEnabled) {
            $('#slAdvanced').show();
            $('#slAdvancedToggle').removeClass('collapsed');
        }
    }

    function loadSessionsForBinding() {
        // 加载会话列表用于绑定会话下拉框
        $.ajax({
            url: '/web/chat/sessions',
            method: 'GET',
            dataType: 'json',
            success: function (res) {
                console.log('[Loop Settings] Sessions loaded:', res);
                if (res && res.code === 200 && res.data && res.data.length > 0) {
                    var $select = $('#slBoundSession');
                    // 按时间倒序排列（最新的在前）
                    var sessions = res.data.sort(function(a, b) {
                        return (b.time || 0) - (a.time || 0);
                    });
                    sessions.forEach(function (session) {
                        var label = session.label || session.sessionId;
                        $select.append('<option value="' + escapeHtml(session.sessionId) + '">' + escapeHtml(label) + '</option>');
                    });
                    if (typeof layui !== 'undefined' && layui.form) {
                        layui.form.render('select');
                    }
                    console.log('[Loop Settings] Added ' + sessions.length + ' sessions to dropdown');
                } else {
                    console.warn('[Loop Settings] No sessions returned or empty data');
                }
            },
            error: function (xhr, status, error) {
                console.error('[Loop Settings] Failed to load sessions:', status, error);
            }
        });
    }

    function load() { initEvents(); showList(); }

    window._settingsLoop = { load: load, showList: showList };
})();