/* ===== app-base.js ===== */
/* DOM引用 + 状态 + 工具函数（最先加载，无依赖） */

/* ===== DOM ===== */
var welcomeView = document.getElementById('welcomeView');
var chatView = document.getElementById('chatView');
var messagesWrap = document.getElementById('messagesWrap');
var welcomeInput = document.getElementById('welcomeInput');
var welcomeSendBtn = document.getElementById('welcomeSendBtn');
var chatInput = document.getElementById('chatInput');
var chatSendBtn = document.getElementById('chatSendBtn');
var newChatBtn = document.getElementById('newChatBtn');
var historyList = document.getElementById('historyList');

/* ===== Constants ===== */
var DOTS_HTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';

/* ===== Per-Session State ===== */
function SessionState(sessionId) {
    this.sessionId = sessionId;
    this.container = $('<div>')[0];
    $(this.container).addClass('messages-inner');
    $(this.container).hide();
    $(messagesWrap).append(this.container);
    this.eventSource = null;
    this.isStreaming = false;
    this.currentBubbleEl = null;
    this.reasonBuffer = '';
    this.thinkingBlockEl = null;
    this.thinkingBodyMdEl = null;
    this.thinkingBodyWrapEl = null;
    this.thinkingBuffer = '';
    this.pendingToolCard = null;
    this.pendingToolStarted = false;
    this.approvedToolCard = null;
    this.thinkingEl = null;
    this.inlineThinkingEl = null;
    this.silenceTimer = null;
    this.contentRafId = null;
    this.reasonRafId = null;
    this.thinkingTimerId = null;
    this.thinkingStartTime = null;
    this.inlineThinkingTimerId = null;
    this.inlineThinkingStartTime = null;
    this.thinkingBlockTimerId = null;
    this.thinkingBlockStartTime = null;
    this.thinkingUserScrolledUp = false;  // 思考区用户主动向上滚动标记

    this.messageStartTime = null;
    this.userMsgCounter = 0;
}

var sessionMap = {};
var activeSessionId = null;

/* ===== Global State ===== */
/* 应用模式：'chat'（默认，会话存安装目录全局区）| 'code'（会话存所选项目） */
var appMode = 'chat';
window.appMode = appMode;
/* Code 模式当前所选项目根目录绝对路径（chat 模式为空） */
window.currentProjectRoot = '';

/* 生成新会话 ID：code 模式用 code- 前缀（落所选项目），否则 chat- 前缀（落全局） */
function newSessionId() {
    var prefix = (window.appMode === 'code') ? 'code-' : 'chat-';
    return prefix + Date.now().toString(36);
}
window.newSessionId = newSessionId;

/* Code 模式下，发送消息时随请求头带上的工作目录（重定向 AI 工具到所选项目）。
   chat 模式返回空串（后端使用默认工作区）。 */
function getSessionCwd() {
    return (window.appMode === 'code' && window.currentProjectRoot) ? window.currentProjectRoot : '';
}
window.getSessionCwd = getSessionCwd;

var SESSION_ID = newSessionId();
var isStreaming = false;
var inChatMode = false;
var chatHistory = [];
var currentChatIndex = -1;
var pendingFiles = [];
var MAX_ATTACHMENTS = 10;
var userScrolledUp = false;

var onFinishStream = null;

/* 控制台打印简化开关（与后端 cliPrintSimplified 对齐）。
   true：流式工具卡默认收起；false：默认展开。启动时由 /web/settings/general 回填。 */
var cliPrintSimplified = true;

/* ===== Session Helpers ===== */
function getOrCreateSession(sessionId) {
    if (!sessionMap[sessionId]) {
        sessionMap[sessionId] = new SessionState(sessionId);
    }
    return sessionMap[sessionId];
}

function setActiveSession(sessionId) {
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
    }
    var sess = getOrCreateSession(sessionId);
    $(sess.container).show();
    activeSessionId = sessionId;
    SESSION_ID = sessionId;
    isStreaming = sess.isStreaming;
    userScrolledUp = false;
    if (isStreaming) setBtnStopMode();
    else setBtnSendMode();
    // 清除 messagesWrap 中所有残留的加载按钮（按钮是 messagesWrap 直接子元素，不属于 sess.container，
    // 切会话时不会被 hide，需主动清除；后续 updateLoadMoreBtn 按需重建当前会话的按钮）
    $(messagesWrap).find('.chat-load-more-wrapper').remove();
    // 仅当 sessionId 前缀与当前模式匹配时才刷新模型选择器，避免 code 模式切标签时误建 chat- 目录
    if (typeof modelsLoaded !== 'undefined' && modelsLoaded) {
        var prefix = (window.appMode === 'code') ? 'code-' : 'chat-';
        if (sessionId && sessionId.indexOf(prefix) === 0) {
            refreshSessionModel(sessionId);
        }
    }
    if (typeof resetContextIndicator === 'function') resetContextIndicator();
}

function deactivateSession() {
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
    }
    activeSessionId = null;
    isStreaming = false;
    setBtnSendMode();
}

