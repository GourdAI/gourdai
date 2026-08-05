package com.gourdai.core.portal.acp;

import com.agentclientprotocol.sdk.agent.AcpAgent;
import com.agentclientprotocol.sdk.agent.AcpAsyncAgent;
import com.agentclientprotocol.sdk.spec.AcpAgentTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActChunk;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ObservationChunk;
import com.gourdai.agent.react.task.PlanChunk;
import com.gourdai.agent.react.task.ReasonChunk;
import com.gourdai.agent.react.task.ThoughtChunk;
import com.gourdai.core.portal.web.ThinkingDepth;
import org.noear.solon.ai.chat.ChatModel;
import org.noear.solon.ai.chat.content.Contents;
import org.noear.solon.ai.chat.content.ImageBlock;
import org.noear.solon.ai.chat.content.TextBlock;
import org.noear.solon.ai.chat.message.ChatMessage;
import org.noear.solon.ai.chat.prompt.Prompt;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.agent.TaskTalent;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.entity.ModelDo;
import org.noear.solon.core.util.Assert;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class AcpLink implements Runnable {
    private final HarnessEngine agentRuntime;
    private final AcpAgentTransport agentTransport;
    private final AgentSettings agentSettings;

    public AcpLink(HarnessEngine agentRuntime, AcpAgentTransport agentTransport, AgentSettings agentSettings) {
        this.agentRuntime = agentRuntime;
        this.agentTransport = agentTransport;
        this.agentSettings = agentSettings;
    }

    private final Map<String, AcpSessionContext> sessionStates = new ConcurrentHashMap<>();

    public void run() {
        AcpAsyncAgent acpAgent = createAgent(agentTransport);
        Mono<Void> startMono = acpAgent.start();

        // 阻塞等待 ACP 启动完成，启动失败则退出进程
        try {
            startMono.block();
        } catch (Throwable e) {
            System.err.println("ACP agent start failed: " + e.getMessage());
            e.printStackTrace(System.err);
            System.exit(1);
        }

        // ACP 采用 Stdio JSON-RPC 长连接，进程必须持续存活以维持通信
        // StdioAcpAgentTransport 内部有自己的 I/O 线程处理 stdin/stdout
        // 这里用 CountDownLatch 阻塞主线程，保持 JVM 存活
        java.util.concurrent.CountDownLatch keepAlive = new java.util.concurrent.CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(keepAlive::countDown));
        try {
            keepAlive.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public AcpAsyncAgent createAgent(AcpAgentTransport transport) {
        return AcpAgent.async(transport)
                .requestTimeout(Duration.ofSeconds(60))
                .initializeHandler(req -> {
                    try {
                        return Mono.just(new AcpSchema.InitializeResponse(
                                1,
                                new AcpSchema.AgentCapabilities(true,
                                        new AcpSchema.McpCapabilities(true, true),
                                        new AcpSchema.PromptCapabilities(true, true, true)),
                                Arrays.asList()
                        ));
                    } catch (Throwable e) {
                        System.err.println("ACP initialize error: " + e.getMessage());
                        return Mono.error(e);
                    }
                })
                .newSessionHandler(req -> {
                    String sessionId = "acp-" + UUID.randomUUID().toString().substring(0, 8);
                    String cwd = req.cwd();

                    sessionStates.put(sessionId, new AcpSessionContext(cwd, req.mcpServers()));

                    return Mono.just(new AcpSchema.NewSessionResponse(sessionId, null, null));
                })
                .loadSessionHandler(req -> {
                    String sessionId = req.sessionId();
                    String cwd = req.cwd();

                    sessionStates.put(sessionId, new AcpSessionContext(cwd, req.mcpServers()));

                    return Mono.just(new AcpSchema.LoadSessionResponse(null, null));
                })
                .cancelHandler(req -> {
                    String sessionId = req.sessionId();
                    AcpSessionContext context = sessionStates.get(sessionId);
                    if (context != null) {
                        context.setCancelled(true);
                    }
                    return Mono.empty();
                })
                .promptHandler((request, acpContext) -> {
                    String sessionId = acpContext.getSessionId();
                    AcpSessionContext context = sessionStates.get(sessionId);

                    // 如果 session 尚未创建，返回错误而不是 NPE
                    if (context == null) {
                        return acpContext.sendMessage("Session not found: " + sessionId)
                                .thenReturn(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN));
                    }

                    // ACP 会话是长连接、跨多轮 prompt 复用的；每轮开始前清掉上一轮遗留的取消标记，
                    // 否则一旦某轮被 cancel，takeWhile 会让之后所有 prompt 立即空转。
                    context.setCancelled(false);

                    Prompt userInput = toPrompt(request);
                    AgentSession session = agentRuntime.getSession(sessionId);

                    // ACP 子进程是常驻进程，启动时加载的 settings 可能已过时：用户在 ACP 进程启动后
                    // 才在 Web/桌面端修改 acpModel、思考深度或新增模型时，若继续沿用启动时的旧配置，
                    // 会静默回退到 defaultModel（表现为"模型能正常调用、唯独 ACP 报 406/模型不对"），
                    // 或找不到新模型。故每轮 prompt 重新加载最新配置，并即时补注册缺失的模型。
                    final AgentSettings latestSettings = AgentSettings.loadFromFile();

                    // ACP 走独立子进程，没有前端会话态可选模型，改由「编码设置」里配置的 acpModel 决定；
                    // 留空则回退到 defaultModel。若一个模型都没配，返回 null，需在此
                    // 拦截并给出可读提示，而不是让 null 一路传到 ReActAgent.of(null) 抛 chatModel is required。
                    ChatModel chatModel = resolveChatModel(agentRuntime, latestSettings);

                    if (chatModel == null) {
                        return acpContext.sendMessage("未配置可用模型：请在 Gourd AI「设置 - 编码工具接入」中选择 ACP 使用的模型，或先在「设置 - 模型」中添加并启用一个模型。")
                                .thenReturn(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN));
                    }

                    // 供 lambda 引用（保持显式 final，强调跨线程读取的安全性）
                    final ChatModel finalChatModel = chatModel;

                    // 读取思考深度配置（确保 effectively final，供 lambda 引用）
                    final String acpThinkingDepth = latestSettings.getGeneral().getAcpThinkingDepth() != null
                            ? latestSettings.getGeneral().getAcpThinkingDepth() : "off";

                    final long startTime = System.currentTimeMillis();
                    final AtomicInteger toolCallCounter = new AtomicInteger(0);

                    return agentRuntime.prompt(userInput)
                            .session(session)
                            .options(o -> {
                                o.chatModel(finalChatModel);
                                if (Assert.isNotEmpty(context.getCwd())) {
                                    o.toolContextPut(HarnessEngine.ATTR_CWD, context.getCwd());
                                }
                                // 应用思考深度配置
                                final String modelStandard = finalChatModel.getStandardOrProvider();
                                ThinkingDepth.applyTo(o, modelStandard, acpThinkingDepth);
                            })
                            .stream()
                            .takeWhile(chunk -> !context.isCancelled())
                            .concatMap(chunk -> {
                                // === 规划阶段：映射到 ACP Plan 结构化输出 ===
                                if (chunk instanceof PlanChunk) {
                                    String content = chunk.getContent();
                                    AcpSchema.PlanEntry entry = new AcpSchema.PlanEntry(
                                            content != null ? content : "Planning...",
                                            AcpSchema.PlanEntryPriority.HIGH,
                                            AcpSchema.PlanEntryStatus.IN_PROGRESS
                                    );
                                    AcpSchema.Plan plan = new AcpSchema.Plan("plan", Collections.singletonList(entry));
                                    return acpContext.sendUpdate(sessionId, plan)
                                            .thenReturn(chunk);
                                }
                                // === 思考阶段 ===
                                else if (chunk instanceof ReasonChunk) {
                                    ReasonChunk reasonChunk = (ReasonChunk) chunk;
                                    if (chunk.hasContent() && !reasonChunk.isToolCalls()) {
                                        if (latestSettings.getGeneral().getCliThinkPrinted()) {
                                            return acpContext.sendThought(chunk.getContent())
                                                    .thenReturn(chunk);
                                        }
                                    }
                                }
                                // === ThoughtChunk（多任务并行） ===
                                else if (chunk instanceof ThoughtChunk) {
                                    ThoughtChunk thoughtChunk = (ThoughtChunk) chunk;
                                    if (thoughtChunk.hasMeta(TaskTalent.TOOL_MULTITASK)) {
                                        String content = thoughtChunk.getAssistantMessage().getResultContent();
                                        if (Assert.isNotEmpty(content)) {
                                            return acpContext.sendThought(content)
                                                    .thenReturn(chunk);
                                        }
                                    }
                                }
                                // === 工具执行阶段：映射到 ACP ToolCall 结构化输出 ===
                                else if (chunk instanceof ObservationChunk) {
                                    ObservationChunk observationChunk = (ObservationChunk) chunk;
                                    String toolName = observationChunk.getToolName();

                                    // 跳过内部任务分发工具（不向客户端展示）
                                    if (TaskTalent.TOOL_MULTITASK.equals(toolName) || TaskTalent.TOOL_TASK.equals(toolName)) {
                                        return Mono.just(chunk);
                                    }

                                    String toolCallId = "tc-" + toolCallCounter.incrementAndGet();
                                    String content = chunk.getContent();

                                    // 使用 ACP ToolCall 构建结构化工具调用通知
                                    AcpSchema.ToolCall toolCall = new AcpSchema.ToolCall(
                                            "tool_call",
                                            toolCallId,
                                            buildToolTitle(toolName, observationChunk.getArgs(), content),
                                            AcpSchema.ToolKind.EXECUTE,
                                            AcpSchema.ToolCallStatus.COMPLETED,
                                            Collections.emptyList(),
                                            Collections.emptyList(),
                                            observationChunk.getArgs(),   // rawInput
                                            content,                 // rawOutput
                                            null                     // meta
                                    );
                                    return acpContext.sendUpdate(sessionId, toolCall)
                                            .thenReturn(chunk);
                                }
                                // === 最终回复阶段 ===
                                else if (chunk instanceof ReActChunk) {
                                    String traceInfo = buildTraceInfo(((ReActChunk) chunk).getTrace(), startTime);

                                    String finalContent = chunk.getContent() + traceInfo;

                                    // 发送最终文本内容
                                    return acpContext.sendMessage(finalContent)
                                            .thenReturn(chunk);
                                }

                                return Mono.just(chunk);
                            })
                            .then(Mono.<AcpSchema.PromptResponse>just(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN)))
                            .onErrorResume(e -> Mono.just(new AcpSchema.PromptResponse(AcpSchema.StopReason.END_TURN)));
                })
                .build();
    }

    /**
     * 按「编码设置」解析 ACP 应使用的模型（acpModel 优先，留空回退 defaultModel）。
     *
     * <p>ACP 子进程常驻，启动时加载的模型集可能滞后于 settings.json：用户在 ACP 进程启动后
     * 才新增/修改的模型，运行时并未注册。若仅按运行时已注册模型查找，
     * 会静默回退到 defaultModel，表现为「模型明明配置且能正常调用，唯独 ACP 报 406/模型不对」。
     * 故每轮 prompt 以最新配置为准：acpModel 对应的模型存在且启用时，先注册（幂等覆盖）再取。</p>
     *
     * @param runtime  运行时引擎（承载已注册模型）
     * @param settings 最新加载的配置（每轮 prompt 重新 loadFromFile）
     * @return 对应 ChatModel；未配置可用模型时返回 null
     */
    public static ChatModel resolveChatModel(HarnessEngine runtime, AgentSettings settings) {
        String acpModel = resolveModelName(settings);

        if (Assert.isEmpty(acpModel)) {
            return null;
        }

        // 以最新配置为准（保鲜）：模型存在且启用则注册/刷新（addModel 按名覆盖，幂等）后取。
        // 这样用户在 ACP 进程启动后对模型的修改（apiKey/apiUrl/启停）也能即时生效。
        ModelDo modelDo = settings.getModels().get(acpModel);
        if (modelDo != null && modelDo.isEnabled()) {
            runtime.addModel(modelDo);
            return runtime.getModelOrMain(acpModel);
        }

        // 兜底：settings 中无此模型，但运行时已注册（配置合并边缘场景），沿用运行时实例
        return runtime.getModelOrMain(acpModel);
    }

    /**
     * 解析 ACP 应使用的模型名：acpModel 优先，留空回退 defaultModel；都没有则返回 null。
     */
    public static String resolveModelName(AgentSettings settings) {
        String acpModel = settings.getGeneral().getAcpModel();
        if (acpModel != null) {
            acpModel = acpModel.trim(); //历史配置可能残留空白值，避免按名查找失配
        }

        if (Assert.isEmpty(acpModel)) {
            acpModel = settings.getDefaultModel();
        }

        return acpModel;
    }

    /**
     * 构建工具调用的显示标题
     */
    private String buildToolTitle(String toolName, Map<String, Object> args, String content) {
        if (Assert.isEmpty(toolName)) {
            return content;
        }

        String argsStr = buildArgsStr(args);

        if (agentSettings.getGeneral().getCliPrintSimplified()) {
            // 简化模式：只显示工具名 + 结果摘要
            String summary;
            if (Assert.isEmpty(content)) {
                summary = "completed";
            } else {
                String[] lines = content.split("\n");
                if (lines.length > 1) {
                    summary = "returned " + lines.length + " lines";
                } else {
                    summary = content.length() > 40 ? content.substring(0, 37) + "..." : content;
                }
            }
            return toolName + ": " + summary;
        } else {
            // 全量模式：显示工具名 + 参数
            if (argsStr.length() > 100) {
                return toolName + "(" + argsStr.substring(0, 97) + "...)";
            }
            return toolName + "(" + argsStr + ")";
        }
    }

    /**
     * 构建 trace 统计信息（参考 WebStreamBuilder.getTraceInfo）
     */
    private String buildTraceInfo(ReActTrace trace, long startTime) {
        StringBuilder buf = new StringBuilder();
        buf.append("(");

        if (trace != null && trace.getMetrics() != null) {
            long inputTokens = trace.getMetrics().getPromptTokens();
            long outputTokens = trace.getMetrics().getCompletionTokens();

            buf.append("输入: ").append(formatTokens(inputTokens)).append(" tokens");
            buf.append(", 输出: ").append(formatTokens(outputTokens)).append(" tokens");
        }

        long seconds = Duration.ofMillis(System.currentTimeMillis() - startTime).getSeconds();
        if (buf.length() > 1) buf.append(", ");
        buf.append("耗时: ").append(formatTime(seconds));

        buf.append(")");
        return buf.toString();
    }

    private String formatTokens(long n) {
        if (n >= 1_000_000) {
            return String.format("%.1fM", n / 1_000_000.0).replaceAll("\\.0", "");
        } else if (n >= 1_000) {
            return String.format("%.1fK", n / 1_000.0).replaceAll("\\.0", "");
        }
        return String.valueOf(n);
    }

    private String formatTime(long seconds) {
        if (seconds >= 60) {
            long mins = seconds / 60;
            long secs = seconds % 60;
            return secs > 0 ? mins + "min " + secs + "s" : mins + "min";
        }
        return seconds + "s";
    }

    private String buildArgsStr(Map<String, Object> args) {
        if (args == null || args.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        args.forEach((k, v) -> {
            if (sb.length() > 0) sb.append(" ");
            sb.append(k).append("=").append(v);
        });
        return sb.toString().replace("\n", " ");
    }

    public Prompt toPrompt(AcpSchema.PromptRequest promptRequest) {
        Prompt prompt = Prompt.of();

        Contents contents = new Contents();

        for (AcpSchema.ContentBlock cp : promptRequest.prompt()) {
            if (cp instanceof AcpSchema.TextContent) {
                AcpSchema.TextContent text = (AcpSchema.TextContent) cp;
                contents.addBlock(TextBlock.of(text.text()));
            } else if (cp instanceof AcpSchema.ImageContent) {
                AcpSchema.ImageContent image = (AcpSchema.ImageContent) cp;
                if (Assert.isEmpty(image.uri())) {
                    contents.addBlock(ImageBlock.ofBase64(image.data(), image.mimeType()));
                } else {
                    contents.addBlock(ImageBlock.ofUrl(image.uri(), image.mimeType()));
                }
            }
        }

        return prompt.addMessage(ChatMessage.ofUser(contents));
    }

    public static class AcpSessionContext {
        private final String cwd;
        private final List<AcpSchema.McpServer> mcpServers;
        private volatile boolean cancelled;

        public AcpSessionContext(String cwd, List<AcpSchema.McpServer> mcpServers) {
            this.cwd = cwd;
            this.mcpServers = mcpServers;
        }

        public String getCwd() {
            return cwd;
        }

        public List<AcpSchema.McpServer> getMcpServers() {
            return mcpServers;
        }

        public boolean isCancelled() {
            return cancelled;
        }

        public void setCancelled(boolean cancelled) {
            this.cancelled = cancelled;
        }
    }
}
