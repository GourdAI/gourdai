/* app-settings-acp.js — 编码工具接入（ACP）设置页 */
(function () {
    'use strict';

    var CONTAINER = 'settingsTabAcp';
    var core = window._settingsCore || {};
    var escapeHtml = core.escapeHtml || function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    function t(key, args) { return window.GourdI18n ? GourdI18n.t(key, args) : key; }

    function showToast(msg, type) {
        if (typeof window.showToast === 'function') window.showToast(msg, type === 'error' ? 'error' : 'success');
    }

    function $c() { return $('#' + CONTAINER); }

    // ACP 采用 stdio 传输：编辑器作为客户端自行 spawn `gourdai acp` 子进程，无端口。
    // 本页仅拉取环境事实（启动器绝对路径 / 就绪状态）用于生成各编辑器配置片段。
    function load() {
        $.get('/web/settings/acp/info', function (resp) {
            if (resp && resp.code === 200 && resp.data) {
                render(resp.data);
            } else {
                renderError();
            }
        }).fail(renderError);
    }

    function renderError() {
        $c().html('<div class="settings-section"><div class="settings-section-desc">' +
            escapeHtml(t('settings.acp.load_failed')) + '</div></div>');
    }

    function codeBlock(id, content) {
        return '<div class="acp-codeblock">' +
            '<button class="acp-copy-btn" data-copy-target="' + id + '">' + escapeHtml(t('settings.acp.copy')) + '</button>' +
            '<pre id="' + id + '">' + escapeHtml(content) + '</pre>' +
            '</div>';
    }

    // 通用卡片外壳：标题 + 说明 + 主体，复用通用设置页的卡片视觉
    function card(title, desc, body) {
        var h = '<div class="general-card"><div class="general-card-header"><div class="general-card-text">';
        h += '<div class="general-card-title">' + escapeHtml(title) + '</div>';
        if (desc) h += '<div class="general-card-desc">' + escapeHtml(desc) + '</div>';
        h += '</div></div><div class="general-card-body">' + body + '</div></div>';
        return h;
    }

    function render(info) {
        var command = info.command || 'gourdai';
        var args = info.args || ['acp'];
        var ready = !!info.ready;
        var argsJson = JSON.stringify(args);

        var html = '';

        // 页头
        html += '<div class="settings-section-header settings-section-header-flat"><div>';
        html += '<span class="settings-section-title">' + escapeHtml(t('settings.acp.title')) + '</span>';
        html += '<div class="settings-section-desc">' + escapeHtml(t('settings.acp.desc')) + '</div>';
        html += '</div></div>';

        // 就绪状态横幅
        if (ready) {
            html += '<div class="acp-status acp-status-ok">' +
                '<div class="acp-status-line"><span class="acp-status-dot"></span>' +
                escapeHtml(t('settings.acp.ready')) + '</div></div>';
        } else {
            html += '<div class="acp-status acp-status-warn">' +
                '<div class="acp-status-line"><span class="acp-status-dot"></span>' +
                escapeHtml(t('settings.acp.not_ready')) + '</div>' +
                '<div class="acp-status-sub">' + escapeHtml(t('settings.acp.not_ready_desc')) + '</div></div>';
        }

        // 卡片组
        html += '<div class="general-card-group">';

        // 模型选择（layui select）
        html += card(t('settings.acp.model_title'), t('settings.acp.model_desc'), buildModelBody(info));

        // 工作原理
        html += card(t('settings.acp.how_title'), '',
            '<div class="acp-how-text">' + escapeHtml(t('settings.acp.how_desc')) + '</div>');

        // 编辑器集成配置（各 ACP 编辑器通用 JSON 配置块）
        html += card(t('settings.acp.generic_title'), t('settings.acp.zed_integration_desc'),
            buildIntegrationBody(command, argsJson));

        html += '</div>'; // /card-group

        $c().html(html);

    // HTML 注入后再渲染 layui 下拉（首屏与切换 tab 重复进入均生效）
        initModelSelect();
        initThinkingSelect();
    }

    // 去掉「供应商-」前缀的展示短名（分组标题已展示供应商，选项内不再重复）
    function modelShortName(name, provider) {
        if (provider && name && name.indexOf(provider + '-') === 0) {
            var rest = name.substring(provider.length + 1);
            if (rest) return rest;
        }
        return name;
    }

    function buildModelBody(info) {
        var rawModels = info.models || [];
        var current = info.acpModel || '';
        var defModel = info.defaultModel || '';

        // 归一化：models 兼容旧后端的字符串数组与新后端的 {name, provider} 对象数组
        var models = [];
        for (var n = 0; n < rawModels.length; n++) {
            var raw = rawModels[n];
            if (typeof raw === 'string') models.push({ name: raw, provider: '' });
            else models.push({ name: raw.name || '', provider: raw.provider || '' });
        }

        // 默认项：跟随全局默认模型（acpModel 留空即回落 defaultModel）
        var followLabel = defModel
            ? t('settings.acp.model_follow_default', [defModel])
            : t('settings.acp.model_follow_default_empty');

        var modelOpts = '<option value=""' + (current ? '' : ' selected') + '>' + escapeHtml(followLabel) + '</option>';

        // 按供应商分组（layui select 原生支持 optgroup，渲染为分组标题）；无 provider 归入「其他」
        var groups = [];
        var groupIndex = {};
        for (var i = 0; i < models.length; i++) {
            var g = models[i].provider || '';
            if (!(g in groupIndex)) { groupIndex[g] = groups.length; groups.push({ provider: g, items: [] }); }
            groups[groupIndex[g]].items.push(models[i]);
        }
        for (var gi = 0; gi < groups.length; gi++) {
            var grp = groups[gi];
            modelOpts += '<optgroup label="' + escapeHtml(grp.provider || t('history.model_group_other')) + '">';
            for (var j = 0; j < grp.items.length; j++) {
                var m = grp.items[j];
                modelOpts += '<option value="' + escapeHtml(m.name) + '"' + (m.name === current ? ' selected' : '') + '>' + escapeHtml(modelShortName(m.name, grp.provider)) + '</option>';
            }
            modelOpts += '</optgroup>';
        }

        // 思考深度选项
        var standard = info.acpModelStandard || '';
        var thinkingCurrent = info.acpThinkingDepth || 'off';
        var thinkingOptsArr = getThinkingOptions(standard);
        var thinkingOpts = '';
        for (var j = 0; j < thinkingOptsArr.length; j++) {
            var opt = thinkingOptsArr[j];
            thinkingOpts += '<option value="' + escapeHtml(opt.value) + '"' + (opt.value === thinkingCurrent ? ' selected' : '') + '>' + escapeHtml(opt.label) + '</option>';
        }

        // 单行并排：模型选择 + 思考深度
        var body = '<div class="acp-select-row">';
        body += '<div class="acp-select-item">';
        body += '<label class="acp-select-label">' + escapeHtml(t('settings.acp.model_label')) + '</label>';
        body += '<div class="layui-form acp-select-wrap"><select id="acpModel" lay-filter="acpModel">' + modelOpts + '</select></div>';
        body += '</div>';

        body += '<div class="acp-select-item">';
        body += '<label class="acp-select-label">' + escapeHtml(t('settings.acp.thinking_label')) + '</label>';
        body += '<div class="layui-form acp-select-wrap"><select id="acpThinking" lay-filter="acpThinking">' + thinkingOpts + '</select></div>';
        body += '</div>';
        body += '</div>';

        if (models.length === 0) {
            body += '<div class="acp-model-empty">' + escapeHtml(t('settings.acp.model_none')) + '</div>';
        }

        return body;
    }

    // 根据接口类型获取思考档位选项集
    function getThinkingOptions(standard) {
        var s = (standard || '').toLowerCase();
        var off = { value: 'off', label: t('history.thinking.off.label') };

        if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) {
            return [
                off,
                { value: 'low',    label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',   label: t('history.thinking.high.label') },
                { value: 'xhigh',  label: t('history.thinking.xhigh.label') },
                { value: 'max',    label: t('history.thinking.max.label') }
            ];
        } else if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) {
            return [
                off,
                { value: 'minimal', label: t('history.thinking.minimal.label') },
                { value: 'low',     label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',    label: t('history.thinking.high.label') }
            ];
        } else {
            // openai / openai-responses / ollama / 其它
            return [
                off,
                { value: 'minimal', label: t('history.thinking.minimal.label') },
                { value: 'low',     label: t('history.thinking.low.label') },
                { value: 'medium', label: t('history.thinking.medium.label') },
                { value: 'high',    label: t('history.thinking.high.label') }
            ];
        }
    }

    // 编辑器集成配置：生成 agent_servers 完整 JSON 配置块（各 ACP 编辑器通用）
    function buildIntegrationBody(command, argsJson) {
        var json = '{\n'
            + '  "agent_servers": {\n'
            + '    "Gourd AI": {\n'
            + '      "command": ' + JSON.stringify(command) + ',\n'
            + '      "args": ' + argsJson + ',\n'
            + '      "env": {}\n'
            + '    }\n'
            + '  }\n'
            + '}';
        return '<div class="acp-field"><label>' + escapeHtml(t('settings.acp.integration_json')) + '</label>' + codeBlock('acpIntegration', json) + '</div>';
    }

    // layui 下拉渲染 + 变更保存（事件按 lay-filter 全局绑定一次）
    var _selectBound = false;
    function initModelSelect() {
        if (typeof layui === 'undefined' || !layui.form) return;
        layui.use('form', function () {
            var form = layui.form;
            form.render('select');
            if (!_selectBound) {
                _selectBound = true;
                form.on('select(acpModel)', function (data) {
                    saveAcpModel(data.value || '');
                });
            }
        });
    }

    // 保存到 general.acpModel（允许置空=跟随默认）
    function saveAcpModel(value) {
        $.post('/web/settings/acp/model/save', { acpModel: value }, function (resp) {
            if (resp && resp.code === 200) {
                // 模型切换后，重新加载页面以更新思考档位选项集
                load();
            } else {
                showToast((resp && resp.description) || t('settings.acp.model_save_failed'), 'error');
            }
        }).fail(function () {
            showToast(t('settings.acp.model_save_failed'), 'error');
        });
    }

    // layui 下拉渲染 + 变更保存（思考深度）
    var _thinkingSelectBound = false;
    function initThinkingSelect() {
        if (typeof layui === 'undefined' || !layui.form) return;
        layui.use('form', function () {
            var form = layui.form;
            form.render('select');
            if (!_thinkingSelectBound) {
                _thinkingSelectBound = true;
                form.on('select(acpThinking)', function (data) {
                    saveAcpThinking(data.value || 'off');
                });
            }
        });
    }

    // 保存到 general.acpThinkingDepth
    function saveAcpThinking(value) {
        $.post('/web/settings/acp/thinking/save', { acpThinkingDepth: value }, function (resp) {
            if (!(resp && resp.code === 200)) {
                showToast((resp && resp.description) || t('settings.acp.thinking_save_failed'), 'error');
            }
        }).fail(function () {
            showToast(t('settings.acp.thinking_save_failed'), 'error');
        });
    }

    // 复制（navigator.clipboard 优先，execCommand 兜底）
    function copyText(text, cb) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { cb(true); }, function () { cb(fallbackCopy(text)); });
        } else {
            cb(fallbackCopy(text));
        }
    }

    function fallbackCopy(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) { return false; }
    }

    $(document).on('click', '#' + CONTAINER + ' .acp-copy-btn', function () {
        var self = this;
        var targetId = $(self).attr('data-copy-target');
        var text = $('#' + targetId).text();
        copyText(text, function (ok) {
            if (ok) {
                var old = $(self).text();
                $(self).text(t('settings.acp.copied')).addClass('copied');
                setTimeout(function () { $(self).text(old).removeClass('copied'); }, 1500);
            } else {
                showToast(t('settings.acp.copy_failed'), 'error');
            }
        });
    });

    window._settingsAcp = { load: load };
})();