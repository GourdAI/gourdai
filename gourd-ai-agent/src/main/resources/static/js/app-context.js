/* ===== 上下文状态指示器（输入框上方居中） ===== */

/**
 * 更新上下文状态 UI
 * @param {Object} chunk - type 为 context_size 的 WebChunk（真实用量：推理后依据模型 usage 生成）
 */
function updateContextIndicator(chunk) {
    var $status = $('.context-status');
    if (!$status.length) return;

    var tokens = Math.round(chunk.totalTokens || 0);
    var contextLength = 0;
    if (chunk.args && chunk.args.contextLength) {
        contextLength = Math.round(chunk.args.contextLength);
    }
    var percent = contextLength > 0 ? Math.round(tokens / contextLength * 100) : 0;

    function fmtK(n) {
        if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + 'm';
        if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
        return n.toString();
    }

    var text = GourdI18n.t('context.length', [fmtK(tokens), fmtK(contextLength), percent + '%']);
    // 有缓存命中时补充展示缓存读取量，让"输入其实大部分走了缓存"一目了然
    var cacheRead = Math.round(chunk.cacheReadTokens || 0);
    if (cacheRead > 0) {
        text += ' · ' + GourdI18n.t('context.cache') + fmtK(cacheRead);
    }
    $('.context-status-text').text(text);
    $status.show();
}

/**
 * 重置上下文状态指示器（切换会话时调用）
 */
function resetContextIndicator() {
    var $status = $('.context-status');
    if ($status.length) {
        $status.hide();
        $('.context-status-text').text(GourdI18n.t('context.length', ['--', '--', '--']));
    }
}

/* 思考/等待指示器已迁回消息区（thinking-row / inline-thinking），由 app-message.js 统一管理。 */
