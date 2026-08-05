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
package com.gourdai.core.portal.web;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话流式事件存储 —— 把每轮 AI 交互的完整流式过程（推理、工具卡片、正文、trace 等）
 * 逐条落盘到 {@code <sessionId>.stream.ndjson}，供历史加载时原样回放。
 *
 * <h3>为什么需要它</h3>
 * <p>{@code <sessionId>.messages.ndjson} 只保存 harness 引擎跑完后的<b>最终 assistant 文本</b>，
 * 流式期间通过 {@link WebGate#emitToClient} 推给前端的工具调用卡片（read/edit/bash…）、
 * 中间过程叙述、思考块等都是<b>临时 UI 事件</b>，从不落盘。因此历史会话再打开时，
 * 只能看到最终一段话，看不到「做了哪些操作」。本存储在 {@code emitToClient} 处旁路捕获这些事件，
 * 使其可持久化、可回放。</p>
 *
 * <h3>落盘策略</h3>
 * <ul>
 *   <li><b>逐会话串行写</b>：每个 sessionId 一把锁，保证 ndjson 行不交错。</li>
 *   <li><b>text/reason 合并</b>：流式正文/推理是大量增量小块（每 token 一条），
 *       直接落盘会产生成千上万行。故在内存按 (type,runId) 累积，遇到边界事件
 *       （工具卡片、trace、done 等非同类型块）或 flush 时，把累积文本合并为一条再写。</li>
 *   <li><b>存全文、传预览</b>：落盘<b>保留完整</b>工具结果（read 大文件/bash 长日志），磁盘即
 *       完整源真相、可回溯（仅保留 1MB 病态防护上限）；仅在 {@link #load} 回传前端时，对超长块
 *       截断为预览 + {@code truncated} 标记，把卡顿问题收敛在传输/渲染层，而不是靠丢数据。</li>
 *   <li><b>过滤瞬时提示</b>：{@code retry}（瞬时重试提示）不落盘；{@code done} 仅落一条无文本的轮次边界标记。其余全部保留。</li>
 * </ul>
 *
 * @author oisin
 * @see WebGate#emitToClient
 * @see SessionLocator
 */
public class SessionStreamStore {
    private static final Logger LOG = LoggerFactory.getLogger(SessionStreamStore.class);

    /** 流式事件文件后缀（与 messages.ndjson 并列存放） */
    public static final String STREAM_SUFFIX = ".stream.ndjson";

    /**
     * 单个块 {@code text} 落盘的<b>病态防护上限</b>（非功能性截断）。
     * <p>历史回溯要求「信息零丢失」，故正常工具结果（read 大文件、bash 长日志）一律<b>全文落盘</b>，
     * 磁盘文件即完整源真相，可回溯/导出。此上限仅用于兜底极端异常——某个工具一次吐出数百 MB
     * 会撑爆磁盘与内存。触及此限（1MB）才截断，属于不应发生的病态场景，附标记以示区分。</p>
     * <p>与传输瘦身（{@link #PREVIEW_CHARS}）是两回事：落盘存全文，仅回放<b>传输</b>时才做预览。</p>
     */
    private static final int MAX_TEXT_CHARS = 1024 * 1024;

    /** 触及病态上限时追加的提示标记（正常流程永不出现） */
    private static final String TRUNCATE_MARK = "\n…（内容超长已截断）";

    /**
     * 回放<b>传输</b>时单个块 {@code text} 的预览上限。落盘是全文，但 {@link #load} 把整个 stream 文件
     * 读回内存并作为一个 JSON 响应回传前端——若把每条数 MB 的工具结果全量传输 + 重建 DOM 会明显卡顿。
     * 故超过此长度的块在<b>返回副本</b>上截断为预览，并置 {@code truncated=true}、{@code fullLength}，
     * 前端据此展示「结果较长（N 字符）」提示。磁盘全文不受影响，始终可追溯。
     */
    private static final int PREVIEW_CHARS = 64 * 1024;

    private final SessionLocator sessionLocator;

    /** 逐会话写锁，防止并发轮次的行交错 */
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    /** 逐会话的 text/reason 累积缓冲（合并小增量块） */
    private final Map<String, TextBuffer> buffers = new ConcurrentHashMap<>();

    public SessionStreamStore(SessionLocator sessionLocator) {
        this.sessionLocator = sessionLocator;
    }

    /** text/reason 增量合并缓冲：同一 (type,runId) 连续到达时在内存累积，遇边界一次性落盘。 */
    private static final class TextBuffer {
        String type;      // "text" 或 "reason"
        String runId;
        StringBuilder sb = new StringBuilder();
        long createdAt;

        boolean isEmpty() {
            return sb.length() == 0;
        }
    }

    private Object lockFor(String sessionId) {
        return locks.computeIfAbsent(sessionId, k -> new Object());
    }

    /**
     * 记录一条流经 {@link WebGate#emitToClient} 的出站消息块。
     *
     * @param sessionId  会话标识
     * @param projectRoot code 会话的项目根（chat 会话传 null），用于解析落盘目录
     * @param chunk      待记录的消息块
     */
    public void record(String sessionId, String projectRoot, WebChunk chunk) {
        if (chunk == null || chunk.getType() == null) {
            return;
        }
        String type = chunk.getType();

        // done：作为轮次边界。flush 文本缓冲后落一条轻量边界标记（保留 type=done，
        // 不携文本），使回放时能可靠地切分轮次——尤其无 trace 的纯命令轮（如 /git），
        // 仅靠 trace/user 无法划分，会两轮粘连。
        if ("done".equals(type)) {
            try {
                synchronized (lockFor(sessionId)) {
                    TextBuffer pending = buffers.remove(sessionId);
                    if (pending != null && !pending.isEmpty()) {
                        writeBuffer(sessionId, projectRoot, pending);
                    }
                    WebChunk dc = new WebChunk();
                    dc.setType("done");
                    dc.setSessionId(sessionId);
                    dc.setRunId(chunk.getRunId());
                    dc.setCreatedAt(chunk.getCreatedAt() != null ? chunk.getCreatedAt() : System.currentTimeMillis());
                    appendLine(sessionId, projectRoot, ONode.serialize(dc));
                }
            } catch (Throwable e) {
                LOG.warn("[StreamStore] record done failed for session {}: {}", sessionId, e.getMessage());
            }
            return;
        }

        // 瞬时提示：历史回放无意义，不落盘
        if ("retry".equals(type)) {
            return;
        }

        try {
            synchronized (lockFor(sessionId)) {
                if ("text".equals(type) || "reason".equals(type)) {
                    // 增量合并：与当前缓冲同类型且同 runId 则累积，否则先冲刷旧缓冲再起新缓冲
                    TextBuffer buf = buffers.get(sessionId);
                    if (buf != null && (!buf.type.equals(type) || !sameRun(buf.runId, chunk.getRunId()))) {
                        writeBuffer(sessionId, projectRoot, buf);
                        buf = null;
                    }
                    if (buf == null) {
                        buf = new TextBuffer();
                        buf.type = type;
                        buf.runId = chunk.getRunId();
                        buf.createdAt = chunk.getCreatedAt() != null ? chunk.getCreatedAt() : System.currentTimeMillis();
                        buffers.put(sessionId, buf);
                    }
                    if (chunk.getText() != null) {
                        buf.sb.append(chunk.getText());
                    }
                    return;
                }

                // 非文本块（工具卡片、trace、user、rewind、hitl、command、error…）：
                // 先冲刷挂起的文本缓冲（保证顺序），再直接落盘本块
                TextBuffer pending = buffers.remove(sessionId);
                if (pending != null && !pending.isEmpty()) {
                    writeBuffer(sessionId, projectRoot, pending);
                }
                appendLine(sessionId, projectRoot, serialize(chunk));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] record failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 冲刷指定会话挂起的文本缓冲（轮次结束/中断时调用）。
     */
    public void flush(String sessionId, String projectRoot) {
        try {
            synchronized (lockFor(sessionId)) {
                TextBuffer buf = buffers.remove(sessionId);
                if (buf != null && !buf.isEmpty()) {
                    writeBuffer(sessionId, projectRoot, buf);
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] flush failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 直接记录一条用户输入事件（网页手动输入不走 emitToClient，需显式补记，
     * 否则回放时缺少用户气泡）。
     *
     * @param sessionId 会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param text      用户输入文本
     * @param createdAt 时间戳（epoch 毫秒）
     */
    public void recordUser(String sessionId, String projectRoot, String text, long createdAt) {
        if (text == null) {
            return;
        }
        try {
            synchronized (lockFor(sessionId)) {
                // 补记用户前先冲刷上一轮可能残留的文本缓冲
                TextBuffer pending = buffers.remove(sessionId);
                if (pending != null && !pending.isEmpty()) {
                    writeBuffer(sessionId, projectRoot, pending);
                }
                WebChunk uc = new WebChunk();
                // 复用前端 user 分支渲染（app-streaming.js 对 type=user 渲染用户气泡）
                uc.setType("user");
                uc.setText(text);
                uc.setSessionId(sessionId);
                uc.setCreatedAt(createdAt);
                appendLine(sessionId, projectRoot, ONode.serialize(uc));
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] recordUser failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /**
     * 读取指定会话已落盘的全部流式事件（供 {@code /web/chat/replay} 回放）。
     *
     * <p><b>传输层瘦身</b>：磁盘存的是全文（信息零丢失），但本方法会把整个文件读回内存并
     * 作为一个 JSON 响应回传前端。若某些工具结果数 MB，全量传输 + 重建 DOM 会卡顿。故对超过
     * {@link #PREVIEW_CHARS} 的 {@code text} 块，<b>仅在返回副本上</b>截断为预览并标记 {@code truncated=true}、
     * {@code fullLength}，前端据此提示「结果较长」并按需拉取全文。磁盘全文不受影响，始终可追溯。</p>
     *
     * @param sessionId  会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @return 事件列表（每项为 chunk 的原始字段 Map，长文本已瘦身为预览）；无记录时返回空列表
     */
    public List<Map> load(String sessionId, String projectRoot) {
        return loadWithMeta(sessionId, projectRoot, null).events;
    }

    /**
     * 带分页元信息的加载方法。
     *
     * @param sessionId   会话标识
     * @param projectRoot code 会话项目根
     * @param tail        若不为 null，只取最后 tail 条事件；null 表示全量加载
     * @return 包含事件列表、总数和 hasMore 标记的加载结果
     */
    public LoadResult loadWithMeta(String sessionId, String projectRoot, Integer tail) {
        LoadResult result = new LoadResult();
        File file = streamFile(sessionId, projectRoot);
        if (file == null || !file.exists()) {
            return result;
        }
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            int lineNo = 0;
            List<Map> allData = new ArrayList<>();
            while ((line = br.readLine()) != null) {
                lineNo++;
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    continue;
                }
                try {
                    ONode node = ONode.ofJson(trimmed);
                    Map bean = node.toBean(Map.class);
                    previewForTransport(bean, lineNo);
                    allData.add(bean);
                } catch (Throwable ignore) {
                    // 跳过损坏行
                }
            }
            result.totalCount = allData.size();
            if (tail != null && tail > 0 && allData.size() > tail) {
                result.events = new ArrayList<>(allData.subList(allData.size() - tail, allData.size()));
                result.hasMore = true;
            } else {
                result.events = allData;
                result.hasMore = false;
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] load failed for session {}: {}", sessionId, e.getMessage());
        }
        return result;
    }

    /** 分页加载结果 */
    public static class LoadResult {
        public List<Map> events = new ArrayList<>();
        public int totalCount;
        public boolean hasMore;
    }

    /**
     * 传输层预览瘦身：若事件的 {@code text} 超过 {@link #PREVIEW_CHARS}，就地截断返回副本的 text，
     * 并注入 {@code truncated=true}、{@code fullLength}（原始全长）与 {@code seq}（物理行号，供前端
     * 回指拉取全文）供前端提示与展开。仅作用于回传的 Map 副本，磁盘行不变。未超限的块原样返回。
     */
    @SuppressWarnings("unchecked")
    private static void previewForTransport(Map bean, int seq) {
        if (bean == null) {
            return;
        }
        Object t = bean.get("text");
        if (!(t instanceof String)) {
            return;
        }
        String text = (String) t;
        if (text.length() <= PREVIEW_CHARS) {
            return;
        }
        bean.put("text", text.substring(0, PREVIEW_CHARS)
                + "\n…（结果较长，已折叠预览前 " + (PREVIEW_CHARS / 1024) + "KB，共 " + text.length() + " 字符）");
        bean.put("truncated", Boolean.TRUE);
        bean.put("fullLength", text.length());
        bean.put("seq", seq);
    }

    /**
     * 按物理行号 {@code seq} 回取单个块的<b>完整 text 全文</b>（供前端对被预览截断的块
     * “点击展开”时按需拉取）。{@code seq} 由 {@link #load} 注入，与文件物理行（1 起）一一对应。
     *
     * @param sessionId   会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param seq         目标行号（{@link #load} 回传的 {@code seq}）
     * @return 该块的完整 text；行号越界、行无 text 或文件缺失时返回 null
     */
    public String loadFull(String sessionId, String projectRoot, int seq) {
        if (seq <= 0) {
            return null;
        }
        File file = streamFile(sessionId, projectRoot);
        if (file == null || !file.exists()) {
            return null;
        }
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            int lineNo = 0;
            while ((line = br.readLine()) != null) {
                lineNo++;
                if (lineNo < seq) {
                    continue;
                }
                if (lineNo > seq) {
                    break;
                }
                String trimmed = line.trim();
                if (trimmed.isEmpty()) {
                    return null;
                }
                ONode node = ONode.ofJson(trimmed);
                return node.get("text").getString();
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] loadFull failed for session {} seq {}: {}", sessionId, seq, e.getMessage());
        }
        return null;
    }

    /**
     * 判断指定会话是否已有流式事件文件（有则回放，无则回退旧的纯文本加载）。
     */
    public boolean exists(String sessionId, String projectRoot) {
        File file = streamFile(sessionId, projectRoot);
        return file != null && file.exists();
    }

    /**
     * 按用户轮次边界裁剪 stream 文件（回退时调用）——保留未回退轮次的完整富回放。
     *
     * <p>rewind 是高频操作（重发/改一句重问），若每次都整删 stream 文件，代价是整段会话
     * 的工具卡片/过程叙述永久丢失。故改为以 {@code user} 事件为边界，仅剔除最后 {@code turns}
     * 个用户轮次（含其后的全部 AI 过程事件），与 messages.ndjson 的裁剪对齐。</p>
     *
     * @param sessionId  会话标识
     * @param projectRoot code 会话项目根（chat 传 null）
     * @param turns      剔除的用户轮次数（至少 1）
     */
    public void rewindTurns(String sessionId, String projectRoot, int turns) {
        if (turns <= 0) {
            turns = 1;
        }
        try {
            synchronized (lockFor(sessionId)) {
                buffers.remove(sessionId);
                File file = streamFile(sessionId, projectRoot);
                if (file == null || !file.exists()) {
                    return;
                }

                List<String> lines = new ArrayList<>();
                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        if (!line.trim().isEmpty()) {
                            lines.add(line);
                        }
                    }
                }

                // 从尾向前找第 turns 个 user 边界，截至该边界（含）之前
                int cut = -1;
                int seen = 0;
                for (int i = lines.size() - 1; i >= 0; i--) {
                    if (isUserLine(lines.get(i))) {
                        seen++;
                        if (seen >= turns) {
                            cut = i;
                            break;
                        }
                    }
                }

                if (cut < 0) {
                    // 要回退的轮次多于文件中的 user 边界（如回退超出历史），整删
                    file.delete();
                    return;
                }

                if (cut == 0) {
                    file.delete();
                    return;
                }

                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < cut; i++) {
                    sb.append(lines.get(i)).append('\n');
                }
                try (Writer w = new OutputStreamWriter(new FileOutputStream(file, false), StandardCharsets.UTF_8)) {
                    w.write(sb.toString());
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] rewindTurns failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    /** 快速判断一行是否为 user 轮次边界（避免全量反序列化，先做字符串预判） */
    private static boolean isUserLine(String line) {
        if (line == null || line.indexOf("\"user\"") < 0) {
            return false;
        }
        try {
            ONode node = ONode.ofJson(line);
            return "user".equals(node.get("type").getString());
        } catch (Throwable ignore) {
            return false;
        }
    }

    /**
     * 删除指定会话的流式事件文件（会话删除时调用）。
     */
    public void delete(String sessionId, String projectRoot) {
        try {
            synchronized (lockFor(sessionId)) {
                buffers.remove(sessionId);
                File file = streamFile(sessionId, projectRoot);
                if (file != null && file.exists()) {
                    file.delete();
                }
            }
        } catch (Throwable e) {
            LOG.warn("[StreamStore] delete failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    private void writeBuffer(String sessionId, String projectRoot, TextBuffer buf) {
        WebChunk wc = new WebChunk();
        wc.setType(buf.type);
        wc.setText(buf.sb.toString());
        wc.setRunId(buf.runId);
        wc.setSessionId(sessionId);
        wc.setCreatedAt(buf.createdAt);
        appendLine(sessionId, projectRoot, serialize(wc));
    }

    /**
     * 序列化一个待落盘的块：<b>默认存全文</b>（信息零丢失，供回溯），只在 {@code text} 长度
     * 达到病态上限 {@link #MAX_TEXT_CHARS}（1MB）时才截断——防某个异常工具吐出数百 MB 撑爆磁盘。
     * 正常 read/bash 结果远不及此阈值。
     * <p>截断时仅在<b>副本</b>上操作，严禁直接改动传入的 chunk——它可能是 {@link WebGate#emitToClient}
     * 正在同步推送给前端的同一实例。未超限时直接序列化原块（零拷贝）。传输层的预览瘦身另见 {@link #load}。</p>
     */
    private static String serialize(WebChunk chunk) {
        String text = chunk.getText();
        if (text == null || text.length() <= MAX_TEXT_CHARS) {
            return ONode.serialize(chunk);
        }
        // 浅拷一份，仅替换 text，其余字段（toolName/actionId/args…）原样保留
        ONode node = ONode.ofBean(chunk);
        node.set("text", text.substring(0, MAX_TEXT_CHARS) + TRUNCATE_MARK);
        return node.toJson();
    }

    private void appendLine(String sessionId, String projectRoot, String json) {
        File file = streamFile(sessionId, projectRoot);
        if (file == null) {
            return;
        }
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) {
            dir.mkdirs();
        }
        // 追加写，一行一个 JSON（与 messages.ndjson 格式一致）
        try (Writer w = new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
            w.write(json);
            w.write('\n');
        } catch (Throwable e) {
            LOG.warn("[StreamStore] append failed for session {}: {}", sessionId, e.getMessage());
        }
    }

    private File streamFile(String sessionId, String projectRoot) {
        try {
            File dir = sessionLocator.resolveDir(sessionId, projectRoot);
            return new File(dir, sessionId + STREAM_SUFFIX);
        } catch (Throwable e) {
            LOG.warn("[StreamStore] resolve dir failed for session {}: {}", sessionId, e.getMessage());
            return null;
        }
    }

    private static boolean sameRun(String a, String b) {
        return a == null ? b == null : a.equals(b);
    }
}
