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
import org.noear.solon.core.util.Assert;
import org.noear.solon.net.websocket.WebSocket;
import org.noear.solon.net.websocket.listener.SimpleWebSocketListener;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * TerminalGate —— Code 模式本地终端 WebSocket 网关。
 *
 * <p>每个前端终端标签建立一条独立的 WebSocket 连接（{@code /web/terminal}）。
 * 连接建立时在所选项目目录下启动一个常驻 shell 子进程（Windows 用 {@code cmd.exe}，
 * 类 Unix 用 {@code $SHELL}/bash），通过后台线程把子进程的 stdout/stderr 流式推给前端，
 * 前端键入的命令则原样写入子进程 stdin。因是常驻 shell，{@code cd} 等状态会自然保留。</p>
 *
 * <h3>协议（JSON 文本帧）</h3>
 * <ul>
 *   <li>客户端 → 服务端：{@code {"type":"input","data":"ls\n"}}</li>
 *   <li>服务端 → 客户端：{@code {"type":"output","data":"..."}}、{@code {"type":"exit","code":0}}</li>
 * </ul>
 *
 * <p>说明：未使用原生 PTY，故不支持完整 ANSI 光标控制（如 vim/top 全屏程序表现受限），
 * 但满足日常命令执行（构建、git、脚本运行等）需求，且零外部依赖、跨平台。</p>
 *
 * @author oisin
 * @see WebController
 */
public class TerminalGate extends SimpleWebSocketListener {
    private static final Logger LOG = LoggerFactory.getLogger(TerminalGate.class);

    private static final boolean IS_WINDOWS =
            System.getProperty("os.name", "").toLowerCase().contains("win");

    /** 启动工作区（前端未传 cwd 时的兜底目录）。 */
    private final File workspaceDir;

    /** socket.id -> 该连接绑定的 shell 会话。 */
    private final Map<String, ShellSession> sessions = new ConcurrentHashMap<>();

    public TerminalGate(String workspace) {
        this.workspaceDir = new File(workspace);
    }

    @Override
    public void onOpen(WebSocket socket) {
        // 前端以 ?cwd=<项目根> 传入工作目录；为空或非法则退回启动工作区。
        String cwd = socket.param("cwd");
        File dir = workspaceDir;
        if (Assert.isNotEmpty(cwd) && cwd.indexOf("..") < 0) {
            File d = new File(cwd);
            if (d.isDirectory()) {
                dir = d;
            }
        }

        try {
            ShellSession session = new ShellSession(socket, dir);
            sessions.put(socket.id(), session);
            session.start();
        } catch (Exception e) {
            LOG.warn("[TerminalGate] shell 启动失败: {}", e.getMessage());
            sendJson(socket, new ONode().set("type", "output")
                    .set("data", "\r\n[终端启动失败] " + e.getMessage() + "\r\n"));
            safeClose(socket);
        }
    }

    @Override
    public void onMessage(WebSocket socket, String text) {
        ShellSession session = sessions.get(socket.id());
        if (session == null) {
            return;
        }
        try {
            ONode root = ONode.ofJson(text);
            String type = root.get("type") != null ? root.get("type").getString() : null;
            if ("input".equals(type)) {
                ONode dataNode = root.get("data");
                if (dataNode != null) {
                    session.write(dataNode.getString());
                }
            }
            // 其余类型（如 resize）当前无 PTY，忽略即可。
        } catch (Exception e) {
            LOG.debug("[TerminalGate] 消息处理异常: {}", e.getMessage());
        }
    }

    @Override
    public void onClose(WebSocket socket) {
        ShellSession session = sessions.remove(socket.id());
        if (session != null) {
            session.destroy();
        }
    }

    @Override
    public void onError(WebSocket socket, Throwable error) {
        ShellSession session = sessions.remove(socket.id());
        if (session != null) {
            session.destroy();
        }
    }

    private static void sendJson(WebSocket socket, ONode node) {
        try {
            socket.send(node.toJson());
        } catch (Exception e) {
            LOG.debug("[TerminalGate] 发送失败: {}", e.getMessage());
        }
    }

    private static void safeClose(WebSocket socket) {
        try {
            socket.close();
        } catch (Exception ignored) {
        }
    }

    /**
     * 单条 WebSocket 连接对应的 shell 子进程会话。
     */
    private static class ShellSession {
        private final WebSocket socket;
        private final Process process;
        private final OutputStream stdin;
        private volatile boolean closed = false;

        ShellSession(WebSocket socket, File dir) throws IOException {
            this.socket = socket;

            ProcessBuilder pb;
            if (IS_WINDOWS) {
                // cmd.exe 从 stdin 逐行读取命令；redirectErrorStream 合并 stderr 便于顺序输出。
                pb = new ProcessBuilder("cmd.exe");
            } else {
                String shell = System.getenv("SHELL");
                if (shell == null || shell.trim().isEmpty()) {
                    shell = "/bin/bash";
                }
                // -i 交互模式，保留提示符与别名等交互特性。
                pb = new ProcessBuilder(shell, "-i");
            }
            pb.directory(dir);
            pb.redirectErrorStream(true);
            // 关闭 git 等命令的终端提示，避免子进程等待无处输入的密码提示而挂死。
            pb.environment().put("GIT_TERMINAL_PROMPT", "0");

            this.process = pb.start();
            this.stdin = process.getOutputStream();
        }

        void start() {
            // 输出读取线程：把子进程输出按块流式推给前端。
            Thread reader = new Thread(() -> pump(process.getInputStream()), "terminal-reader");
            reader.setDaemon(true);
            reader.start();

            // 退出监听线程：进程结束后通知前端并关闭连接。
            Thread waiter = new Thread(() -> {
                try {
                    int code = process.waitFor();
                    if (!closed) {
                        sendJson(socket, new ONode().set("type", "exit").set("code", code));
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } finally {
                    safeClose(socket);
                }
            }, "terminal-waiter");
            waiter.setDaemon(true);
            waiter.start();

            // Windows 下切到 UTF-8 代码页，保证中文输出不乱码（结果读取按 UTF-8）。
            if (IS_WINDOWS) {
                write("chcp 65001 >nul\r\n");
            }
        }

        private void pump(InputStream in) {
            byte[] buf = new byte[4096];
            try {
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (closed) {
                        break;
                    }
                    String chunk = new String(buf, 0, n, StandardCharsets.UTF_8);
                    sendJson(socket, new ONode().set("type", "output").set("data", chunk));
                }
            } catch (IOException e) {
                // 进程结束或流关闭，正常退出。
            }
        }

        void write(String data) {
            if (closed || data == null) {
                return;
            }
            try {
                stdin.write(data.getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (IOException e) {
                LOG.debug("[TerminalGate] 写入 stdin 失败: {}", e.getMessage());
            }
        }

        void destroy() {
            closed = true;
            try {
                stdin.close();
            } catch (Exception ignored) {
            }
            try {
                process.destroy();
                // 给一点时间优雅退出，超时则强杀。
                if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (Exception e) {
                process.destroyForcibly();
            }
        }
    }
}
