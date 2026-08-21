/* ===== 上下文状态指示器（输入框上方居中） ===== */

/**
 * 数值格式化：大数转 k/m 简写
 */
function ctxFmtK(n) {
    if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + 'm';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return n.toString();
}

/**
 * 缓存命中率格式化（与 trace 行共用，避免两处精度口径漂移）。
 * <p>后端保留 2 位小数，展示层收敛到 1 位；不足 0.1% 时用 "<0.1%" 表达，
 * 避免四舍五入后出现无意义的 "0.0%"。</p>
 * @param {number} rate - 命中率百分比（0~100）
 * @returns {string} 形如 "87.3%" / "<0.1%"；无效或为 0 时返回空串
 */
function fmtCacheRate(rate) {
    if (typeof rate !== 'number' || !(rate > 0)) return '';
    if (rate < 0.1) return '<0.1%';
    return (Math.round(rate * 10) / 10).toFixed(1) + '%';
}

/**
 * 依据 context_size chunk 渲染指示器文案（纯函数，无副作用）
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 * @returns {string} 指示器文本
 */
function buildContextText(chunk) {
    var tokens = Math.round(chunk.totalTokens || 0);
    var contextLength = 0;
    if (chunk.args && chunk.args.contextLength) {
        contextLength = Math.round(chunk.args.contextLength);
    }
    var percent = contextLength > 0 ? Math.round(tokens / contextLength * 100) : 0;

    var text = GourdI18n.t('context.length', [ctxFmtK(tokens), ctxFmtK(contextLength), percent + '%']);

    // 缓存命中率：百分比自带分母，比绝对量更能直观反映「本轮输入有多大比例走了缓存」；
    // 绝对量同时保留，便于对照实际 token 规模。
    var cacheRead = Math.round(chunk.cacheReadTokens || 0);
    if (cacheRead > 0) {
        var seg = GourdI18n.t('context.cache') + ctxFmtK(cacheRead);
        var rateTxt = fmtCacheRate(chunk.cacheRate);
        if (rateTxt) seg += ' (' + rateTxt + ')';
        text += ' · ' + seg;
    }
    return text;
}

/**
 * 更新上下文状态 UI
 * @param {Object} chunk - type 为 context_size 的 WebChunk（真实用量：推理后依据模型 usage 生成）
 * @param {Object} [sess] - 所属会话；传入时把用量快照挂到会话上，切走再切回可原样恢复
 */
function updateContextIndicator(chunk, sess) {
    // 单调时间戳门禁：旧帧不得回退新帧。
    // 必要性——context_size 会落盘并参与历史回放，「加载更多」(prepend) 会重放更早的事件，
    // 若无此门禁，指示器会被历史早期的小数值覆盖，且错值会写进 sess.lastContextChunk 长期污染。
    if (sess && sess.lastContextChunk
            && (chunk.createdAt || 0) < (sess.lastContextChunk.createdAt || 0)) {
        return;
    }
    // 快照存到会话对象：切会话不再丢失缓存指标（指示器是全局单例 DOM，必须按会话回填）
    if (sess) sess.lastContextChunk = chunk;

    var $status = $('.context-status');
    if (!$status.length) return;

    $('.context-status-text').text(buildContextText(chunk));
    $status.show();
}

/**
 * 按会话恢复上下文状态指示器（切换会话时调用）。
 * <p>该会话有历史用量快照则原样回填，否则隐藏并置为占位文案。</p>
 * @param {Object} [sess] - 目标会话对象（缺省则仅做清空）
 */
function restoreContextIndicator(sess) {
    var $status = $('.context-status');
    if (!$status.length) return;

    if (sess && sess.lastContextChunk) {
        $('.context-status-text').text(buildContextText(sess.lastContextChunk));
        $status.show();
        return;
    }

    $status.hide();
    $('.context-status-text').text(GourdI18n.t('context.length', ['--', '--', '--']));
}

/**
 * 重置上下文状态指示器（无可恢复会话时的清空入口）
 */
function resetContextIndicator() {
    restoreContextIndicator(null);
}

/* 思考/等待指示器已迁回消息区（thinking-row / inline-thinking），由 app-message.js 统一管理。 */
