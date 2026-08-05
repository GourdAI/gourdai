package com.gourdai;

import com.agentclientprotocol.sdk.agent.transport.StdioAcpAgentTransport;
import com.agentclientprotocol.sdk.spec.AcpAgentTransport;
import com.gourdai.core.command.builtin.*;
import com.gourdai.core.portal.WorkspaceWatcher;
import com.gourdai.core.portal.web.*;
import org.noear.solon.Solon;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.AgentSessionProvider;
import com.gourdai.agent.session.FileAgentSession;
import org.noear.solon.ai.chat.CacheControl;
import com.gourdai.harness.HarnessEngine;
import com.gourdai.harness.HarnessExtension;
import org.noear.solon.ai.talents.mount.MountDir;
import org.noear.solon.ai.talents.mount.MountType;
import org.noear.solon.annotation.Bean;
import org.noear.solon.annotation.Configuration;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import com.gourdai.core.config.AgentFlags;
import com.gourdai.core.channel.Channel;
import com.gourdai.core.config.AgentSettings;
import com.gourdai.core.config.ManagerExtension;
import com.gourdai.core.config.entity.ApiSourceDo;
import com.gourdai.core.config.entity.McpServerDo;
import com.gourdai.core.config.entity.ModelDo;
import com.gourdai.core.config.entity.LspServerDo;
import com.gourdai.core.config.entity.MountDo;
import com.gourdai.core.memory.MemoryProvider;
import com.gourdai.core.portal.acp.AcpLink;
import com.gourdai.core.portal.cli.CliShell;
import com.gourdai.core.portal.desktop.WsController;
import com.gourdai.core.portal.desktop.WsGate;
import com.gourdai.core.portal.desktop.provider.ModelProviderFactory;
import org.noear.solon.core.AppContext;
import org.noear.solon.core.BeanWrap;
import org.noear.solon.core.util.JavaUtil;
import org.noear.solon.core.util.RunUtil;
import org.noear.solon.net.websocket.WebSocketRouter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 *
 * @author oisin
 *
 */
@Configuration
public class Configurator {
    private static final Logger LOG = LoggerFactory.getLogger(Configurator.class);

    @Inject
    AppContext appContext;

    @Inject
    HarnessEngine agentRuntime;

    @Inject
    AgentSettings agentSettings;

    @Inject
    ModelProviderFactory modelProviderFactory;

    private LoopScheduler loopScheduler;

    /** 会话目录定位器：统一解析 chat（全局）/ code（项目）会话的落盘位置 */
    private SessionLocator sessionLocator;

