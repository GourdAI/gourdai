package com.gourdai.core.portal.web;

import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.ChatConfig;
import org.noear.solon.ai.chat.ChatOptions;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.llm.dialect.gemini.GeminiChatDialect;

import java.util.List;
import java.util.Map;

/**
 * Gemini（generateContent）方言补丁：修复上游丢弃思考配置的问题。
 *
 * <p>solon-ai 的 {@code GeminiRequestBuilder.toGenerationConfig} 只拷贝 temperature/topP/maxOutputTokens，
 * 会把 {@code generationConfig.thinkingConfig}（thinkingLevel / thinkingBudget）静默丢弃，
 * 导致 Gemini 的思考深度无法生效。本类继承内置 {@link GeminiChatDialect}，
 * 在其构建出的请求体上把 thinkingConfig 原样补回去（本项目用 thinkingLevel，Gemini 3.x）。</p>
 *
 * <p>通过 {@code ChatDialectManager.register(this, 负数)} 以更高优先级注册，使其在内置 Gemini 方言之前匹配
 * （匹配逻辑沿用父类 {@code matched}：standard 为 gemini / gemini-models）。仅当选项里带了 thinkingConfig 时才改写，
 * 不影响其它 Gemini 请求。</p>
 *
 * @author oisin
 */
public class GeminiThinkingChatDialect extends GeminiChatDialect {

    @Override
    public ONode buildRequestJson(ChatConfig config, ChatOptions options, List<ChatMessage> messages, boolean isStream) {
        ONode root = super.buildRequestJson(config, options, messages, isStream);

        Object gcOpt = options.option("generationConfig");
        if (gcOpt instanceof Map) {
            Object tcOpt = ((Map<?, ?>) gcOpt).get("thinkingConfig");
            if (tcOpt instanceof Map) {
                // 补回被上游丢弃的 thinkingConfig（getOrNew 兼容 generationConfig 已存在/不存在两种情况）
                root.getOrNew("generationConfig").set("thinkingConfig", ONode.ofBean(tcOpt));
            }
        }

        return root;
    }
}
