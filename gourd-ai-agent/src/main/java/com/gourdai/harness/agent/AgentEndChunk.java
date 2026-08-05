/*
 * Copyright 2017-2026 noear.org and authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.gourdai.harness.agent;

import com.gourdai.agent.AgentChunk;
import com.gourdai.agent.AgentSession;
import org.noear.solon.ai.chat.message.ChatMessage;

import java.util.Collections;
import java.util.Map;

/**
 * 子代理结束标记 Chunk
 * <p>
 * 用于在流式模式下，向父代理的 FluxSink 推送「子代理已结束」信号。
 * 下游流构建器（如 WebStreamBuilder）据此生成 agent_end 类型的 WebChunk，
 * 供前端将"智能体"徽章卡片转为完成态。
 * </p>
 *
 * @author oisin
 */
public class AgentEndChunk implements AgentChunk {
    private final String agentName;
    private final String description;
    private final boolean success;
    private final String resultSummary;
    private final String sessionId;
    public AgentEndChunk(String agentName, String description, boolean success, String resultSummary, String sessionId) {
        this.agentName = agentName;
        this.description = description;
        this.success = success;
        this.resultSummary = resultSummary;
        this.sessionId = sessionId;
    }

    public String getAgentName() {
        return agentName;
    }

    public String getDescription() {
        return description;
    }

    public boolean isSuccess() {
        return success;
    }

    public String getResultSummary() {
        if (resultSummary == null) {
            return "";
        }
        if (resultSummary.length() > 200) {
            return resultSummary.substring(0, 200) + "...";
        }
        return resultSummary;
    }

    @Override
    public AgentSession getSession() {
        return null;
    }

    @Override
    public String getRunId() {
        return null;
    }

    @Override
    public ChatMessage getMessage() {
        return null;
    }

    @Override
    public Map<String, Object> getMeta() {
        return Collections.emptyMap();
    }

    @Override
    public boolean hasMeta(String name) {
        return false;
    }
}