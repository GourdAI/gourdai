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

import com.gourdai.agent.AgentSessionProvider;

import java.io.File;
import java.nio.file.Paths;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话目录定位器 —— 统一解析 {@code sessionId → 会话存储目录} 的唯一入口。
 *
 * <p>Gourd AI 支持两种对话模式，会话数据落盘位置不同：</p>
 * <ul>
 *   <li><b>Chat 模式</b>（{@code web-} 前缀）：存到<b>安装目录</b>（App 启动的 {@code user.dir}）下的
 *       {@code .gourdai/sessions/}。这是全局会话区，位置固定、跨所选项目不变
 *       —— 与历史行为完全一致，不做任何迁移。</li>
 *   <li><b>Code 模式</b>（{@code code-} 前缀）：存到<b>所选项目</b>目录
 *       {@code <projectRoot>/.gourdai/sessions/}，随项目走。</li>
 * </ul>
 *
 * <h3>Code 会话的项目根注册</h3>
 * <p>{@link AgentSessionProvider} 仅能拿到 {@code sessionId}，
 * 无法感知所选项目。因此 Web 层在处理 code 会话输入前，先调用
 * {@link #bindCodeProject(String, String)} 把 {@code sessionId → projectRoot} 登记到内存表，
 * 之后 {@link #resolveDir(String, String)} 即可正确解析。</p>
 *
 * @author oisin
 * @see WebController
 * @see FileService
 */
public class SessionLocator {
    /** code 模式会话 ID 前缀 */
    public static final String PREFIX_CODE = "code-";
    /** chat 模式会话 ID 前缀 */
    public static final String PREFIX_CHAT = "chat-";

    /** 安装目录 / 全局会话根（进程 user.dir，固定不变） */
    private final String workspace;
    /** 马具会话相对存放区，如 ".gourdai/sessions/" */
    private final String harnessSessions;

    /** code 会话 → 项目根目录 的内存登记表（进程内有效） */
    private final Map<String, String> codeProjectRoots = new ConcurrentHashMap<>();

    public SessionLocator(String workspace, String harnessSessions) {
        this.workspace = workspace;
        this.harnessSessions = harnessSessions;
    }

    /**
     * 判断是否为 code 模式会话 ID。
     */
    public static boolean isCodeSession(String sessionId) {
        return sessionId != null && sessionId.startsWith(PREFIX_CODE);
    }

    /**
     * 登记 code 会话所属的项目根目录。
     * <p>在处理该会话的聊天输入之前调用，供后续 {@code AgentSessionProvider} 解析落盘目录。</p>
     *
     * @param sessionId   会话 ID（应为 code- 前缀）
     * @param projectRoot 项目根目录绝对路径；为空则忽略（回退到安装目录）
     */
    public void bindCodeProject(String sessionId, String projectRoot) {
        if (sessionId == null || projectRoot == null || projectRoot.trim().isEmpty()) {
            return;
        }
        codeProjectRoots.put(sessionId, projectRoot.trim());
    }

    /**
     * 解析会话存储目录（不带外部项目根提示，仅用于 {@code AgentSessionProvider}）。
     *
     * @param sessionId 会话 ID
     * @return 该会话的存储目录（绝对、规范化）
     */
    public File resolveDir(String sessionId) {
        return resolveDir(sessionId, null);
    }

    /**
     * 解析会话存储目录。
     *
     * @param sessionId   会话 ID
     * @param projectRoot 可选的项目根提示（code 模式由 Web 层透传；chat 模式忽略）
     * @return 该会话的存储目录（绝对、规范化）
     */
    public File resolveDir(String sessionId, String projectRoot) {
        if (isCodeSession(sessionId)) {
            String root = (projectRoot != null && !projectRoot.trim().isEmpty())
                    ? projectRoot.trim()
                    : codeProjectRoots.get(sessionId);
            if (root == null || root.isEmpty()) {
                // 未登记项目根时回退到安装目录，保证不丢数据
                root = workspace;
            }
            return sessionDir(root, sessionId);
        }

        // chat / 默认会话：安装目录（全局，固定不变）
        return sessionDir(workspace, sessionId);
    }

    /**
     * chat 模式会话列表的扫描根目录（安装目录，全局固定）。
     */
    public File chatSessionsRoot() {
        return sessionsRoot(workspace);
    }

    /**
     * code 模式会话列表的扫描根目录（指定项目）。
     *
     * @param projectRoot 项目根目录；为空时回退到安装目录
     */
    public File codeSessionsRoot(String projectRoot) {
        String root = (projectRoot != null && !projectRoot.trim().isEmpty()) ? projectRoot.trim() : workspace;
        return sessionsRoot(root);
    }

    private File sessionsRoot(String root) {
        return Paths.get(root, harnessSessions).toAbsolutePath().normalize().toFile();
    }

    /**
     * 解析会话目录，并做统一的路径越界防护（所有 resolveDir 调用的唯一收口点）。
     *
     * <p>最终路径为 {@code <root>/<harnessSessions>/<sessionId>}。此处强制校验规范化后的
     * 结果仍落在 {@code <root>/<harnessSessions>/} 之内——即便某个上层调用忘了校验
     * {@code sessionId}（当前各 Web 端点对 {@code ..} 的校验并不一致），带 {@code ..}
     * 或分隔符的 {@code sessionId} 也无法逃逸到会话区之外。{@code root} 亦拒绝空字节。</p>
     *
     * @throws IllegalArgumentException sessionId 越界或含非法字符时抛出，由上层转 4xx
     */
    private File sessionDir(String root, String sessionId) {
        if (sessionId == null || sessionId.indexOf('\0') >= 0
                || sessionId.indexOf('/') >= 0 || sessionId.indexOf('\\') >= 0
                || sessionId.contains("..")) {
            throw new IllegalArgumentException("Illegal sessionId: " + sessionId);
        }
        if (root != null && root.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Illegal project root");
        }

        java.nio.file.Path base = Paths.get(root, harnessSessions).toAbsolutePath().normalize();
        java.nio.file.Path target = base.resolve(sessionId).normalize();
        //规范化后必须仍在会话区之内，杜绝 sessionId 借 .. 逃逸
        if (!target.startsWith(base)) {
            throw new IllegalArgumentException("Illegal sessionId path escape: " + sessionId);
        }
        return target.toFile();
    }
}