    @Bean
    public HarnessEngine agentRuntime(AgentSettings settings) throws Exception {
        String workspace = AgentFlags.getUserDir();
        Map<String, AgentSession> sessionMap = new ConcurrentHashMap<>();

        // 会话目录定位器：chat（web-）落安装目录 .gourdai/sessions/（全局、固定不变），
        // code（code-）落所选项目 <root>/.gourdai/sessions/
        this.sessionLocator = new SessionLocator(workspace, AgentFlags.getHarnessSessions());
        final SessionLocator locator = this.sessionLocator;

        // 按会话模式解析落盘目录（旧版 web- 会话就地回退，避免历史丢失）
        AgentSessionProvider sessionProvider = new AgentSessionProvider() {
            @Override
            public AgentSession getSession(String sessionId) {
                return sessionMap.computeIfAbsent(sessionId, key ->
                        new FileAgentSession(key, locator.resolveDir(key).toString()));
            }

            @Override
            public void removeSession(String sessionId) {
                AgentSession removed = sessionMap.remove(sessionId);
                if (removed instanceof FileAgentSession) {
                    // 清理内存缓存（并删除已落盘的 messages/snapshot 文件），
                    // 切断后续持久化重建目录的可能
                    ((FileAgentSession) removed).clear();
                }
            }
        };

        HarnessEngine engine = HarnessEngine.of(workspace, AgentFlags.getHarnessHome())
                .userAgent(settings.getGeneral().getUserAgent())
                .systemPrompt(AgentFlags.getAgentsMd())
                .maxTurns(settings.getGeneral().getMaxTurns())
                .autoRethink(settings.getGeneral().getAutoRethink())
                .sessionProvider(sessionProvider)
                // 历史窗口大小用于保留窗口兜底（minReservedMessages = maxMessages / 3），
                // 第二个参数 maxTokens 不参与触发判据，仅作为极端场景的兜底基准
                .compressionThreshold(settings.getGeneral().getHistoryWindowSize(), null)
                .compressionRatio(settings.getGeneral().getCompressionRatio())
                .compressionModel(settings.getGeneral().getSummaryModel())
                .memoryEnabled(settings.getGeneral().getMemoryEnabled())
                .memoryProvider(new MemoryProvider(agentSettings))
                .sandboxEnabled(settings.getGeneral().getSandboxMode())
                .sandboxAllowUserHome(settings.getGeneral().getSandboxAllowUserHome())
                .sandboxSystemRestrict(settings.getGeneral().getSandboxSystemRestrict())
                .bashAsyncEnabled(settings.getGeneral().getBashAsyncEnabled())
                .parallelToolEnabled(settings.getGeneral().getParallelToolEnabled())
                .subagentEnabled(settings.getGeneral().getSubagentEnabled())
                .hitlEnabled(settings.getGeneral().getHitlEnabled())
                .apiRetries(settings.getGeneral().getApiRetries())
                .modelRetries(settings.getGeneral().getModelRetries())
                .mcpRetries(settings.getGeneral().getModelRetries())
                .toolsAdd(settings.getPermission().getTools())
                .disallowedToolsAdd(settings.getPermission().getDisallowedTools())
                .cacheControl(CacheControl.ofEphemeral())
                .build();


        // Gemini 思考深度补丁：以更高优先级注册，修复上游 generateContent 丢弃 thinkingConfig 的问题
        org.noear.solon.ai.chat.dialect.ChatDialectManager.register(
                new GeminiThinkingChatDialect(), -1);

        engine.setDefaultModel(settings.getDefaultModel());
        for (ModelDo model : agentSettings.getModels().values()) {
            engine.addModel(model);
        }

        for (Map.Entry<String, MountDo> entry : agentSettings.getMountPools().entrySet()) {
            MountDo mount = entry.getValue();
            engine.addMount(MountDir.builder()
                    .alias(entry.getKey())
                    .description(mount.getDescription())
                    .type(mount.getType())
                    .path(mount.getPath())
                    .primary(mount.isPrimary())
                    .enabled(mount.isEnabled())
                    .writeable(mount.isWriteable())
                    .build());
        }

        // 全局区技能/子代理：统一落安装目录（与工作区同基准，不再指向用户主目录）。
        // 保留 @global-* 别名（UI/提示词/测试均按别名引用），仅把物理路径改到安装目录。
        String globalBase = AgentFlags.getHarnessBase();
        engine.addMount(MountDir.builder().alias("@global-skills").type(MountType.SKILLS).path(Paths.get(globalBase, engine.getHarnessSkills()).toString()).primary(true).build());
        engine.addMount(MountDir.builder().alias("@workspace-skills").type(MountType.SKILLS).path("./" + engine.getHarnessSkills()).primary(true).build());

        engine.addMount(MountDir.builder().alias("@global-agents").type(MountType.AGENTS).path(Paths.get(globalBase, engine.getHarnessAgents()).toString()).primary(true).build());
        engine.addMount(MountDir.builder().alias("@workspace-agents").type(MountType.AGENTS).path("./" + engine.getHarnessAgents()).primary(true).build());


        engine.getCommandRegistry().load(Paths.get(AgentFlags.getHarnessBase(), engine.getHarnessCommands()));
        engine.getCommandRegistry().load(Paths.get(workspace, engine.getHarnessCommands()));

        engine.getCommandRegistry().register(new ExitCommand());
        engine.getCommandRegistry().register(new ClearCommand());
        engine.getCommandRegistry().register(new ContinueCommand());
        engine.getCommandRegistry().register(new RerunCommand());
        engine.getCommandRegistry().register(new RewindCommand());
        engine.getCommandRegistry().register(new ModelCommand());

        engine.getLspTalent().setEnabled(settings.getGeneral().getLspEnabled());

        // ACP 模式下不加载 MCP/OpenAPI/LSP 服务器，避免子进程 Stdio 竞争
        if (!isAcpMode()) {
            RunUtil.async(() -> addServers(engine));
        }

        // loop scheduler
        this.loopScheduler = new LoopScheduler(engine, AgentFlags.getHarnessLoopWorktrees());
        engine.getCommandRegistry().register(new LoopCommand(loopScheduler));


        engine.addExtension(new ManagerExtension(engine, agentSettings));

        return engine;
    }

