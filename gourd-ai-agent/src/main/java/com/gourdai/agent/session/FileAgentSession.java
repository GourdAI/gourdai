/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.session;

import org.noear.solon.Utils;
import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentSession;
import org.noear.solon.ai.chat.ChatRole;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.flow.FlowContext;
import org.noear.solon.lang.Preview;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 文件型智能体会话适配器 (带内存缓存层)
 *
 * <p>落盘策略为惰性创建：构造时只初始化内存缓存，不创建会话目录；
 * 仅在真正持久化内容（写入消息）时才创建目录与文件。
 * 这样点击“新建会话”、切换模型/思考档位等只读或纯内存操作，
 * 不会在磁盘上产生空会话目录（避免无用 session 文件夹堆积）。</p>
 *
 * @author oisin
 * @since 3.9.1
 */
@Preview("3.9.1")
public class FileAgentSession implements AgentSession {
    private static final Logger LOG = LoggerFactory.getLogger(FileAgentSession.class);

    private final String sessionId;
    private final File baseDir;
    private final File messagesFile;
    private final File snapshotFile;
    private final InMemoryAgentSession cache;
    private final ReentrantLock locker = new ReentrantLock();

    public FileAgentSession(String sessionId, String dir) {
        Objects.requireNonNull(sessionId, "sessionId is required");
        Objects.requireNonNull(dir, "dir is required");

        this.baseDir = new File(dir);
        this.sessionId = sessionId;
        this.messagesFile = new File(baseDir, sessionId + ".messages.ndjson");
        this.snapshotFile = new File(baseDir, sessionId + ".snapshot.json");

        // --- 1. 初始化快照 ---
        FlowContext snapshot = null;
        if (snapshotFile.exists()) {
            try {
                byte[] bytes = Files.readAllBytes(snapshotFile.toPath());
                snapshot = FlowContext.fromJson(new String(bytes, StandardCharsets.UTF_8));
            } catch (Throwable e) {
                LOG.warn("Load snapshot failed, session: {}", sessionId, e);
            }
        }

        if (snapshot == null) {
            snapshot = FlowContext.of(sessionId);
        }

        // --- 2. 初始化缓存层 ---
        this.cache = new InMemoryAgentSession(snapshot);

        // --- 3. 加载历史消息到缓存 ---
        loadMessagesToCache();

        // 注入当前 FileAgentSession 到上下文，确保 updateSnapshot 触发的是当前实例
        this.cache.getContext().put(Agent.KEY_SESSION, this);
    }

    /**
     * 确保会话目录存在（惰性创建）。仅在真正要写文件前调用，
     * 避免“新建会话”等纯内存操作产生空目录。
     */
    private void ensureDir() {
        if (!baseDir.exists()) {
            baseDir.mkdirs();
        }
    }

    private void loadMessagesToCache() {
        if (!messagesFile.exists()) return;

        List<ChatMessage> history = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(messagesFile.toPath(), StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (Utils.isNotEmpty(line)) {
                    history.add(ChatMessage.fromJson(line));
                }
            }
            // 批量加入缓存（内存层会自动过滤 System 消息）
            this.cache.addMessage(history);
        } catch (IOException e) {
            LOG.error("Load messages to cache failed", e);
        }
    }

    @Override
    public String getSessionId() {
        return sessionId;
    }

    @Override
    public List<ChatMessage> getMessages() {
        // 直接走缓存
        return cache.getMessages();
    }

    @Override
    public List<ChatMessage> getLatestMessages(int windowSize) {
        // 直接走缓存
        return cache.getLatestMessages(windowSize);
    }

    @Override
    public void removeLatestMessage(int windowSize) {
        // 1. 先从内存层安全删除
        cache.removeLatestMessage(windowSize);

        // 2. 同步到磁盘：重写整个消息文件（目录不存在说明从未落盘，无需重写）
        if (messagesFile.exists()) {
            persistMessages();
        }
    }

    /**
     * 将当前内存缓存中的所有非 System 消息持久化到磁盘（全量覆盖）
     */
    private void persistMessages() {
        ensureDir();
        try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(messagesFile, false), StandardCharsets.UTF_8))) {
            for (ChatMessage msg : cache.getMessages()) {
                if (msg.getRole() != ChatRole.SYSTEM) {
                    writer.write(ChatMessage.toJson(msg));
                    writer.newLine();
                }
            }
            writer.flush();
        } catch (IOException e) {
            LOG.error("Persist messages failed: {}", e.toString());
        }
    }

    @Override
    public void addMessage(Collection<? extends ChatMessage> messages) {
        if (Utils.isEmpty(messages)) return;

        // 1. 同步到内存层
        cache.addMessage(messages);

        // 2. 持久化到磁盘 (NDJSON 追加模式)。写消息即会话首次产生真实内容，
        // 此时才惰性创建会话目录（新建空会话不落盘）
        ensureDir();
        try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(
                new FileOutputStream(messagesFile, true), StandardCharsets.UTF_8))) {
            for (ChatMessage msg : messages) {
                if (msg.getRole() != ChatRole.SYSTEM) {
                    writer.write(ChatMessage.toJson(msg));
                    writer.newLine();
                }
            }
            writer.flush();
        } catch (IOException e) {
            LOG.error("Persistence messages failed: {}", e.getMessage());
        }
    }

    @Override
    public boolean isEmpty() {
        return cache.isEmpty();
    }

    @Override
    public Map<String, Object> attrs() {
        return cache.attrs();
    }

    @Override
    public void updateSnapshot() {
        locker.lock();
        try {
            // 纯内存快照（目录尚未创建、且无消息）不落盘，
            // 避免切换模型/思考档位等操作为空会话创建目录
            if (!cache.isEmpty()) {
                ensureDir();
                // 将缓存中的快照全量持久化
                String json = cache.getContext().toJson();
                Files.write(snapshotFile.toPath(), json.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            LOG.error("Persistence snapshot failed: {}", e.toString());
        } finally {
            locker.unlock();
        }
    }

    @Override
    public FlowContext getContext() {
        // 外部读写的快照对象直接来自缓存
        return cache.getContext();
    }

    public void clear() {
        cache.clear();
        if (messagesFile.exists()) messagesFile.delete();
        if (snapshotFile.exists()) snapshotFile.delete();
    }
}
