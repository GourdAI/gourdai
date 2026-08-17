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

    // ACP 采用 stdio 传输：编辑器作为客户端自行 spawn `gwork acp` 子进程，无端口。
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
        var command = info.command || 'gwork';
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

        // 模型 + 思考深度：合并为关联选择器（思考档位内嵌在当前模型项下）
        html += card(t('settings.acp.model_title'), t('settings.acp.model_desc'), buildModelBody(info));

        // 工作原理
        html += card(t('settings.acp.how_title'), '',
            '<div class="acp-how-text">' + escapeHtml(t('settings.acp.how_desc')) + '</div>');

        // 编辑器集成配置（各 ACP 编辑器通用 JSON 配置块）
        html += card(t('settings.acp.generic_title'), t('settings.acp.zed_integration_desc'),
            buildIntegrationBody(command, argsJson));

        html += '</div>'; // /card-group

        $c().html(html);
    }

    /* ===== 模型 + 思考深度合并关联选择器 =====
     * 与聊天页模型选择器同一套交互：
     * - 点击按钮开合下拉；
     * - 点其他模型项 → 切换并保持下拉打开，思考档位 chips 立即跟随新模型渲染；
     * - 点思考档位 chip → 仅设档位，保持打开；
     * - 点当前已选模型项 → 收起（确认）。
     * 保存走服务端 general.acpModel / general.acpThinkingDepth（ACP 子进程下次启动生效）。
     */

    // 页面状态（load() 时从 /web/settings/acp/info 重建）
    var acpState = {
        models: [],          // [{name, provider, standard}, ...]
        current: '',         // 当前 acpModel（''=跟随默认）
        defaultModel: '',
        defaultStandard: '',
        currentStandard: '', // 当前选中模型对应的接口类型（决定思考档位选项集）
        thinking: 'off'
    };

    function followLabel() {
        return acpState.defaultModel
            ? t('settings.acp.model_follow_default', [acpState.defaultModel])
            : t('settings.acp.model_follow_default_empty');
    }

    // 查模型对应的接口类型（''=跟随默认 → 默认模型的接口类型）
    function standardOfAcpModel(name) {
        if (!name) return acpState.defaultStandard || '';
        for (var i = 0; i < acpState.models.length; i++) {
            if (acpState.models[i].name === name) return acpState.models[i].standard || '';
        }
        return '';
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

        // 归一化：models 兼容旧后端的字符串数组与新后端的 {name, provider, standard} 对象数组
        acpState.models = [];
        for (var n = 0; n < rawModels.length; n++) {
            var raw = rawModels[n];
            if (typeof raw === 'string') acpState.models.push({ name: raw, provider: '', standard: '' });
            else acpState.models.push({ name: raw.name || '', provider: raw.provider || '', standard: raw.standard || '' });
        }

        acpState.current = info.acpModel || '';
        acpState.defaultModel = info.defaultModel || '';
        acpState.defaultStandard = info.defaultModelStandard || '';
        acpState.thinking = info.acpThinkingDepth || 'off';
        // 当前模型接口类型：优先从列表查，回退后端已解析值（acpModel 置空时后端回落默认模型）
        acpState.currentStandard = standardOfAcpModel(acpState.current) || info.acpModelStandard || '';

        var body = renderAcpSelectorHtml();

        if (acpState.models.length === 0) {
            body += '<div class="acp-model-empty">' + escapeHtml(t('settings.acp.model_none')) + '</div>';
        }

        return body;
    }

    // 根据接口类型获取思考档位选项集（首项为「默认」=off，跟随模型默认行为）
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

    // 按钮内思考档位小标签：当前值为默认（off）或不在档位集内时不显示，其余显示短标签
    function acpThinkingTag() {
        if (!acpState.thinking || acpState.thinking === 'off') return '';
        var opts = getThinkingOptions(acpState.currentStandard);
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === acpState.thinking) return opts[k].label;
        }
        return '';
    }

    // 关联思考档位区（内嵌在当前选中模型项下）：首项为「默认」（off，跟随模型默认行为）
    function acpThinkingChipsHtml() {
        var opts = getThinkingOptions(acpState.currentStandard);

        // 当前档位是否在本接口档位集内（切换模型后旧值可能不适用 → 视作默认）
        var valid = 'off';
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].value === acpState.thinking) { valid = acpState.thinking; break; }
        }

        var html = '<div class="model-thinking-opts"><span class="model-thinking-label">'
            + escapeHtml(t('app.thinking_label')) + '</span>';
        for (var i = 0; i < opts.length; i++) {
            var o = opts[i];
            var cls = o.value === valid ? ' active' : '';
            html += '<span class="model-thinking-chip' + cls + '" data-thinking="' + escapeHtml(o.value) + '">'
                + escapeHtml(o.label) + '</span>';
        }
        html += '</div>';
        return html;
    }

    function acpDropdownItemsHtml() {
        var current = acpState.current;
        var html = '';

        // 首项：跟随默认模型（acpModel 置空即回落 defaultModel）
        html += '<div class="model-dropdown-item' + (current === '' ? ' active' : '') + '" data-model="">'
            + '<span class="model-item-name">' + escapeHtml(followLabel()) + '</span>'
            + (current === '' ? acpThinkingChipsHtml() : '')
            + '</div>';

        // 按供应商分组（map 归组，不依赖相邻性）；无 provider 的归入「其他」组
        var groups = [];
        var groupIndex = {};
        for (var i = 0; i < acpState.models.length; i++) {
            var g = acpState.models[i].provider || '';
            if (!(g in groupIndex)) { groupIndex[g] = groups.length; groups.push({ provider: g, items: [] }); }
            groups[groupIndex[g]].items.push(acpState.models[i]);
        }
        for (var gi = 0; gi < groups.length; gi++) {
            var grp = groups[gi];
            html += '<div class="model-dropdown-group">' + escapeHtml(grp.provider || t('history.model_group_other')) + '</div>';
            for (var j = 0; j < grp.items.length; j++) {
                var m = grp.items[j];
                var active = m.name === current;
                html += '<div class="model-dropdown-item' + (active ? ' active' : '') + '" data-model="' + escapeHtml(m.name) + '">'
                    + '<span class="model-item-name">' + escapeHtml(modelShortName(m.name, grp.provider)) + '</span>'
                    + (active ? acpThinkingChipsHtml() : '')
                    + '</div>';
            }
        }
        return html;
    }

    function renderAcpSelectorHtml() {
        var displayName = acpState.current ? modelShortName(acpState.current, providerOf(acpState.current)) : followLabel();
        var tag = acpThinkingTag();
        return '<div class="model-selector dropdown-down acp-model-selector" id="acpModelSelector">'
            + '<div class="model-selector-current">'
            + '<span class="model-name">' + escapeHtml(displayName) + '</span>'
            + (tag ? '<span class="model-thinking-tag">' + escapeHtml(tag) + '</span>' : '')
            + '<span class="model-arrow">▾</span>'
            + '</div>'
            + '<div class="model-dropdown">' + acpDropdownItemsHtml() + '</div>'
            + '</div>';
    }

    function providerOf(name) {
        for (var i = 0; i < acpState.models.length; i++) {
            if (acpState.models[i].name === name) return acpState.models[i].provider || '';
        }
        return '';
    }

    // 仅重建选择器（保存成功后就地刷新，不整页 load，保持下拉打开态）
    function renderAcpSelector(keepOpen) {
        var $old = $('#acpModelSelector');
        var wasOpen = keepOpen || ($old.length && $old.hasClass('open'));
        if ($old.length) $old.replaceWith(renderAcpSelectorHtml());
        if (wasOpen) $('#acpModelSelector').addClass('open');
    }

    // 保存到 general.acpModel（允许置空=跟随默认）
    function saveAcpModel(value) {
        $.post('/web/settings/acp/model/save', { acpModel: value }, function (resp) {
            if (resp && resp.code === 200) {
                acpState.current = value;
                acpState.currentStandard = standardOfAcpModel(value);
                renderAcpSelector(true);
            } else {
                showToast((resp && resp.description) || t('settings.acp.model_save_failed'), 'error');
            }
        }).fail(function () {
            showToast(t('settings.acp.model_save_failed'), 'error');
        });
    }

    // 保存到 general.acpThinkingDepth
    function saveAcpThinking(value) {
        $.post('/web/settings/acp/thinking/save', { acpThinkingDepth: value }, function (resp) {
            if (resp && resp.code === 200) {
                acpState.thinking = value;
                renderAcpSelector(true);
            } else {
                showToast((resp && resp.description) || t('settings.acp.thinking_save_failed'), 'error');
            }
        }).fail(function () {
            showToast(t('settings.acp.thinking_save_failed'), 'error');
        });
    }

    /* ===== 选择器事件（document 委托：render() 每次重建 HTML，无需重复绑定） ===== */
    $(document).on('click', '#' + CONTAINER + ' .model-selector-current', function (e) {
        e.stopPropagation();
        $('#acpModelSelector').toggleClass('open');
    });

    $(document).on('click', '#' + CONTAINER + ' .model-dropdown', function (e) {
        // 关联的思考档位 chip：仅设定档位，不切模型；保持下拉打开便于连续调整
        var $chip = $(e.target).closest('.model-thinking-chip');
        if ($chip.length) {
            e.stopPropagation();
            var depth = $chip.attr('data-thinking');
            if (depth != null && depth !== acpState.thinking) {
                saveAcpThinking(depth);
            }
            return;
        }
        var $item = $(e.target).closest('.model-dropdown-item');
        if (!$item.length) return;
        e.stopPropagation();
        var modelName = $item.attr('data-model');
        if (modelName == null) return;
        if (modelName === acpState.current) {
            // 点击当前已选模型项：视为「确认/收起」动作，关闭下拉
            $('#acpModelSelector').removeClass('open');
            return;
        }
        // 切换模型后保持下拉打开：让用户继续在新模型项下选择思考档位（关联选择）
        saveAcpModel(modelName);
    });

    // 点击选择器外部时收起
    $(document).on('click', function (e) {
        if (!$(e.target).closest('#acpModelSelector').length) {
            $('#acpModelSelector').removeClass('open');
        }
    });

    // 国际化：语言切换后重建选择器文案（chips / 跟随默认标签随语言变）
    document.addEventListener('i18n:localeChanged', function () {
        if ($('#acpModelSelector').length) renderAcpSelector();
    });

    // 编辑器集成配置：生成 agent_servers 完整 JSON 配置块（各 ACP 编辑器通用）
    function buildIntegrationBody(command, argsJson) {
        var json = '{\n'
            + '  "agent_servers": {\n'
            + '    "GWork": {\n'
            + '      "command": ' + JSON.stringify(command) + ',\n'
            + '      "args": ' + argsJson + ',\n'
            + '      "env": {}\n'
            + '    }\n'
            + '  }\n'
            + '}';
        return '<div class="acp-field"><label>' + escapeHtml(t('settings.acp.integration_json')) + '</label>' + codeBlock('acpIntegration', json) + '</div>';
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
