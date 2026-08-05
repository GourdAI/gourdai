package com.gourdai.core.portal.web;

import org.noear.solon.ai.chat.ModelOptionsAmend;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 思考深度（推理力度）——<b>按接口类型各自的档位</b>注入，不是一套统一档位。
 *
 * <p>各接口的入口参数与取值天生不同，这里按模型的 <b>接口类型（standard）</b> 分别处理，
 * 前端也按接口展示对应的那一组档位（见 app-history.js 的 THINKING_PROFILES，与本类保持同步）：</p>
 * <ul>
 *   <li><b>openai</b>（Chat Completions）: {@code reasoning_effort} = minimal/low/medium/high（顶层透传，4 档）</li>
 *   <li><b>openai-responses</b>（Responses）: {@code reasoning.effort} = minimal/low/medium/high（4 档）</li>
 *   <li><b>gemini</b>（3.x generateContent）: {@code generationConfig.thinkingConfig.thinkingLevel} = MINIMAL/LOW/MEDIUM/HIGH（4 档）</li>
 *   <li><b>anthropic</b>（Messages）: {@code thinking.budget_tokens}（数值，3 档 low/medium/high）——
 *       solon-ai 的 Anthropic dialect 原生只拼 budget_tokens，故这一路用数值预算而非 effort 字符串。</li>
 *   <li>ollama 及其它: 与 openai 一样按 {@code reasoning_effort} 顶层透传</li>
 * </ul>
 *
 * <p>空值 / "off" 表示不注入任何思考参数（用模型默认行为）。前端发来的就是各接口对应的原始档位值，
 * 后端只负责按 standard 包成对应的请求参数形状，并在切换/关闭时清理旧键（幂等）。</p>
 *
 * @author oisin
 */
public final class ThinkingDepth {
    private ThinkingDepth() {
    }

    /** 关闭档位的编码。 */
    public static final String OFF = "off";

    /**
     * Anthropic 是否使用「现代」格式（adaptive thinking + output_config.effort）。
     * <p>true（默认）：发 {@code thinking:{type:"adaptive"}} + {@code output_config:{effort:...}}，
     * 适配现代官方 Claude（Opus 4.6+/Sonnet 4.6+/Sonnet 5/Fable 5）——这些模型已废弃 budget_tokens，传了会 400。
     * solon-ai 的 Anthropic dialect 虽只特判老的 budget_tokens，但 adaptive 的 type 它照样透传、
     * output_config 作为未知键也整体透传，故现代格式无需改 dialect 即可生效。</p>
     * <p>false：回退老格式 {@code thinking:{type:"enabled", budget_tokens:N}}，用于只认老接口的中转/旧版 Claude。</p>
     */
    private static final boolean ANTHROPIC_USE_EFFORT = true;

    /** effort 系（openai / openai-responses）合法档位。 */
    private static final java.util.Set<String> EFFORT_LEVELS =
            new java.util.LinkedHashSet<>(java.util.Arrays.asList("minimal", "low", "medium", "high"));

    /** Gemini thinkingLevel 合法档位（小写存储，注入时转大写）。 */
    private static final java.util.Set<String> GEMINI_LEVELS =
            new java.util.LinkedHashSet<>(java.util.Arrays.asList("minimal", "low", "medium", "high"));

    /** Anthropic 现代 effort 合法档位（output_config.effort）。 */
    private static final java.util.Set<String> ANTHROPIC_EFFORT_LEVELS =
            new java.util.LinkedHashSet<>(java.util.Arrays.asList("low", "medium", "high", "xhigh", "max"));

    /** Anthropic 老格式 budget_tokens 档位 → 预算（需 < max_tokens，dialect 默认 max_tokens=32000）。 */
    private static final Map<String, Integer> ANTHROPIC_BUDGETS = new LinkedHashMap<>();

    static {
        ANTHROPIC_BUDGETS.put("low", 4000);
        ANTHROPIC_BUDGETS.put("medium", 12000);
        ANTHROPIC_BUDGETS.put("high", 24000);
    }

    /** 当前 Anthropic 合法档位集（随模式切换）。 */
    private static java.util.Set<String> anthropicLevels() {
        return ANTHROPIC_USE_EFFORT ? ANTHROPIC_EFFORT_LEVELS : ANTHROPIC_BUDGETS.keySet();
    }

    /** 规范化 standard 到小写；null → 空串。 */
    private static String std(String standard) {
        return standard == null ? "" : standard.trim().toLowerCase();
    }

