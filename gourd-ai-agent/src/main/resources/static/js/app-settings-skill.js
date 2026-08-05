/**
 * app-settings-skill.js — 技能市场交互逻辑（所有 API 调用均走后端代理）
 *
 * 依赖：layui.js（jQuery）、app-base.js、app-i18n.js（GourdI18n）
 * 协同：app-history.js（commandList / loadCommands）
 *
 * 后端接口：
 *   GET  /web/settings/skills/markets                     — 获取可用市场列表
 *   GET  /web/settings/skills/proxy?action=trending       — 热门技能列表
 *   GET  /web/settings/skills/proxy?action=search&q=xxx   — 搜索技能
 *   POST /web/settings/skills/install  {slug, marketName, mountAlias}  — 安装技能
 */

(function () {
    'use strict';

    // ==================== 常量 ====================

    var SKILLS_API_BASE = '/web/settings/skills/proxy';

    // ==================== DOM 引用 ====================

    var $skillsMarketSelect = $('#skillsMarketSelect');
    var $skillsSearchInput = $('#skillsSearchInput');
    var $skillsSearchClear = $('#skillsSearchClear');
    var $skillsList = $('#skillsList');
    var $skillsLoading = $('#skillsLoading');
    var $skillsError = $('#skillsError');
    var $skillsStatus = $('#skillsStatus');

    // ==================== 状态 ====================

    var _installedSkillsCache = null;
    var _currentMarketName = '';  // 当前选中的市场名称
    var _mountPoolsCache = null;  // SKILLS 类型挂载缓存 [{alias, path}, ...]
    var _currentQuery = null;     // 当前搜索关键词
    var _currentPage = 1;         // 当前页码
    var _pageLimit = 20;         // 每页条数
    var _hasMore = true;          // 是否还有更多数据
    var _isLoadingMore = false;   // 是否正在加载更多

    // ==================== 工具函数 ====================

    /** HTML 转义（与 app-settings.js 共享同一个闭包作用域不可用，自备一份） */
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ==================== 挂载预加载 ====================

    /** 加载 SKILLS 类型挂载列表（带缓存） */
    function loadMountPools(callback) {
        if (_mountPoolsCache) {
            callback(_mountPoolsCache);
            return;
        }
        $.ajax({
            url: '/web/settings/mounts',
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            var pools = (resp && resp.code === 200 && resp.data) ? resp.data : [];
            _mountPoolsCache = pools.filter(function (p) {
                return p.type === 'SKILLS' || !p.type;
            }).map(function (p) {
                return { alias: p.alias || '', path: p.path || '' };
            });
            if (!_mountPoolsCache.length) {
                _mountPoolsCache = [{ alias: '@skills', path: '' }];
            }
            callback(_mountPoolsCache);
        }).fail(function () {
            _mountPoolsCache = [{ alias: '@skills', path: '' }];
            callback(_mountPoolsCache);
        });
    }

    // ==================== 市场选择器初始化 ====================

    /**
     * 从后端加载可用市场列表并填充下拉框
     */
    function loadMarketOptions() {
        $.ajax({
            url: '/web/settings/skills/markets',
            method: 'GET',
            timeout: 5000,
            dataType: 'json'
        }).done(function (resp) {
            var markets = (resp && resp.data) ? resp.data : [];
            if (!markets.length) return;

            var html = '';
            markets.forEach(function (m) {
                var label = escapeHtml(m.name || '');
                html += '<option value="' + escapeAttr(m.name || '') + '">' + label + '</option>';
            });
            $skillsMarketSelect.html(html);

            // 默认选中第一个
            _currentMarketName = markets[0].name || '';
            $skillsMarketSelect.val(_currentMarketName);

            // 渲染 layui 表单
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        }).fail(function () {
            $skillsMarketSelect.html('<option value="">ClawHub</option>');
            _currentMarketName = '';

            // 渲染 layui 表单
            if (typeof layui !== 'undefined' && layui.form) {
                layui.form.render('select');
            }
        });
    }


    // ==================== 已安装技能 ====================

    function getInstalledSkills(callback) {
        if (typeof commandList !== 'undefined' && commandList.length > 0) {
            if (!_installedSkillsCache) {
                _installedSkillsCache = {};
                commandList.forEach(function (item) {
                    if (item.type === 'skill') _installedSkillsCache[item.name] = true;
                });
            }
            callback(_installedSkillsCache);
            return;
        }
        $.get('/web/chat/hints', function (resp) {
            _installedSkillsCache = {};
            (resp.data || []).forEach(function (item) {
                if (item.type === 'skill') _installedSkillsCache[item.name] = true;
            });
            callback(_installedSkillsCache);
        }).fail(function () {
            _installedSkillsCache = {};
            callback(_installedSkillsCache);
        });
    }

    // ==================== 数据加载 ====================

    /** 在列表末尾追加"加载更多"按钮（先移除已有按钮，避免重复或残留在列表中间） */
    function appendLoadMoreButton() {
        $('#skillsLoadMore').remove();
        $skillsList.append('<div id="skillsLoadMore" style="text-align:center;padding:16px;"><button class="skill-load-more-btn" style="background:var(--accent);color:#fff;border:none;padding:6px 20px;border-radius:6px;cursor:pointer;font-size:13px;">' + GourdI18n.t('settings.skills.load_more') + '</button></div>');
    }

    /**
     * 加载技能列表
     * @param {string|null} query - 搜索关键词，null 时加载热门技能
     * @param {boolean} append  - 是否追加到现有列表（true=加载更多，false=重置）
     */
    function loadSkillsList(query, append) {
        var isAppend = append === true;
        if (!isAppend) {
            _currentPage = 1;
            _hasMore = true;
            $skillsList.empty();  // 清空列表（含可能残留的"加载更多"按钮）
        }

        if (_isLoadingMore) return; // 防止重复请求
        _isLoadingMore = true;

        if (isAppend) {
            // 先移除旧的"加载更多"按钮，避免追加新内容后旧按钮残留在列表中间
            $('#skillsLoadMore').remove();
            $skillsList.append('<div class="skill-loading-more" style="text-align:center;padding:16px;color:var(--text-secondary);">' + GourdI18n.t('settings.skills.loading') + '</div>');
        } else {
            $skillsStatus.show();
            $skillsLoading.css('display', 'flex');
            $skillsError.hide();
        }

        var url;
        var marketParam = _currentMarketName ? '&marketName=' + encodeURIComponent(_currentMarketName) : '';
        if (query) {
            url = SKILLS_API_BASE + '?action=search&q=' + encodeURIComponent(query) + '&limit=' + _pageLimit + '&page=' + _currentPage + marketParam;
        } else {
            url = SKILLS_API_BASE + '?action=trending&limit=' + _pageLimit + '&page=' + _currentPage + marketParam;
        }

        $.ajax({
            url: url,
            method: 'GET',
            timeout: 15000,
            dataType: 'json'
        })
            .done(function (resp) {
                // 后端返回 Result 包装：{code:200, data:[...], description:""}
                // code !== 200 时为业务错误，展示后端返回的具体提示
                if (resp && resp.code !== undefined && resp.code !== 200) {
                    $skillsLoading.hide();
                    $('.skill-loading-more').remove();
                    var errMsg = (resp.description || GourdI18n.t('settings.save_failed') + GourdI18n.t('app.loading'));
                    $skillsError.text(errMsg).show();
                    if (isAppend && _hasMore) appendLoadMoreButton(); // 失败时恢复按钮便于重试
                    _isLoadingMore = false;
                    return;
                }

                var payload = resp;
                if (resp && resp.code !== undefined && resp.data !== undefined) {
                    payload = resp.data;
                }

                // 后端 Market 适配器已统一返回 MarketItem 列表
                var skills = [];
                if (Array.isArray(payload)) {
                    skills = payload;
                }

                _hasMore = skills.length >= _pageLimit;

                getInstalledSkills(function (installedMap) {
                    try {
                        renderSkillsList(skills, installedMap, isAppend);

                        // 移除"加载中"提示
                        $('.skill-loading-more').remove();
                        if (!isAppend) {
                            $skillsStatus.hide();
                        }

                        // 如果还有更多数据，显示"加载更多"按钮
                        if (_hasMore && skills.length > 0) {
                            appendLoadMoreButton();
                        }
                    } finally {
                        _isLoadingMore = false;  // 无论渲染是否异常，必须释放锁
                    }
                });
            })
            .fail(function (jqXHR, textStatus) {
                $('.skill-loading-more').remove();
                if (!isAppend) $skillsLoading.hide();
                if (isAppend && _hasMore) appendLoadMoreButton(); // 失败时恢复按钮便于重试
                var msg;
                if (textStatus === 'timeout') {
                    msg = GourdI18n.t('settings.network_error');
                } else if (jqXHR.status === 0) {
                    msg = GourdI18n.t('settings.network_error');
                } else if (jqXHR.status === 429) {
                    msg = GourdI18n.t('settings.operation_failed');
                } else if (jqXHR.status >= 500) {
                    msg = GourdI18n.t('settings.operation_failed') + '（HTTP ' + jqXHR.status + '）';
                } else {
                    msg = GourdI18n.t('settings.network_error') + '（HTTP ' + (jqXHR.status || '?') + '）';
                }
                $skillsError.text(msg).show();
                _isLoadingMore = false;
            });
    }

    // ==================== 渲染 ====================

    function renderSkillsList(skills, installedMap, append) {
        if (!skills || skills.length === 0) {
            if (!append) {
                $skillsList.html(
                    '<div class="skill-empty-state">'
                    + '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="1.5">'
                    + '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
                    + '</svg>'
                    + '<div style="font-size:13px;margin-top:12px;">' + GourdI18n.t('common.no_data') + '</div>'
                    + '</div>'
                );
            }
            return;
        }
        
        var html = '';
        var tInstalled = GourdI18n.t('settings.skills.installed');
        var tInstall = GourdI18n.t('settings.skills.install');
        var tLoading = GourdI18n.t('settings.skills.loading');
        skills.forEach(function (skill) {
            var name = skill.slug || skill.name || '';
            var displayName = skill.displayName || name;
            var desc = skill.summary || skill.description || '';
            var owner = skill.ownerHandle || (skill.owner && skill.owner.handle) || '';

            var installs = skill.installs || (skill.stats && skill.stats.installsCurrent) || 0;
            var stars = skill.stars || (skill.stats && skill.stats.stars) || 0;
            var isInstalled = !!installedMap[name];
            var iconText = displayName ? displayName.substring(0, 2).toUpperCase() : 'SK';
            var shortDesc = desc && desc.length > 60 ? desc.substring(0, 60) + '...' : desc;

            var skillUrl = skill.url || '';
                
            html += '<div class="skill-item" data-url="' + escapeAttr(skillUrl) + '">' 
                + '<div class="skill-item-icon">' + escapeHtml(iconText) + '</div>' 
                + '<div class="skill-item-info">' 
                + '<div class="skill-item-name" title="' + escapeAttr(name) + '">' + escapeHtml(displayName) + (isInstalled ? '<span class="skill-installed-badge">' + tInstalled + '</span>' : '') + '</div>' 
                + (shortDesc ? '<div class="skill-item-desc" title="' + escapeAttr(desc) + '">' + escapeHtml(shortDesc) + '</div>' : '') 
                + '<div class="skill-item-meta">' 
                + (installs > 0 ? '<span>' + (installs >= 1000 ? (installs / 1000).toFixed(1) + 'k' : installs) + ' ' + tInstall + '</span>' : '') 
                + (stars > 0 ? '<span>⭐ ' + (stars >= 1000 ? (stars / 1000).toFixed(1) + 'k' : stars) + '</span>' : '') 
                + (owner ? '<span>' + escapeHtml(owner) + '</span>' : '') 
                + (skillUrl ? '<span class="skill-item-detail-link" title="' + GourdI18n.t('settings.skills.detail') + '">↗</span>' : '') 
                + '</div></div>' 
                + '<div class="skill-item-actions">' 
                + (isInstalled
                    ? ''
                    : '<div class="skill-install-wrap">'
                    +   '<button class="skill-install-btn" data-slug="' + escapeAttr(name) + '" data-display="' + escapeAttr(displayName) + '" data-market="' + escapeAttr(_currentMarketName) + '" title="' + tInstall + '"><svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>'
                    +   '<div class="skill-install-dropdown" data-slug="' + escapeAttr(name) + '" data-display="' + escapeAttr(displayName) + '" data-market="' + escapeAttr(_currentMarketName) + '">' 
                    +     '<div class="skill-install-dropdown-loading">' + tLoading + '</div>' 
                    +   '</div>' 
                    + '</div>')
                + '</div></div>';
        });
    
        if (append) {
            $skillsList.append(html);
        } else {
            $skillsList.html(html);
        }
    }

    // ==================== 事件绑定 ====================

    // 市场切换 - 同时支持原生和 layui 事件
    $skillsMarketSelect.on('change', function () {
        _currentMarketName = $(this).val() || '';
        _installedSkillsCache = null;
        _currentPage = 1;
        _hasMore = true;
        loadSkillsList(null, false);
    });

    // layui 表单监听
    if (typeof layui !== 'undefined' && layui.form) {
        layui.form.on('select(skillsMarketSelect)', function(data) {
            _currentMarketName = data.value || '';
            _installedSkillsCache = null;
            _currentPage = 1;
            _hasMore = true;
            loadSkillsList(null, false);
        });
    }

    // 下拉菜单延时关闭管理（防止鼠标在按钮和下拉之间移动时闪烁）
    var _dropdownCloseTimer = null;

    function openDropdown($wrap) {
        clearTimeout(_dropdownCloseTimer);
        var $dropdown = $wrap.find('.skill-install-dropdown');
        // 已有选项直接显示
        if ($dropdown.find('.skill-install-mount-option').length) {
            $dropdown.addClass('active');
            return;
        }
        loadMountPools(function (pools) {
            var html = '';
            pools.forEach(function (p) {
                html += '<div class="skill-install-mount-option" data-alias="' + escapeAttr(p.alias) + '">'
                    + escapeHtml(p.alias)
                    + '</div>';
            });
            $dropdown.html(html).addClass('active');
        });
    }

    function closeDropdown($wrap) {
        clearTimeout(_dropdownCloseTimer);
        _dropdownCloseTimer = setTimeout(function () {
            $wrap.find('.skill-install-dropdown').removeClass('active');
        }, 150);
    }

    // 鼠标进入按钮区域 → 打开下拉
    $skillsList.on('mouseenter', '.skill-install-wrap', function () {
        openDropdown($(this));
    });

    // 鼠标进入下拉菜单本身 → 取消关闭
    $skillsList.on('mouseenter', '.skill-install-dropdown', function () {
        clearTimeout(_dropdownCloseTimer);
    });

    // 鼠标离开整个 wrap 区域 → 延时关闭下拉
    $skillsList.on('mouseleave', '.skill-install-wrap', function () {
        closeDropdown($(this));
    });

    // 触屏设备降级：点击按钮切换下拉
    $skillsList.on('click', '.skill-install-btn:not(.installed)', function (e) {
        e.stopPropagation();
        var $wrap = $(this).closest('.skill-install-wrap');
        var $dropdown = $wrap.find('.skill-install-dropdown');
        // 关闭其他下拉
        $('.skill-install-dropdown').not($dropdown).removeClass('active');
        // 如果还没填充过选项，先填充
        if (!$dropdown.find('.skill-install-mount-option').length) {
            loadMountPools(function (pools) {
                var html = '';
                pools.forEach(function (p) {
                    html += '<div class="skill-install-mount-option" data-alias="' + escapeAttr(p.alias) + '">'
                        + escapeHtml(p.alias)
                        + '</div>';
                });
                $dropdown.html(html).toggleClass('active');
            });
        } else {
            $dropdown.toggleClass('active');
        }
    });

    // 点击挂载选项，执行安装
    $skillsList.on('click', '.skill-install-mount-option', function (e) {
        e.stopPropagation();
        var $option = $(this);
        var $dropdown = $option.closest('.skill-install-dropdown');
        var slug = $dropdown.attr('data-slug');
        var displayName = $dropdown.attr('data-display') || slug;
        var marketUrl = $dropdown.attr('data-market') || '';
        var mountAlias = $option.attr('data-alias');

        var $btn = $dropdown.closest('.skill-install-wrap').find('.skill-install-btn');

        // 开始安装
        $btn.addClass('installing').html('<svg class="skill-install-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>').prop('disabled', true);
        $dropdown.removeClass('active');

        var postData = { slug: slug, mountAlias: mountAlias };
        if (marketUrl) postData.marketName = marketUrl;

        $.ajax({
            url: '/web/settings/skills/install',
            method: 'POST',
            data: postData,
            timeout: 60000,
            dataType: 'json'
        })
        .done(function (resp) {
            var isSuccess = resp && resp.code === 200 && resp.data;
            if (isSuccess) {
                var skillName = (resp.data || slug) + '';
                var $item = $btn.closest('.skill-item');
                var $nameEl = $item.find('.skill-item-name');
                if (!$nameEl.find('.skill-installed-badge').length) {
                    $nameEl.append('<span class="skill-installed-badge">' + GourdI18n.t('settings.skills.installed') + '</span>');
                }
                $btn.closest('.skill-install-wrap').remove();
                if (!_installedSkillsCache) _installedSkillsCache = {};
                _installedSkillsCache[slug] = true;
                if (typeof loadCommands === 'function') loadCommands();
                if (typeof window.showToast === 'function') {
                    window.showToast(GourdI18n.t('app.skills') + '「' + escapeHtml(skillName) + '」' + GourdI18n.t('settings.loop.created') + '！', 'success');
                }
            } else {
                var msg = (resp && resp.description) ? resp.description : GourdI18n.t('settings.loop.create_failed') + '，' + GourdI18n.t('settings.skills.loading');
                $btn.removeClass('installing').html('<svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>').prop('disabled', false);
                if (typeof window.showToast === 'function') window.showToast(msg, 'error');
            }
        })
        .fail(function (jqXHR) {
            $btn.removeClass('installing').html('<svg class="skill-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>').prop('disabled', false);
            var msg = GourdI18n.t('settings.loop.create_failed') + '，' + GourdI18n.t('settings.skills.loading');
            try {
                var err = JSON.parse(jqXHR.responseText);
                if (err && err.description) msg = err.description;
                else if (err && err.data) msg = err.data;
            } catch (e) {
                if (jqXHR.status) msg = GourdI18n.t('settings.loop.create_failed') + ' (HTTP ' + jqXHR.status + ')';
            }
            if (typeof window.showToast === 'function') window.showToast(msg, 'error');
        });
    });

    // 点击页面其他区域关闭所有下拉
    $(document).on('click', function () {
        $('.skill-install-dropdown').removeClass('active');
    });

    // 点击技能行打开详情页（新窗口）
    $skillsList.on('click', '.skill-item', function () {
        var url = $(this).attr('data-url');
        if (url) {
            window.open(url, '_blank');
        }
    });

    // 搜索输入（按回车键搜索）
    $skillsSearchInput.on('input', function () {
        var val = $(this).val().trim();
        $skillsSearchClear.toggle(val.length > 0);
    }).on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            var val = $(this).val().trim();
            _currentQuery = val || null;
            loadSkillsList(_currentQuery, false);
        }
    });

    // 清除搜索
    $skillsSearchClear.on('click', function () {
        $skillsSearchInput.val('').focus();
        $(this).hide();
        _currentQuery = null;
        loadSkillsList(null, false);
    });

    // 加载更多按钮（事件委托）
    $skillsList.on('click', '#skillsLoadMore .skill-load-more-btn', function (e) {
        e.stopPropagation();
        _currentPage++;
        loadSkillsList(_currentQuery, true);
    });

    // ==================== 暴露给外部调用的接口 ====================

    // 供 app-settings.js Tab 切换和面板初始化时调用
    window._skillModule = {
        /** 重置缓存并加载技能列表 */
        resetAndLoad: function () {
            _installedSkillsCache = null;
            _mountPoolsCache = null;
            _currentPage = 1;
            _currentQuery = null;
            _hasMore = true;
            _isLoadingMore = false;  // 重置加载锁，避免上次的锁残留导致无法重新加载
            loadMountPools(function(){});
            loadMarketOptions();
            loadSkillsList(null, false);
        }
    };

})();