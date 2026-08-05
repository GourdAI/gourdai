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
 * 子代理启动标记 Chunk
 * <p>
 * 用于在流式模式下，向父代理的 FluxSink 推送「子代理已启动」信号。
 * 下游流构建器（如 WebStreamBuilder）据此生成 agent_start 类型的 WebChunk，
 * 供前端渲染"智能体"徽章卡片（类似 Claude Code 的 subagent badge）。
 * </p>
 *
 * @author oisin
 */
public class AgentStartChunk implements AgentChunk {
    private final String agentName;
    private final String description;
    private final String sessionId;
    private String runId;

    public AgentStartChunk(String agentName, String description, String sessionId) {
        this.agentName = agentName;
        this.description = description;
        this.sessionId = sessionId;
    }

    public String getAgentName() {
        return agentName;
    }

    public String getDescription() {
        return description;
    }

    @Override
    public AgentSession getSession() {
        return null;
    }

    @Override
    public String getRunId() {
        return runId;
    }

    public void setRunId(String runId) {
        this.runId = runId;
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