    /** 规范化档位编码：null/空/不识别 → OFF；否则小写。 */
    public static String normalize(String depth) {
        if (depth == null) {
            return OFF;
        }
        String d = depth.trim().toLowerCase();
        return d.isEmpty() ? OFF : d;
    }

    /**
     * 校验某档位在指定接口下是否有效；无效（含 OFF）返回 false。
     * 供 select 端点回显规范化用——切到不支持该值的接口时前端会显示为关闭。
     */
    public static boolean isValidFor(String standard, String depth) {
        String d = normalize(depth);
        if (OFF.equals(d)) {
            return false;
        }
        String s = std(standard);
        if (s.contains("anthropic") || s.contains("claude")) {
            return anthropicLevels().contains(d);
        }
        if (s.contains("gemini") || s.contains("google")) {
            return GEMINI_LEVELS.contains(d);
        }
        // openai / openai-responses / ollama / 其它 effort 系
        return EFFORT_LEVELS.contains(d);
    }

    /**
     * 按接口类型把档位注入到请求选项里。
     *
     * <p>先清掉本类管理的所有键（幂等，切换/关闭时不残留上一轮参数），再按当前接口写对应键。
     * 对无法识别或不适用于该接口的档位值，按关闭处理（只清理不注入）。</p>
     *
     * @param options  本轮请求选项（{@link ModelOptionsAmend}，如 ReAct 的 options）
     * @param standard 模型接口类型（ChatModel#getStandardOrProvider）
     * @param depth    档位编码（各接口各自的取值，如 minimal/low/medium/high；off/空=关闭）
     */
    @SuppressWarnings("unchecked")
    public static void applyTo(ModelOptionsAmend<?, ?> options, String standard, String depth) {
        if (options == null) {
            return;
        }

        // 先清理本类管理的键，保证幂等
        options.optionRemove("thinking");
        options.optionRemove("reasoning");
        options.optionRemove("reasoning_effort");
        // 清理 Anthropic 现代格式的 output_config.effort（保留调用方可能设的其它 output_config 字段）
        Object oc = options.option("output_config");
        if (oc instanceof Map) {
            ((Map<String, Object>) oc).remove("effort");
            if (((Map<String, Object>) oc).isEmpty()) {
                options.optionRemove("output_config");
            }
        }
        Object gc = options.option("generationConfig");
        if (gc instanceof Map) {
            ((Map<String, Object>) gc).remove("thinkingConfig");
        }

        String d = normalize(depth);
        if (OFF.equals(d) || !isValidFor(standard, d)) {
            return;
        }

        String s = std(standard);

        if (s.contains("anthropic") || s.contains("claude")) {
            if (ANTHROPIC_USE_EFFORT) {
                // 现代格式：adaptive thinking + output_config.effort（现代官方 Claude；dialect 透传 type/未知键）
                Map<String, Object> thinking = new LinkedHashMap<>();
                thinking.put("type", "adaptive");
                options.optionSet("thinking", thinking);

                Map<String, Object> outputConfig = new LinkedHashMap<>();
                Object existing = options.option("output_config");
                if (existing instanceof Map) {
                    outputConfig.putAll((Map<String, Object>) existing);
                }
                outputConfig.put("effort", d);
                options.optionSet("output_config", outputConfig);
            } else {
                // 老格式：thinking.budget_tokens（只认老接口的中转/旧版 Claude）
                Integer budget = ANTHROPIC_BUDGETS.get(d);
                Map<String, Object> thinking = new LinkedHashMap<>();
                thinking.put("type", "enabled");
                thinking.put("budget_tokens", budget);
                options.optionSet("thinking", thinking);
            }
        } else if (s.contains("responses")) {
            Map<String, Object> reasoning = new LinkedHashMap<>();
            reasoning.put("effort", d);
            options.optionSet("reasoning", reasoning);
        } else if (s.contains("gemini") || s.contains("google")) {
            // 合并已有 generationConfig，只补 thinkingConfig.thinkingLevel（Gemini 3.x，值大写）
            Map<String, Object> generationConfig = new LinkedHashMap<>();
            Object existing = options.option("generationConfig");
            if (existing instanceof Map) {
                generationConfig.putAll((Map<String, Object>) existing);
            }
            Map<String, Object> thinkingConfig = new LinkedHashMap<>();
            thinkingConfig.put("thinkingLevel", d.toUpperCase());
            generationConfig.put("thinkingConfig", thinkingConfig);
            options.optionSet("generationConfig", generationConfig);
        } else {
            // openai（Chat Completions）、ollama 及其它 effort 系接口：顶层透传
            options.optionSet("reasoning_effort", d);
        }
    }
}
