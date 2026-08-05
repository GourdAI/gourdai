/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.agent.AbsAgentChunk;
import com.gourdai.agent.react.ReActTrace;

/**
 * 重试状态块：模型调用失败后、即将再次尝试时，向用户侧推送一次重试提示。
 *
 * <p>由 {@link RetryNotifyInterceptor} 在每次失败尝试后生成，让前端能感知到
 * “正在重试第 N/M 次”的中间状态（库内部的重试对前端本不可见，只写日志）。</p>
 *
 * @author oisin
 */
public class RetryChunk extends AbsAgentChunk {
    /** 当前是第几次尝试（从 1 开始） */
    private final int attempt;
    /** 最大尝试次数（即用户配置的模型重试次数） */
    private final int maxRetries;

    public RetryChunk(ReActTrace trace, int attempt, int maxRetries) {
        super(trace.getRunId(), trace.getAgentName(), trace.getSession(), null);

        this.attempt = attempt;
        this.maxRetries = maxRetries;
    }

    /**
     * 获取当前尝试序号（从 1 开始）
     */
    public int getAttempt() {
        return attempt;
    }

    /**
     * 获取最大尝试次数
     */
    public int getMaxRetries() {
        return maxRetries;
    }

    /**
     * 组装用户可见的重试提示文案（各端统一真源，避免多处硬编码同一句话）。
     */
    public static String formatText(int attempt, int maxRetries) {
        return "模型调用失败，正在重试 " + attempt + "/" + maxRetries + " ...";
    }

    /**
     * 组装本块的重试提示文案。
     */
    public String toText() {
        return formatText(attempt, maxRetries);
    }
}
