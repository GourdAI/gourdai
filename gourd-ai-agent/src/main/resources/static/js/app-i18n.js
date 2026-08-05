/* ===== app-i18n.js ===== */
/* 国际化模块：语言检测、切换、DOM 文本替换 */

(function () {
    'use strict';

    var LOCALE_KEY = 'gourd_ai_locale';
    var AVAILABLE_LOCALES = [
        { code: 'zh-CN', name: '中文', flag: '🇨🇳' },
        { code: 'zh-TW', name: '中文（繁体）', flag: '🇭🇰' },
        { code: 'en', name: 'English', flag: '🇺🇸' },
        { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
        { code: 'ja', name: '日本語', flag: '🇯🇵' },
        { code: 'ru', name: 'Русский', flag: '🇷🇺' },
        { code: 'el', name: 'Ελληνικά', flag: '🇬🇷' },
        { code: 'es', name: 'Español', flag: '🇪🇸' },
        { code: 'fr', name: 'Français', flag: '🇫🇷' },
        { code: 'pt', name: 'Português', flag: '🇵🇹' },
        { code: 'ro', name: 'Română', flag: '🇷🇴' },
        { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' }
    ];

    var currentLocale = null;
    var messages = {};
    var messagesLoaded = false;

    // 就绪回调队列：首个语言包加载完成后依次触发（只触发一次）。
    // 用于解决“顶层静态求值时语言包未就绪”的竞态：依赖国际化文案的
    // 初始渲染（欢迎语/思考档位等）应注册到这里，而非在脚本解析期直接求值。
    var readyCallbacks = [];
    var isReady = false;
    function fireReady() {
        if (isReady) return;
        isReady = true;
        var cbs = readyCallbacks.splice(0);
        for (var i = 0; i < cbs.length; i++) {
            try { cbs[i](); } catch (e) { console.error('[i18n] ready 回调异常', e); }
        }
    }
    // 注册语言包就绪回调；若已就绪则立即同步执行
    function whenReady(cb) {
        if (typeof cb !== 'function') return;
        if (isReady) { cb(); return; }
        readyCallbacks.push(cb);
    }

    // 检测浏览器语言
    function detectLocale() {
        var saved = localStorage.getItem(LOCALE_KEY);
        if (saved) {
            var found = AVAILABLE_LOCALES.find(function (l) { return l.code === saved; });
            if (found) return saved;
        }
        var navLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
        if (navLang.startsWith('zh-tw') || navLang.startsWith('zh-hk') || navLang.startsWith('zh-mo')) return 'zh-TW';
        if (navLang.startsWith('zh')) return 'zh-CN';
        if (navLang.startsWith('en')) return 'en';
        if (navLang.startsWith('de')) return 'de';
        if (navLang.startsWith('ja')) return 'ja';
        if (navLang.startsWith('ru')) return 'ru';
        if (navLang.startsWith('el')) return 'el';
        if (navLang.startsWith('es')) return 'es';
        if (navLang.startsWith('fr')) return 'fr';
        if (navLang.startsWith('pt')) return 'pt';
        if (navLang.startsWith('ro')) return 'ro';
        if (navLang.startsWith('vi')) return 'vi';
        return 'zh-CN';
    }

    // 加载语言包
    function loadMessages(locale) {
        if (messages[locale]) return Promise.resolve(messages[locale]);
        return fetch('/locales/' + locale + '.json')
            .then(function (resp) { return resp.json(); })
            .then(function (data) {
                messages[locale] = data;
                messagesLoaded = true;
                return data;
            })
            .catch(function () {
                if (locale !== 'zh-CN') {
                    return loadMessages('zh-CN');
                }
                messages[locale] = {};
                return {};
            });
    }

    // 从嵌套对象中取值，支持 a.b.c 格式
    function getMessage(key, locale) {
        var msgs = messages[locale || currentLocale] || {};
        var keys = key.split('.');
        var val = msgs;
        for (var i = 0; i < keys.length; i++) {
            if (val && typeof val === 'object') {
                val = val[keys[i]];
            } else {
                return key;
            }
        }
        return typeof val === 'string' ? val : key;
    }

    // 格式化消息，支持 {0} {1} 占位符
    function formatMessage(key, params) {
        var msg = getMessage(key);
        if (!params) return msg;
        if (Array.isArray(params)) {
            for (var i = 0; i < params.length; i++) {
                msg = msg.replace('{' + i + '}', params[i] !== undefined ? params[i] : '{' + i + '}');
            }
        } else if (typeof params === 'object') {
            for (var k in params) {
                msg = msg.replace(new RegExp('\\{' + k + '}', 'g'), params[k]);
            }
        }
        return msg;
    }

    // 翻译 DOM 中所有带 data-i18n 标记的元素
    function translateDOM() {
        if (!currentLocale || !messages[currentLocale]) return;

        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            var text = getMessage(key);
            if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search' || el.type === 'password')) {
                el.placeholder = text;
            } else if (el.tagName === 'TEXTAREA') {
                el.placeholder = text;
            } else if (el.tagName === 'OPTION') {
                el.textContent = text;
            } else {
                if (el.children.length === 0) {
                    el.textContent = text;
                } else {
                    var nodes = el.childNodes;
                    for (var i = 0; i < nodes.length; i++) {
                        if (nodes[i].nodeType === 3 && nodes[i].textContent.trim()) {
                            nodes[i].textContent = text + (nodes[i].textContent.slice(nodes[i].textContent.trim().length));
                            break;
                        }
                    }
                }
            }
            // 翻译完成后移除隐藏类
            el.classList.remove('i18n-hidden');
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-placeholder');
            el.placeholder = getMessage(key);
        });

        document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-title');
            el.title = getMessage(key);
        });

        document.dispatchEvent(new CustomEvent('i18n:localeChanged', { detail: { locale: currentLocale } }));
    }

    function init(options) {
        options = options || {};
        var locale = options.locale || detectLocale();
        setLocale(locale);
    }

    function setLocale(locale) {
        if (locale === currentLocale) {
            translateDOM();
            return;
        }
        currentLocale = locale;
        localStorage.setItem(LOCALE_KEY, locale);
        document.documentElement.setAttribute('lang', locale);
        document.documentElement.setAttribute('data-locale', locale);
        loadMessages(locale).then(function () {
            translateDOM();
            fireReady();   // 首个语言包就绪：触发注册的初始渲染回调
        });
    }

    function getLocale() {
        return currentLocale || detectLocale();
    }

    function getAvailableLocales() {
        return AVAILABLE_LOCALES;
    }

    function getCurrentLocaleName() {
        var loc = AVAILABLE_LOCALES.find(function (l) { return l.code === currentLocale; });
        return loc ? loc.name : currentLocale;
    }

    function getCurrentLocaleFlag() {
        var loc = AVAILABLE_LOCALES.find(function (l) { return l.code === currentLocale; });
        return loc ? loc.flag : '';
    }

    window.GourdI18n = {
        init: init,
        setLocale: setLocale,
        getLocale: getLocale,
        getMessage: getMessage,
        formatMessage: formatMessage,
        getAvailableLocales: getAvailableLocales,
        getCurrentLocaleName: getCurrentLocaleName,
        getCurrentLocaleFlag: getCurrentLocaleFlag,
        translateDOM: translateDOM,
        whenReady: whenReady,
        t: function (key, params) { return formatMessage(key, params); }
    };

    // 在 DOM 就绪后、语言包加载前，先隐藏所有带 data-i18n 的文本元素，避免闪屏
    function hideI18nTextBeforeReady() {
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            // 仅对有实际文本节点（非纯图标/按钮内文字 span）的元素隐藏
            if (el.children.length === 0 || el.childNodes.some(function (n) { return n.nodeType === 3 && n.textContent.trim(); })) {
                el.classList.add('i18n-hidden');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            if (!currentLocale) {
                hideI18nTextBeforeReady();
                init();
            }
        });
    } else {
        if (!currentLocale) {
            hideI18nTextBeforeReady();
            init();
        }
    }
})();