    private void addServers(HarnessEngine engine){
        for (Map.Entry<String, McpServerDo> entry : agentSettings.getMcpServers().entrySet()) {
            engine.addMcpServer(entry.getKey(), entry.getValue());
        }

        for (Map.Entry<String, ApiSourceDo> entry : agentSettings.getApiServers().entrySet()) {
            engine.addApiServer(entry.getValue());
        }

        for (Map.Entry<String, LspServerDo> entry : agentSettings.getLspServers().entrySet()) {
            engine.addLspServer(entry.getKey(), entry.getValue());
        }

        //系统级 LSP 服务器（参考 OpenCode / Claude Code 内置列表，仅注册常见语言）
        addSystemLspServer(engine, agentSettings, "java", Arrays.asList("jdtls"), Arrays.asList(".java"));
        addSystemLspServer(engine, agentSettings, "typescript", Arrays.asList("typescript-language-server", "--stdio"), Arrays.asList(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"));
        addSystemLspServer(engine, agentSettings, "go", Arrays.asList("gopls"), Arrays.asList(".go"));
        addSystemLspServer(engine, agentSettings, "python", Arrays.asList("pyright-langserver", "--stdio"), Arrays.asList(".py", ".pyi"));
        addSystemLspServer(engine, agentSettings, "rust", Arrays.asList("rust-analyzer"), Arrays.asList(".rs"));
        addSystemLspServer(engine, agentSettings, "c-cpp", Arrays.asList("clangd", "--background-index", "--clang-tidy"), Arrays.asList(".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx", ".c++", ".h++", ".hh"));
        addSystemLspServer(engine, agentSettings, "csharp", Arrays.asList("roslyn-language-server", "--stdio", "--autoLoadProjects"), Arrays.asList(".cs", ".csx"));
        addSystemLspServer(engine, agentSettings, "ruby", Arrays.asList("solargraph", "stdio"), Arrays.asList(".rb", ".rake", ".gemspec", ".ru"));
        addSystemLspServer(engine, agentSettings, "php", Arrays.asList("intelephense", "--stdio"), Arrays.asList(".php"));
        addSystemLspServer(engine, agentSettings, "bash", Arrays.asList("bash-language-server", "start"), Arrays.asList(".sh", ".bash", ".zsh", ".ksh"));
        addSystemLspServer(engine, agentSettings, "lua", Arrays.asList("lua-language-server"), Arrays.asList(".lua"));
        addSystemLspServer(engine, agentSettings, "dart", Arrays.asList("dart", "language-server", "--lsp"), Arrays.asList(".dart"));
        addSystemLspServer(engine, agentSettings, "swift", Arrays.asList("sourcekit-lsp"), Arrays.asList(".swift", ".objc", ".objcpp"));
        addSystemLspServer(engine, agentSettings, "kotlin", Arrays.asList("kotlin-language-server"), Arrays.asList(".kt", ".kts"));
        addSystemLspServer(engine, agentSettings, "yaml", Arrays.asList("yaml-language-server", "--stdio"), Arrays.asList(".yaml", ".yml"));

    }

    @Init
    public void init() {
        //订阅容器扩展
        appContext.subBeansOfType(HarnessExtension.class, extension -> {
            agentRuntime.addExtension(extension);
        });


        // ACP 模式下跳过 CliShell 构造（避免初始化 JLine 终端等不必要的组件）
        CliShell cliShell = isAcpMode() ? null : new CliShell(agentRuntime, agentSettings, loopScheduler);
        String flag = Solon.cfg().argx().flagAt(0);

        if (AgentFlags.FLAG_VERSION.equals(flag)) {
            System.out.println(Solon.cfg().appTitle() + " " + AgentFlags.getVersion());
            return;
        }

        // ACP 模式通过 Stdio JSON-RPC 与编辑器通信，System.out 必须保持纯净，
        // 任何非 JSON 输出都会破坏协议流导致握手失败。
        if (!AgentFlags.FLAG_ACP.equals(flag)) {
            checkUpdate();
        }

        //flag
        if (Solon.cfg().argx().flags().size() > 0) {
            if (AgentFlags.FLAG_RUN.equals(flag)) { // java -jar gourdai.jar run '你好' // gourdai run '你好'
                //单次任务态
                String prompt = Solon.cfg().argx().flagAt(1);
                new CliShell(agentRuntime, agentSettings, null).call(prompt);
                Solon.stop();
                return;
            }

            if (AgentFlags.FLAG_SERVE.equals(flag)) { // java -jar gourdai.jar server // gourdai server
                runServe(agentRuntime, agentSettings, cliShell);
                return;
            }

            if (AgentFlags.FLAG_WEB.equals(flag)) { // java -jar gourdai.jar web // gourdai web
                runWeb(agentRuntime, agentSettings, cliShell);
                return;
            }

            if (AgentFlags.FLAG_ACP.equals(flag)) { // java -jar gourdai.jar acp // gourdai acp
                runAcp(agentRuntime, agentSettings, cliShell);
                return;
            }

            //未来可以支持更多控制标记
        }

        if (AgentFlags.FLAG_SERVE.equals(flag)) { // java -jar gourdai.jar server // gourdai server
            runServe(agentRuntime, agentSettings, cliShell);
            return;
        }

        if (AgentFlags.FLAG_ACP.equals(flag)) { // java -jar gourdai.jar acp // gourdai acp
            runAcp(agentRuntime, agentSettings, cliShell);
            return;
        }

        if (AgentFlags.FLAG_CLI.equals(flag)) { // java -jar gourdai.jar cli // gourdai cli
            new Thread(cliShell, "CLI-Interactive-Thread").start();
            return;
        }

        //web - default
        runWeb(agentRuntime, agentSettings, cliShell);
    }

    private void checkUpdate() {
        // 更新检测要请求 www.gourd-ai.cn（失败/慢时约 1~2s），放到后台守护线程执行，
        // 不阻塞应用启动（尤其桌面端冷启动直接影响 UI 首屏可用时间）。
        // 仅打印一条“发现新版本”的提示，晚一点出现无妨。
        Thread t = new Thread(() -> {
            try {
                if (AgentFlags.checkUpdate()) {
                    // 使用颜色代码让提示更醒目
                    System.out.println("\033[33mDiscover the new version: " + AgentFlags.getLastVersion() + "\033[0m");

                    if (JavaUtil.IS_WINDOWS) {
                        System.out.println("Update: \033[36mirm https://www.gourd-ai.cn/setup.ps1 | iex\033[0m");
                    } else {
                        System.out.println("Update: \033[36mcurl -fsSL https://www.gourd-ai.cn/setup.sh | bash\033[0m");
                    }
                    System.out.println();
                }
            } catch (Throwable e) {
                // 忽略：更新检测不影响主流程
            }
        }, "update-check");
        t.setDaemon(true);
        t.start();
    }

    private void runServe(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        //serve ws gate
        WebSocketRouter.getInstance().of("/ws", new WsGate(agentRuntime, settings));

        //serve web controller
        BeanWrap webBean = Solon.context().wrapAndPut(WsController.class, new WsController(agentRuntime, modelProviderFactory));
        Solon.app().router().add(webBean);

        //注册第三方渠道（HTTP 端点 + 后台线程）
        WebGate webGate = new WebGate(agentRuntime);
        webGate.setSessionLocator(sessionLocator);
        webGate.setStreamStore(new SessionStreamStore(sessionLocator));
        WebStreamBuilder streamBuilder = new WebStreamBuilder(agentRuntime);
        WebChannel webChannel = new WebChannel(agentRuntime, webGate, sessionLocator, new ProjectService());
        // 将渠道绑定到 streamBuilder，使 IM 回复能同步
        for (Channel ch : Collections.singletonList(webChannel.getWeChatLink())) {
            streamBuilder.bind(ch);
        }
        streamBuilder.bind(webChannel.getFeishuLink());
        streamBuilder.bind(webChannel.getDingTalkLink());
        BeanWrap channelBean = Solon.context().wrapAndPut(WebChannel.class, webChannel);
        Solon.app().router().add(channelBean);
        RunUtil.async(webChannel);

        // 将远控通道注入定时任务调度器，支持自动推送
        loopScheduler.setChannels(Arrays.asList(
                webChannel.getWeChatLink(),
                webChannel.getFeishuLink(),
                webChannel.getDingTalkLink()));
        loopScheduler.setRoutingTable(webChannel.getRoutingTable());

        // 恢复全局定时任务
        loopScheduler.restore(null, agentRuntime.getWorkspace(), agentRuntime.getHarnessSessions());

        //settings controller
        WebSettingsController settingsController = new WebSettingsController(agentRuntime, settings);
        BeanWrap webSettingsController = Solon.context().wrapAndPut(WebSettingsController.class, settingsController);
        Solon.app().router().add(webSettingsController);

        cliShell.printWelcome("Server port: " + Solon.cfg().serverPort());
    }


    private void runWeb(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        //web ws gate
        WebGate webGate = new WebGate(agentRuntime);
        webGate.setSessionLocator(sessionLocator);
        SessionStreamStore streamStore = new SessionStreamStore(sessionLocator);
        webGate.setStreamStore(streamStore);
        WebSocketRouter.getInstance().of("/web/gate", webGate);

        //code 模式本地终端网关
        WebSocketRouter.getInstance().of("/web/terminal", new TerminalGate(agentRuntime.getWorkspace()));

        //web
        BeanWrap webController = Solon.context().wrapAndPut(WebController.class, new WebController(agentRuntime, webGate, loopScheduler, sessionLocator));
        Solon.app().router().add(webController);

        WebSettingsController settingsController = new WebSettingsController(agentRuntime, settings);
        BeanWrap webSettingsController = Solon.context().wrapAndPut(WebSettingsController.class, settingsController);
        Solon.app().router().add(webSettingsController);

        WebChannel webChannelInst = new WebChannel(agentRuntime, webGate, sessionLocator, new ProjectService());
        BeanWrap webChannel = Solon.context().wrapAndPut(WebChannel.class, webChannelInst);
        Solon.app().router().add(webChannel);

        // 将远控通道注入定时任务调度器，支持自动推送
        loopScheduler.setChannels(Arrays.asList(
                webChannelInst.getWeChatLink(),
                webChannelInst.getFeishuLink(),
                webChannelInst.getDingTalkLink()));
        loopScheduler.setRoutingTable(webChannelInst.getRoutingTable());

        // 恢复全局定时任务
        loopScheduler.restore(null, agentRuntime.getWorkspace(), agentRuntime.getHarnessSessions());

        // 启动微信通道
        RunUtil.async((Runnable) webChannel.get());

        // 启动工作区文件变化监听
        try {
            Path workspacePath = Paths.get(agentRuntime.getWorkspace()).toAbsolutePath().normalize();
            WorkspaceWatcher workspaceWatcher = new WorkspaceWatcher(workspacePath);
            workspaceWatcher.addBroadcastHandler(webGate::broadcastRaw);
            workspaceWatcher.start();
        } catch (Exception e) {
            // watcher 启动失败不影响主流程
        }

        if (cliShell == null) {
            return;
        }

//        String url = "http://localhost:" + Solon.cfg().serverPort() + "/";
//        cliShell.printWelcome("Web interface: " + url);
    }


    private void runAcp(HarnessEngine agentRuntime, AgentSettings settings, CliShell cliShell) {
        AcpAgentTransport agentTransport = new StdioAcpAgentTransport();

        new AcpLink(agentRuntime, agentTransport, settings).run();

//        if (cliShell == null) {
//            return;
//        }

        //不能有打印
        //cliShell.printWelcome("Acp interface: stdio");
    }

    /**
     * 添加系统级 LSP 服务器（如果用户未自定义同名配置，则注册）
     */
    private void addSystemLspServer(HarnessEngine engine, AgentSettings settings, String name, List<String> command, List<String> extensions) {
        // 如果用户已自定义同名配置，跳过系统级注册
        if (settings.getLspServers().containsKey(name)) {
            return;
        }

        LspServerDo lspServer = new LspServerDo();
        lspServer.setCommand(command);
        lspServer.setExtensions(extensions);
        lspServer.setEnabled(false); // 默认禁用，用户按需启用
        lspServer.setScope(AgentFlags.SCOPE_LOCAL);

        // 注册到引擎（不启用不会真正加载，仅作为可选项）
        engine.addLspServer(name, lspServer);

        // 同步到 settings 以便前端展示
        settings.getLspServers().put(name, lspServer);
    }

    /** 检测当前是否为 ACP Stdio 模式 */
    private boolean isAcpMode() {
        String flag = Solon.cfg().argx().flagAt(0);
        return AgentFlags.FLAG_ACP.equals(flag);
    }
}