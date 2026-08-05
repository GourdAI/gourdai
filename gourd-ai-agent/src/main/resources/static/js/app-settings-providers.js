/**
 * 模型配置管理模块（按连接管理）
 *
 * 负责模型连接的增删改查、模型列表拉取、接口类型按模型配置
 */
;(function () {
    'use strict';

    var core = window._settingsCore;
    var postJson = core.postJson;
    var escapeAttr = core.escapeAttr;
    var showToast = core.showToast;

    // ==================== 状态管理 ====================
    var providers = [];
    var currentProvider = null; // 当前编辑的连接（null 表示新增）
    var fetchedModels = []; // 已拉取/已配置的模型列表

    // 接口类型选项（按模型单独配置）
    var STANDARD_OPTIONS = [
        { value: 'openai', label: 'OpenAI (Chat Completions)' },
        { value: 'openai-responses', label: 'OpenAI (Responses)' },
        { value: 'anthropic', label: 'Anthropic (Messages)' },
        { value: 'gemini', label: 'Google (Gemini)' }
    ];
    var DEFAULT_STANDARD = 'openai';

    // ==================== DOM 元素 ====================
    var $listView = $('#providersListView');
    var $formView = $('#providersFormView');
    var $providerList = $('#providerList');
    var $formTitle = $('#providerFormTitle');
    var $modelsList = $('#providerModelsList');
    var $modelsEmpty = $('#providerModelsEmpty');

    // ==================== 初始化 ====================
    function init() {
        bindEvents();
        // 桌面端冷启动时后端 jar 尚未就绪，直接拉取会失败并弹“加载模型连接列表失败”。
        // 与其它启动即拉取的模块一致，改经 __whenBackendReady 门闸延后到后端就绪再发；
        // 浏览器端无 IPC 会立即执行，行为不变。bindEvents 仍立即执行，不影响 UI 绑定。
        __whenBackendReady(loadProvidersList);
    }

    function bindEvents() {
        // 添加供应商按钮
        $('#providerAddBtn').on('click', function () {
            showForm(null);
        });

        // 返回按钮
        $('#providerBackBtn').on('click', function () {
            showList();
        });

        // 拉取模型列表
        $('#providerFetchModelsBtn').on('click', function () {
            fetchModels();
        });

        // 清空模型列表
        $('#providerClearModelsBtn').on('click', function () {
            if (fetchedModels.length === 0) return;
        var tConfirm = GourdI18n.t('settings.confirm_delete') + GourdI18n.t('settings.providers.model_management') + '？' + GourdI18n.t('settings.providers.add_model') + GourdI18n.t('common.delete');
        layConfirm(tConfirm, function () {
                fetchedModels = [];
                renderModelsList();
                if (currentProvider) {
                    persistProvider(false);
                }
            });
        });

        // 手动添加模型
        $('#providerAddModelBtn').on('click', function () {
            openModelDialog(null);
        });

        // 模型列表 - 删除手动模型
        $modelsList.on('click', '.provider-model-remove-btn', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            removeManualModel(modelId);
        });

        // 模型列表 - 点击模型信息，弹出修改配置弹框
        $modelsList.on('click', '.provider-model-info', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            var model = null;
            for (var i = 0; i < fetchedModels.length; i++) {
                if (String(fetchedModels[i].id) === String(modelId)) {
                    model = fetchedModels[i];
                    break;
                }
            }
            if (model) openModelDialog(model);
        });

        // 保存按钮
        $('#providerSaveBtn').on('click', function () {
            saveProvider();
        });

        // 删除按钮
        $('#providerFormDeleteBtn').on('click', function () {
            deleteProvider();
        });

        // 列表项点击（编辑）
        $providerList.on('click', '.mcp-server-item', function (e) {
            // 忽略开关点击
            if ($(e.target).closest('.toggle-switch').length) return;
            if ($(e.target).closest('.mcp-action-btn').length) return;
            var name = $(this).data('name');
            editProvider(name);
        });

        // 启用/禁用开关
        $providerList.on('change', '.provider-toggle', function () {
            var name = $(this).closest('.mcp-server-item').data('name');
            var enabled = $(this).prop('checked');
            toggleProvider(name, enabled);
        });

        // 模型列表 - 启用/禁用开关
        $modelsList.on('change', '.provider-model-toggle', function () {
            var modelId = $(this).closest('.provider-model-item').data('model-id');
            var enabled = $(this).prop('checked');
            var llmName = $(this).data('llm-name');
            var isSynced = $(this).data('synced') === true || $(this).data('synced') === 'true';
            toggleProviderModel(modelId, enabled, llmName, isSynced);
        });

        // 模型列表 - 接口类型切换（按模型，layui select）：编辑模式下即时生效
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.on('select(providerModelStd)', function (data) {
                var modelId = $(data.elem).data('model-id');
                var std = data.value;
                for (var i = 0; i < fetchedModels.length; i++) {
                    if (fetchedModels[i].id === modelId) {
                        fetchedModels[i].standard = std;
                        break;
                    }
                }
                if (currentProvider) {
                    persistProvider(false);
                }
            });
        }

        // 连接基础字段（作用域/模型列表接口/API 地址/密钥/超时）：编辑模式下变更即时保存；新增模式仍走保存按钮
        $('.settings-scope-toggle[data-target="providerScope"]').on('click', '.settings-scope-btn', function () {
            if (currentProvider) {
                // 先同步隐藏域，再持久化（通用作用域切换 handler 在其后执行，两者幂等）
                $('#providerScope').val($(this).data('scope'));
                persistProvider(false);
            }
        });
        $('input[name="providerStandard"]').on('change', function () {
            if (currentProvider) persistProvider(false);
        });
        $('#providerApiUrl, #providerApiKey, #providerTimeout').on('change', function () {
            if (currentProvider) persistProvider(false);
        });

        // 批量选择菜单
        $('#providerModelsSelectToggle').on('click', function (e) {
            e.stopPropagation();
            $('#providerModelsActionMenu').toggleClass('show');
        });

        $(document).on('click', function (e) {
            if ($(e.target).closest('.provider-model-menu-wrap').length === 0) {
                $('#providerModelsActionMenu').removeClass('show');
            }
        });

        $('#providerModelsSelectAll, #providerModelsSelectNone, #providerModelsInvert').on('click', function () {
            var action = this.id;
            var changed = false;

            $modelsList.find('.provider-model-toggle').each(function () {
                var $toggle = $(this);
                var nextChecked = $toggle.prop('checked');

                if (action === 'providerModelsSelectAll') {
                    nextChecked = true;
                } else if (action === 'providerModelsSelectNone') {
                    nextChecked = false;
                } else if (action === 'providerModelsInvert') {
                    nextChecked = !$toggle.prop('checked');
                }

                if ($toggle.prop('checked') !== nextChecked) {
                    changed = true;
                    $toggle.prop('checked', nextChecked).trigger('change');
                }
            });

            $('#providerModelsActionMenu').removeClass('show');
        });

        // 作用域切换
        $('.settings-scope-toggle').on('click', '.settings-scope-btn', function () {
            var $toggle = $(this).closest('.settings-scope-toggle');
            var target = $toggle.data('target');
            var scope = $(this).data('scope');
            $toggle.find('.settings-scope-btn').removeClass('active');
            $(this).addClass('active');
            $('#' + target).val(scope);
        });
    }

    // ==================== 列表视图 ====================
    function loadProvidersList() {
        $.ajax({
            url: '/web/settings/providers',
            method: 'GET',
            success: function (res) {
                if (res.code === 200) {
                    providers = res.data || [];
                    renderProvidersList();
                }
            },
            error: function () {
                showToast(GourdI18n.t('common.loading') + GourdI18n.t('settings.providers.title') + GourdI18n.t('settings.loop.operation_failed'), 'error');
            }
        });
    }

    function renderProvidersList() {
        var html = '';
        if (providers.length === 0) {
            html = '<div class="mcp-empty-state"><div class="mcp-empty-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg></div><div class="mcp-empty-title">' + GourdI18n.t('common.no_data') + GourdI18n.t('settings.providers.title') + '</div><div class="mcp-empty-desc">' + GourdI18n.t('settings.providers.desc') + '</div></div>';
        } else {
            providers.forEach(function (provider) {
                html += renderProviderItem(provider);
            });
        }
        $providerList.html(html);
    }

    function renderProviderItem(provider) {
        var modelsCount = (provider.models || []).length;

        return '<div class="mcp-server-item' + (provider.enabled === false ? ' disabled' : '') + '" data-name="' + provider.name + '">' +
            '<div class="mcp-server-icon">M</div>' +
            '<div class="mcp-server-info">' +
                '<div class="mcp-server-name">' + provider.name + '</div>' +
                '<div class="mcp-server-detail">' + (provider.apiUrl || GourdI18n.t('settings.channel.not_configured')) + '</div>' +
            '</div>' +
            '<div class="mcp-server-actions">' +
                '<span class="mcp-server-detail">' + modelsCount + ' ' + GourdI18n.t('settings.providers.title') + '</span>' +
                '<label class="toggle-switch" title="' + GourdI18n.t(provider.enabled ? 'settings.loop.disable' : 'settings.loop.enable') + '">' +
                    '<input type="checkbox" ' + (provider.enabled ? 'checked' : '') + ' data-name="' + provider.name + '" class="provider-toggle"/>' +
                    '<span class="toggle-slider"></span>' +
                '</label>' +
            '</div>' +
        '</div>';
    }

    // ==================== 表单视图 ====================
    function showForm(provider) {
        currentProvider = provider;
        // 复制模型列表，并为每个模型补齐接口类型（缺省 openai）
        fetchedModels = (provider && provider.models) ? provider.models.map(function (m) {
            return {
                id: m.id,
                manual: m.manual || false,
                standard: m.standard || (provider.standard || DEFAULT_STANDARD),
                maxInputTokens: m.maxInputTokens,
                enabled: m.enabled !== false
            };
        }) : [];

        // 切换视图
        $listView.hide();
        $formView.show();

        // 设置标题
        $formTitle.text(provider ? GourdI18n.t('settings.providers.edit_title') : GourdI18n.t('settings.providers.add'));

        // 填充表单
        var isBuiltin = !!(provider && provider.builtin);
        $('#providerName').val(provider ? provider.name : '').prop('readonly', !!provider);
        var stdVal = provider ? (provider.standard || DEFAULT_STANDARD) : DEFAULT_STANDARD;
        $('input[name="providerStandard"]').prop('checked', false)
            .filter('[value="' + stdVal + '"]').prop('checked', true);
        // 内置连接：API 地址锁定只读（名称已在编辑态 readonly）
        $('#providerApiUrl').val(provider ? provider.apiUrl : '').prop('readonly', isBuiltin);
        $('#providerApiKey').val(provider ? provider.apiKey : '');
        $('#providerTimeout').val(provider && provider.timeout ? provider.timeout : '');
        $('#providerScope').val(provider ? (provider.scope || 'user') : 'user');

        // 内置连接不可删除：隐藏删除按钮（其余字段照常可编辑）
        $('#providerFormDeleteBtn').toggle(!!provider && !isBuiltin);

        // 仅内置服务商（Gourd AI 官方托管）显示"访问官网获取 API 密钥"提示，其它自定义服务商不显示
        $('#providerBuiltinKeyHint').toggle(isBuiltin);

        // 设置作用域按钮状态
        var scope = provider ? (provider.scope || 'user') : 'user';
        $('.settings-scope-toggle[data-target="providerScope"] .settings-scope-btn').removeClass('active');
        $('.settings-scope-toggle[data-target="providerScope"] .settings-scope-btn[data-scope="' + scope + '"]').addClass('active');

        // 渲染"模型列表接口" layui 单选，使皮肤与选中态同步
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('radio', 'providerStandardForm');
        }

        // 编辑模式：页面内操作均即时生效，隐藏保存按钮（新增模式保留手动保存）
        $('#providerSaveBtn').closest('.form-actions').toggle(!provider);

        // 加载 LLM 模型缓存后渲染模型列表
        loadLlmModelsCache(function () {
            renderModelsList();
        });
    }

    function showList() {
        $formView.hide();
        $listView.show();
        currentProvider = null;
        fetchedModels = [];
        loadProvidersList();
    }

    // ==================== 模型列表 ====================
    var llmModelsCache = {}; // 缓存 LLM 模型列表，用于判断是否已同步

    // 将 token 数格式化为便于阅读的输入值（128000 -> "128k"）
    function formatTokensInput(n) {
        if (!n || n <= 0) return '';
        if (n % 1000000 === 0) return (n / 1000000) + 'm';
        if (n % 1000 === 0) return (n / 1000) + 'k';
        return String(n);
    }

    // 解析上下文长度输入（"128k"/"1m"/数字 -> token 数），无效返回 undefined
    function parseTokensInput(raw) {
        var maxTokens = (raw || '').trim();
        if (!maxTokens) return undefined;
        var trimmed = maxTokens.replace(/[, _]/g, '');
        var matchK = trimmed.match(/^(\d+\.?\d*)k$/i);
        var matchM = trimmed.match(/^(\d+\.?\d*)m$/i);
        if (matchK) return Math.round(parseFloat(matchK[1]) * 1000);
        if (matchM) return Math.round(parseFloat(matchM[1]) * 1000000);
        if (parseInt(trimmed, 10) > 0) return parseInt(trimmed, 10);
        return undefined;
    }

    // 添加 / 修改模型弹框（model 为 null 表示新增，否则为编辑）
    function openModelDialog(model) {
        var isEdit = !!model;
        var curStd = isEdit ? (model.standard || DEFAULT_STANDARD) : DEFAULT_STANDARD;
        var manualStdOptions = '';
        STANDARD_OPTIONS.forEach(function (opt) {
            manualStdOptions += '<option value="' + opt.value + '"' + (opt.value === curStd ? ' selected' : '') + '>' + opt.label + '</option>';
        });
        var nameVal = isEdit ? escapeAttr(model.id) : '';
        var tokensVal = isEdit ? escapeAttr(formatTokensInput(model.maxInputTokens)) : '';
        var dialogHtml = '<div class="model-add-overlay" id="modelAddOverlay">'
            + '<div class="model-add-dialog">'
            + '<div class="model-add-header">'
             + '<span class="model-add-title">' + (isEdit ? GourdI18n.t('common.edit') + GourdI18n.t('settings.providers.model_management') : GourdI18n.t('settings.providers.add_model')) + '</span>'
            + '<button class="model-add-close" id="modelAddClose">&times;</button>'
            + '</div>'
            + '<div class="model-add-body">'
            + '<div class="form-group">'
             + '<label>' + GourdI18n.t('settings.providers.model_name') + ' <span class="required">*</span></label>'
             + '<input type="text" id="manualModelName" placeholder="' + GourdI18n.t('settings.providers.model_id') + ' (e.g. gpt-4o-mini)" value="' + nameVal + '">'
            + '</div>'
            + '<div class="form-group layui-form" lay-filter="manualModelForm">'
             + '<label>' + GourdI18n.t('settings.providers.model_standard') + ' <span class="required">*</span></label>'
            + '<select id="manualModelStandard" lay-filter="manualModelStandard">' + manualStdOptions + '</select>'
            + '</div>'
            + '<div class="form-group">'
             + '<label>' + GourdI18n.t('settings.providers.model_context') + '</label>'
             + '<input type="text" id="manualModelTokens" inputmode="numeric" placeholder="' + GourdI18n.t('settings.providers.model_context') + '" list="manualContextLengthList" autocomplete="off" value="' + tokensVal + '">'
            + '<datalist id="manualContextLengthList">'
            + '<option value="128k">'
            + '<option value="256k">'
            + '<option value="512k">'
            + '<option value="1m">'
            + '</datalist>'
            + '</div>'
            + '</div>'
            + '<div class="model-add-footer">'
             + '<button class="btn-secondary" id="modelAddCancel">' + GourdI18n.t('common.cancel') + '</button>'
             + '<button class="btn-primary" id="modelAddConfirm">' + (isEdit ? GourdI18n.t('common.save') + GourdI18n.t('common.edit') : GourdI18n.t('common.confirm') + GourdI18n.t('common.add')) + '</button>'
            + '</div>'
            + '</div>'
            + '</div>';

        $('body').append(dialogHtml);

        var $overlay = $('#modelAddOverlay');

        // 渲染弹框内的 layui 接口类型下拉
        var manualStandard = curStd;
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('select');
            layui.form.on('select(manualModelStandard)', function (data) {
                manualStandard = data.value;
            });
        }

        function doSave() {
            var modelId = $overlay.find('#manualModelName').val().trim();
            var maxInputTokens = parseTokensInput($overlay.find('#manualModelTokens').val());

            if (!modelId) {
                showToast(GourdI18n.t('settings.providers.model_name') + GourdI18n.t('common.required'), 'error');
                return;
            }

            // 名称重复校验（编辑时排除自身）
            var exists = fetchedModels.some(function (m) {
                return m.id === modelId && (!isEdit || m.id !== model.id);
            });
            if (exists) {
                showToast(GourdI18n.t('settings.providers.model_name') + ' "' + modelId + '" ' + GourdI18n.t('settings.providers.model_exists'), 'error');
                return;
            }

            if (isEdit) {
                model.id = modelId;
                model.standard = manualStandard || DEFAULT_STANDARD;
                if (maxInputTokens) {
                    model.maxInputTokens = maxInputTokens;
                } else {
                    delete model.maxInputTokens;
                }
            } else {
                var newModel = { id: modelId, manual: true, standard: manualStandard || DEFAULT_STANDARD };
                if (maxInputTokens) newModel.maxInputTokens = maxInputTokens;
                fetchedModels.push(newModel);
            }
            renderModelsList();
            // 编辑模式下即时生效（新增模式仍随保存按钮一并提交）
            if (currentProvider) {
                persistProvider(false);
            }
            $overlay.remove();
        }

        $('#modelAddConfirm').on('click', doSave);
        $('#modelAddCancel, #modelAddClose').on('click', function() {
            $overlay.remove();
        });
        $overlay.on('click', function(e) {
            if (e.target === this) $overlay.remove();
        });
        $overlay.on('keypress', 'input', function(e) {
            if (e.which === 13) doSave();
        });
        setTimeout(function() {
            $overlay.find('#manualModelName').focus();
        }, 100);
    }

    function removeManualModel(modelId) {
        fetchedModels = fetchedModels.filter(function (m) {
            return m.id !== modelId;
        });
        renderModelsList();
        if (currentProvider) {
            persistProvider(false);
        }
    }

    function fetchModels() {
        var apiUrl = $('#providerApiUrl').val();
        var apiKey = $('#providerApiKey').val();
        var standard = $('input[name="providerStandard"]:checked').val() || DEFAULT_STANDARD;

        if (!apiUrl) {
            showToast(GourdI18n.t('settings.providers.api_url') + GourdI18n.t('common.required'), 'error');
            return;
        }

        var $btn = $('#providerFetchModelsBtn');
        $btn.prop('disabled', true).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>');

        $.ajax({
            url: '/web/settings/providers/fetch',
            method: 'POST',
            data: {
                apiUrl: apiUrl,
                apiKey: apiKey,
                standard: standard
            },
            success: function (res) {
                $btn.prop('disabled', false).html('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>');
                if (res.code === 200) {
                    try {
                        var data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
                        var models = data.data || data.models || data || [];
                        // 记录已有模型的接口类型，拉取后尽量沿用
                    var prevStandards = {};
                        var prevEnabled = {};
                        fetchedModels.forEach(function (m) {
                            if (m.standard) prevStandards[m.id] = m.standard;
                            prevEnabled[m.id] = m.enabled !== false;
                        });
                        // 保留手动添加的模型，合并拉取的模型
                        var manualModels = fetchedModels.filter(function (m) {
                            return m.manual === true;
                        });
                        var fetchedMapped = models.map(function (m) {
                            var id = m.id || m.name || m;
                            // 接口类型优先级：用户此前手动设定 > 后端按 supported_endpoint_types 推断 > 默认 openai
                            var std = prevStandards[id] || m.standard || DEFAULT_STANDARD;
                            return { id: id, manual: false, standard: std, enabled: prevEnabled[id] !== false };
                        });
                        // 手动模型去重：如果手动模型 id 已在拉取列表中，保留手动标记
                        var fetchedIds = {};
                        fetchedMapped.forEach(function (m) { fetchedIds[m.id] = m; });
                        manualModels.forEach(function (mm) {
                            if (fetchedIds[mm.id]) {
                                fetchedIds[mm.id].manual = true;
                                if (mm.standard) fetchedIds[mm.id].standard = mm.standard;
                                if (mm.maxInputTokens) {
                                    fetchedIds[mm.id].maxInputTokens = mm.maxInputTokens;
                                }
                                if (mm.enabled !== undefined) {
                                    fetchedIds[mm.id].enabled = mm.enabled;
                                }
                            } else {
                                fetchedMapped.push(mm);
                            }
                        });
                        fetchedModels = fetchedMapped;
                        // 加载 LLM 模型列表缓存，用于判断同步状态
                        loadLlmModelsCache(function () {
                            renderModelsList();
                            // 编辑模式下拉取结果即时生效
                            if (currentProvider) {
                                persistProvider(false);
                            }
                        });
                showToast(GourdI18n.t('settings.providers.fetch_models_success').replace('{0}', fetchedModels.length), 'success');
                    } catch (e) {
                         showToast(GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                    }
                } else {
                     showToast(res.msg || GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            },
            error: function (xhr) {
                $btn.prop('disabled', false).html('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>');
                showToast(GourdI18n.t('settings.providers.fetch_models') + GourdI18n.t('settings.loop.operation_failed') + ': ' + (xhr.responseText || GourdI18n.t('settings.network_error')), 'error');
            }
        });
    }

    // 加载 LLM 模型列表缓存
    function loadLlmModelsCache(callback) {
        $.get('/web/settings/llm/models', function (res) {
            if (res.code === 200 && res.data) {
                var list = res.data.list || (Array.isArray(res.data) ? res.data : []);
                llmModelsCache = {};
                list.forEach(function (item) {
                    if (item.name) {
                        llmModelsCache[item.name] = item;
                    }
                });
            }
            if (callback) callback();
        }).fail(function () {
            if (callback) callback();
        });
    }

    function renderModelsList() {
        if (fetchedModels.length === 0) {
            $modelsEmpty.show();
            $modelsList.hide();
            return;
        }

        $modelsEmpty.hide();
        $modelsList.show();

        var providerName = $('#providerName').val() || '';
        var providerEnabled = $('#providerEnabled').val() === 'true' || currentProvider && currentProvider.enabled !== false;
        var html = '';
        fetchedModels.forEach(function (model) {
            // 检查是否已同步到 LLM
            var llmName = providerName ? providerName + '-' + model.id : model.id;
            var syncedModel = llmModelsCache[llmName];
            var isSynced = !!syncedModel;
            // 设置端点返回全量模型，enabled 已综合 visibled 与连接启用状态
            var enabled = isSynced ? syncedModel.enabled !== false : providerEnabled;

            var manualTag = model.manual ? ' <span class="provider-model-manual-tag">' + GourdI18n.t('settings.providers.model_manual') + '</span>' : '';
            var removeBtn = model.manual
                ? '<button class="provider-model-remove-btn" title="' + GourdI18n.t('common.delete') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
                : '';

            // 上下文长度提示（若已配置）
            var tokensHint = model.maxInputTokens
                ? '<div class="provider-model-sub">' + GourdI18n.t('settings.providers.model_context') + ' ' + escapeAttr(formatTokensInput(model.maxInputTokens)) + '</div>'
                : '';

            // 接口类型下拉（按模型，layui 样式）
            var curStd = model.standard || DEFAULT_STANDARD;
            var stdOptions = '';
            STANDARD_OPTIONS.forEach(function (opt) {
                stdOptions += '<option value="' + opt.value + '"' + (opt.value === curStd ? ' selected' : '') + '>' + opt.label + '</option>';
            });
            var stdSelect = '<div class="provider-model-standard-wrap">' +
                '<select lay-filter="providerModelStd" data-model-id="' + escapeAttr(model.id) + '">' + stdOptions + '</select>' +
                '</div>';

            html += '<div class="provider-model-item' + (!enabled ? ' disabled' : '') + '" data-model-id="' + model.id + '">' +
                '<div class="provider-model-info" title="' + GourdI18n.t('common.edit') + GourdI18n.t('settings.providers.model_management') + '">' +
                     '<div class="provider-model-name">' + model.id + manualTag + (isSynced ? ' <span class="provider-model-synced">' + GourdI18n.t('settings.providers.synced') + '</span>' : '') + '</div>' +
                    tokensHint +
                '</div>' +
                '<div class="provider-model-actions">' +
                    stdSelect +
                    removeBtn +
                     '<label class="toggle-switch" title="' + GourdI18n.t(enabled ? 'settings.loop.disable' : 'settings.loop.enable') + '">' +
                        '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' class="provider-model-toggle" data-synced="' + isSynced + '" data-llm-name="' + llmName + '"/>' +
                        '<span class="toggle-slider"></span>' +
                    '</label>' +
                '</div>' +
            '</div>';
        });
        $modelsList.html(html);
        // 渲染 layui 下拉（切换事件在 bindEvents 里按 lay-filter=providerModelStd 全局绑定一次）
        if (typeof layui !== 'undefined' && layui.form) {
            layui.form.render('select');
        }
    }

    function toggleProviderModel(modelId, enabled, llmName, isSynced) {
        // 记录按模型的启用状态
        var model = null;
        for (var i = 0; i < fetchedModels.length; i++) {
            if (String(fetchedModels[i].id) === String(modelId)) {
                model = fetchedModels[i];
                break;
            }
        }
        if (model) {
            model.enabled = enabled;
        }

        // 如果已同步到模型列表，直接调用后端接口即时更新运行时状态
        if (isSynced && llmName) {
            postJson('/web/settings/llm/models/toggle', { name: llmName, enabled: enabled }, function (resp) {
                if (resp.code === 200) {
                    // 通知聊天组件刷新模型下拉列表（设置页缓存由后续 persistProvider 链路刷新）
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                } else {
                    showToast(GourdI18n.t('settings.loop.operation_failed') + ': ' + (resp.message || GourdI18n.t('common.unknown_error')), 'error');
                    // 回滚状态
                    if (model) model.enabled = !enabled;
                    renderModelsList();
                    return;
                }
                // 持久化按模型启用状态，避免后续同步把开关状态改回去
                if (currentProvider) {
                    persistProvider(false);
                }
            });
        } else if (currentProvider) {
            // 未同步：即时持久化并触发后端同步生成运行时模型
            persistProvider(false);
        }
    }

    // ==================== CRUD 操作 ====================
    function editProvider(name) {
        $.ajax({
            url: '/web/settings/providers/get',
            method: 'GET',
            data: { name: name },
            success: function (res) {
                if (res.code === 200) {
                    showForm(res.data);
                } else {
                    showToast(res.msg || GourdI18n.t('settings.loop.operation_failed'), 'error');
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
            }
        });
    }

    // 持久化连接及其模型列表。showSuccessToast=true 用于手动保存场景提示；
    // 编辑模式下各处即时生效的调用传 false（静默保存）
    function persistProvider(showSuccessToast) {
        var name = $('#providerName').val();
        var standard = $('input[name="providerStandard"]:checked').val() || DEFAULT_STANDARD;
        var apiUrl = $('#providerApiUrl').val();
        var apiKey = $('#providerApiKey').val();
        var scope = $('#providerScope').val();
        var timeout = ($('#providerTimeout').val() || '').trim();
        var models = fetchedModels.map(function (m) {
            var model = { id: m.id, manual: m.manual || false, standard: m.standard || DEFAULT_STANDARD, enabled: m.enabled !== false };
            if (m.maxInputTokens) {
                model.maxInputTokens = m.maxInputTokens;
            }
            return model;
        });

        if (!name) {
            showToast(GourdI18n.t('common.name') + GourdI18n.t('common.required'), 'error');
            return;
        }
        if (!apiUrl) {
            showToast(GourdI18n.t('settings.providers.api_url') + GourdI18n.t('common.required'), 'error');
            return;
        }

        var data = {
            name: name,
            standard: standard,
            apiUrl: apiUrl,
            apiKey: apiKey,
            scope: scope,
            timeout: normalizeTimeout(timeout),
            models: models,
            // 编辑模式沿用当前连接的启用状态，避免即时保存时把已禁用的连接误开启
            enabled: currentProvider ? currentProvider.enabled !== false : true
        };

        // 如果是编辑模式，添加 originalName
        if (currentProvider) {
            data.originalName = currentProvider.name;
        }

        var url = currentProvider ? '/web/settings/providers/update' : '/web/settings/providers/add';

        $.ajax({
            url: url,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(data),
            success: function (res) {
                if (res.code === 200) {
                    if (showSuccessToast) {
                        showToast(currentProvider ? GourdI18n.t('settings.loop.updated') : GourdI18n.t('settings.loop.created') + ' ' + GourdI18n.t('settings.providers.title') + GourdI18n.t('settings.providers.model_management'), 'success');
                    }
                    if (currentProvider) {
                        // 列表接口返回的 apiKey 是脱敏值，回填真实密钥，避免下次即时保存把脱敏值写进去
                        currentProvider.apiKey = apiKey;
                        // 先同步生成运行时模型，再重载 LLM 缓存重绘，保证已同步徽标/开关态与运行时一致
                        syncModelsToLlm(data, function () {
                            loadLlmModelsCache(function () {
                                renderModelsList();
                            });
                        }, !showSuccessToast);
                    } else {
                        syncModelsToLlm(data, null, !showSuccessToast);
                        showList();
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.save_failed'), 'error');
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.save_failed'), 'error');
            }
        });
    }

    // 保存按钮（新增模式使用；编辑模式隐藏该按钮，所有操作即时生效）
    function saveProvider() {
        persistProvider(true);
    }

    // 归一化超时输入：数字 -> "Ns"；已带 s 或空则原样返回
    function normalizeTimeout(t) {
        if (!t) return '';
        t = String(t).trim();
        if (/^\d+$/.test(t)) return t + 's';
        return t;
    }

    // silent=true 时不弹同步成功提示（编辑模式即时生效场景），仅手动保存时展示
    function syncModelsToLlm(providerData, onDone, silent) {
        // 调用后端接口同步模型
        $.ajax({
            url: '/web/settings/providers/sync-models',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                providerName: providerData.name,
                models: providerData.models || []
            }),
            success: function (res) {
                if (res.code === 200) {
                    if (!silent && res.data > 0) {
                        showToast(GourdI18n.t('settings.loop.updated') + ' ' + res.data + ' ' + GourdI18n.t('settings.providers.title') + GourdI18n.t('settings.providers.model_management'), 'success');
                    }
                    // 通知聊天组件刷新模型下拉列表（新增/更新/删除后都要刷新）
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                }
                if (onDone) onDone();
            },
            error: function () {
                if (onDone) onDone();
            }
        });
    }

    function deleteProvider() {
        if (!currentProvider) return;

        layConfirm(GourdI18n.t('settings.confirm_delete') + GourdI18n.t('settings.providers.add_title') + ' "' + currentProvider.name + '"？', function () {
            $.ajax({
                url: '/web/settings/providers/remove',
                method: 'POST',
                data: { name: currentProvider.name },
                success: function (res) {
                    if (res.code === 200) {
                        showToast(GourdI18n.t('settings.loop.deleted'), 'success');
                        showList();
                    } else {
                        showToast(res.msg || GourdI18n.t('settings.loop.delete_failed'), 'error');
                    }
                },
                error: function () {
                    showToast(GourdI18n.t('settings.loop.delete_failed'), 'error');
                }
            });
        });
    }

    function toggleProvider(name, enabled) {
        $.ajax({
            url: '/web/settings/providers/toggle',
            method: 'POST',
            data: { name: name, enabled: enabled },
            success: function (res) {
                if (res.code === 200) {
                    showToast(enabled ? GourdI18n.t('settings.loop.enable') : GourdI18n.t('settings.loop.disable'), 'success');
                    // 刷新连接列表 UI（更新 disabled 样式）
                    loadProvidersList();
                    // 通知聊天组件刷新模型下拉列表
                    if (typeof window.reloadModels === 'function') {
                        window.reloadModels();
                    }
                } else {
                    showToast(res.msg || GourdI18n.t('settings.loop.operation_failed'), 'error');
                    loadProvidersList();
                }
            },
            error: function () {
                showToast(GourdI18n.t('settings.loop.operation_failed'), 'error');
                loadProvidersList();
            }
        });
    }

    // ==================== 暴露全局接口 ====================
    window.settingsProviders = {
        init: init,
        loadList: loadProvidersList,
        showList: showList
    };

    // Provider API Key 显示切换
    $(document).on('click', '#providerApiKeyToggle', function () {
        var $input = $('#providerApiKey');
        if ($input.attr('type') === 'password') {
            $input.attr('type', 'text');
            $(this).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>');
        } else {
            $input.attr('type', 'password');
            $(this).html('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>');
        }
    });

    // 自动初始化
    $(document).ready(function () {
        init();
    });
})();