/* ===== Helpers ===== */
$(messagesWrap).on('scroll', function() {
    var gap = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight;
    userScrolledUp = gap > 80;
});
var scrollRafPending = false;
function scrollToBottom(force) {
    if (!force && userScrolledUp) return;
    if (force) userScrolledUp = false;
    // 滚动与内容更新在同一次 rAF 内执行，避免跨帧跳动
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(function() {
        // 若当前帧内有多次滚动调用，确保最终落在最底部
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
        // 再等下一帧确认高度稳定后再次修正（始终执行，确保最终落在最底部）
        requestAnimationFrame(function() {
            scrollRafPending = false;
            messagesWrap.scrollTop = messagesWrap.scrollHeight;
        });
    });
}

function resetStreamState(sess) {
    sess.currentBubbleEl = null;
    sess.pendingToolStarted = false;
    sess.reasonBuffer = '';
        sess.thinkingBlockEl = null;
        sess.thinkingBodyMdEl = null;
        sess.thinkingBodyWrapEl = null;
        sess.thinkingBuffer = '';
        sess.thinkingUserScrolledUp = false;
    if (sess.contentRafId) { cancelAnimationFrame(sess.contentRafId); sess.contentRafId = null; }
    if (sess.reasonRafId) { cancelAnimationFrame(sess.reasonRafId); sess.reasonRafId = null; }
    // 取消可能正在进行的回放分片（切换会话时清理）
    if (sess._replayRafId) { cancelAnimationFrame(sess._replayRafId); sess._replayRafId = null; }
    // 清除智能体输出标记
    if (typeof clearAgentState === 'function') clearAgentState(sess);
    else {
        sess._agentBodyMd = null;
        sess._agentBodyText = '';
        if (sess._agentBodyRafId) { cancelAnimationFrame(sess._agentBodyRafId); sess._agentBodyRafId = null; }
    }
}

function setBtnStopMode() {
    chatSendBtn.disabled = false;
    $(chatSendBtn).addClass('stop-mode');
    $(chatSendBtn).html('<div class="stop-icon"></div>');
    chatSendBtn.title = GourdI18n.t('base.stop_generating');
}
function setBtnSendMode() {
    $(chatSendBtn).removeClass('stop-mode');
    $(chatSendBtn).html('<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>');
    chatSendBtn.title = GourdI18n.t('base.send');
    chatSendBtn.disabled = false;
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function escapeHtml(str) {
    var div = $('<div>')[0];
    $(div).text(str);
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatMsgTime(ts) {
    if (!ts) return '';
    var d = new Date(typeof ts === 'number' ? ts : parseInt(ts));
    if (isNaN(d.getTime())) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    if (sameDay) return hh + ':' + mm;
    var yyyy = d.getFullYear();
    var MM = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + MM + '-' + dd + ' ' + hh + ':' + mm;
}

function getInputText() {
    if (inChatMode) return chatInput.value.trim();
    return welcomeInput.value.trim();
}
function clearInput() {
    if (inChatMode) { chatInput.value = ''; chatInput.style.height = 'auto'; }
    else { welcomeInput.value = ''; welcomeInput.style.height = 'auto'; }
}

/* ===== Toast Notification ===== */
var toastContainer = null;
function showToast(message, type, duration) {
    if (!toastContainer) {
        toastContainer = $('<div>')[0];
        $(toastContainer).addClass('toast-container');
        $('body').append(toastContainer);
    }
    var item = $('<div>')[0];
    $(item).addClass('toast-item ' + (type || 'info'));
    var icons = { success: '\u2714', error: '\u2716', info: '\u2139' };
    $(item).html('<span>' + (icons[type] || icons.info) + '</span><span>' + escapeHtml(message) + '</span>');
    $(toastContainer).append(item);
    setTimeout(function() {
        $(item).addClass('leaving');
        setTimeout(function() {
            if (item.parentNode) $(item).remove();
        }, 250);
    }, duration || 3000);
}

/* ===== Network Status Bar ===== */
var networkBar = null;
function showNetworkBar(type, message) {
    if (!networkBar) {
        networkBar = $('<div>')[0];
        $(networkBar).addClass('network-bar');
        $('body').append(networkBar);
    }
    $(networkBar).attr('class', 'network-bar show ' + type);
    $(networkBar).text(message);
}
function hideNetworkBar() {
    if (networkBar) {
        $(networkBar).attr('class', 'network-bar');
    }
}

/* ===== Layer Dialog Helpers ===== */
/* 统一用 layui layer 替代原生 confirm/alert，自动跟随主题 */
function layConfirm(msg, yesFn) {
    var html = '<div class="kd-confirm">'
        + '<div class="kd-confirm-msg">' + escapeHtml(msg) + '</div>'
        + '<div class="kd-confirm-btns">'
         + '<button class="kd-btn kd-btn-cancel">' + GourdI18n.t('base.cancel') + '</button>'
         + '<button class="kd-btn kd-btn-ok">' + GourdI18n.t('base.confirm') + '</button>'
        + '</div></div>';
    var idx = layer.open({
        type: 1,
        content: html,
        title: false,
        closeBtn: 0,
        shade: 0.3,
        shadeClose: false,
        skin: 'kd-layer',
        area: 'auto',
        success: function(layero) {
            layero.find('.kd-btn-ok').on('click', function() {
                layer.close(idx);
                yesFn();
            });
            layero.find('.kd-btn-cancel').on('click', function() {
                layer.close(idx);
            });
        }
    });
}

function layAlert(msg) {
    layer.msg(msg, { icon: 2, time: 3000, skin: 'kd-layer-msg' });
}
