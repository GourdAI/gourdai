package com.gourdai.core.portal;

import org.noear.snack4.ONode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;

import static java.nio.file.StandardWatchEventKinds.*;

/**
 * 工作区文件变化监听器
 *
 * <p>基于 JDK {@link WatchService} 监控工作区目录树的新增、删除、修改事件，
 * 经去重防抖后，通过注册的广播处理器将 {@code filer_change} 事件推送到前端，
 * 实现文件树的实时同步。</p>
 *
 * <h3>核心流程</h3>
 * <pre>
 *   磁盘文件变化 → WatchService 捕获 → changedPaths 汇聚
 *       → flushChanges() 去重防抖 → ONode 构建 JSON → 广播处理器分发
 * </pre>
 *
 * <h3>注意事项</h3>
 * <ul>
 *   <li>自动排除 .git、node_modules、target 等无关目录（点前缀文件正常监听）</li>
 *   <li>新增目录时自动注册监听，覆盖子树</li>
 *   <li>使用守护线程，随主进程退出</li>
 * </ul>
 */
public class WorkspaceWatcher {
    private static final Logger LOG = LoggerFactory.getLogger(WorkspaceWatcher.class);

    /** 需要排除的目录名（不监听、不同步）；与 FileService 的排除清单保持一致 */
    private static final Set<String> EXCLUDED_DIRS = new HashSet<>(Arrays.asList(
            // 项目元数据 & IDE
            ".gourdai", ".claude", ".opencode",
            ".idea", ".vscode", ".settings",
            // 版本控制 & 构建工具
            ".git", ".gradle", ".mvn",
            // 运行时缓存
            ".pytest_cache", "__pycache__",
            ".DS_Store",
            // 依赖目录
            "node_modules", "venv", "vendor",
            // 构建输出
            "target", "build"
    ));

    /** 监听根路径集合（启动工作区 + 动态登记的 Code 项目根） */
    private final Set<Path> roots = ConcurrentHashMap.newKeySet();
    /** start() 是否已完成目录树登记（之后 addRoot 需即时注册） */
    private volatile boolean started = false;
    /** start() 初始化是否失败（WatchService 不可用时 addRoot 仅登记不提交任务） */
    private volatile boolean initFailed = false;
    /** 广播处理器列表：接收 JSON 字符串并分发到前端 */
    private final List<Consumer<String>> broadcastHandlers = new ArrayList<>();
    private WatchService watchService;
    private ScheduledExecutorService scheduler;

    /** 待推送的变更路径集合（去重、线程安全） */
    private final Set<String> changedPaths = ConcurrentHashMap.newKeySet();

    /**
     * @param workspace 工作区根目录
     */
    public WorkspaceWatcher(Path workspace) {
        if (workspace != null) {
            this.roots.add(workspace.toAbsolutePath().normalize());
        }
    }

    /**
     * 动态添加监听根（如 Code 模式当前选择的项目目录）。
     *
     * <p>可在 {@link #start()} 前后任意时刻调用：未启动时仅登记；
     * 已启动则异步注册新根的目录树到 WatchService。</p>
     *
     * @param root 新的监听根目录，null 忽略
     */
    public void addRoot(Path root) {
        if (root == null) return;
        Path normalized = root.toAbsolutePath().normalize();
        if (!roots.add(normalized)) return;
        // WatchService 不可用（未启动或初始化失败）：仅登记到 roots，避免提交空转任务
        if (scheduler == null || initFailed) return;
        if (started) {
            scheduler.submit(() -> {
                try {
                    registerTree(normalized);
                    LOG.info("[WorkspaceWatcher] added root: {}", normalized);
                } catch (Exception e) {
                    LOG.error("[WorkspaceWatcher] add root failed: {}", e.getMessage(), e);
                }
            });
        }
    }

    /**
     * 注册广播处理器，用于将变更事件推送到前端
     *
     * @param handler 接收 JSON 字符串的消费者
     */
    public WorkspaceWatcher addBroadcastHandler(Consumer<String> handler) {
        this.broadcastHandlers.add(handler);
        return this;
    }

    /**
     * 启动文件监听：初始化 WatchService、异步注册工作区目录树、开启轮询线程
     *
     * <p>目录树注册（{@link #registerTree}）可能在大工作区下耗时较长，
     * 因此放在独立守护线程中执行，避免阻塞主线程。</p>
     */
    public void start() {
        try {
            watchService = FileSystems.getDefault().newWatchService();
            scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "workspace-watcher");
                t.setDaemon(true);
                return t;
            });

            // 异步执行目录树注册，避免阻塞主线程（特别是工作区为用户主目录等大目录时）
            Thread initThread = new Thread(() -> {
                try {
                    for (Path root : roots) {
                        registerTree(root);
                    }
                    started = true;
                    scheduler.submit(WorkspaceWatcher.this::pollEvents);
                    LOG.info("[WorkspaceWatcher] started for: {}", roots);
                } catch (Exception e) {
                    initFailed = true;
                    LOG.error("[WorkspaceWatcher] start failed: {}", e.getMessage(), e);
                }
            }, "workspace-watcher-init");
            initThread.setDaemon(true);
            initThread.start();

        } catch (Exception e) {
            LOG.error("[WorkspaceWatcher] start failed: {}", e.getMessage(), e);
        }
    }

    /**
     * 停止监听：关闭调度器和 WatchService
     */
    public void stop() {
        try {
            if (scheduler != null) scheduler.shutdownNow();
            if (watchService != null) watchService.close();
        } catch (Exception e) {
            LOG.warn("[WorkspaceWatcher] stop error: {}", e.getMessage());
        }
    }

    /**
     * 递归注册目录树到 WatchService（排除无关目录）
     */
    private void registerTree(Path dir) throws Exception {
        Files.walkFileTree(dir, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes attrs) {
                String name = d.getFileName() != null ? d.getFileName().toString() : "";
                // 仅按排除清单跳过（不再一刀切忽略点前缀目录，保证 .github 等可见目录可被监听）
                if (EXCLUDED_DIRS.contains(name)) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                try {
                    d.register(watchService, ENTRY_CREATE, ENTRY_DELETE, ENTRY_MODIFY);
                } catch (Exception ignored) {
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /**
     * 轮询 WatchService 事件，捕获文件变更并触发防抖推送
     */
    private void pollEvents() {
        try {
            while (!Thread.currentThread().isInterrupted()) {
                WatchKey key = watchService.take();
                Path dir = (Path) key.watchable();

                for (WatchEvent<?> event : key.pollEvents()) {
                    Path fullPath = dir.resolve((Path) event.context());

                    if (shouldIgnore(fullPath)) continue;

                    String relativePath = relativizeAny(fullPath).toString().replace('\\', '/');
                    changedPaths.add(relativePath);

                    if (event.kind() == ENTRY_CREATE && fullPath.toFile().isDirectory()) {
                        try {
                            fullPath.register(watchService, ENTRY_CREATE, ENTRY_DELETE, ENTRY_MODIFY);
                        } catch (Exception ignored) {
                        }
                    }
                }

                key.reset();
                flushChanges();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            LOG.error("[WorkspaceWatcher] poll error: {}", e.getMessage());
        }
    }

    /**
     * 判断路径是否应忽略（排除目录下的文件；点前缀文件不忽略，与文件树展示规则一致）
     */
    private boolean shouldIgnore(Path path) {
        for (Path segment : relativizeAny(path)) {
            String name = segment.toString();
            if (EXCLUDED_DIRS.contains(name)) return true;
        }
        return false;
    }

    /** 计算路径相对其所属监听根的相对路径（变更事件可能来自任意根；根嵌套时取最长前缀，保证相对路径最短且无歧义） */
    private Path relativizeAny(Path path) {
        Path best = null;
        for (Path root : roots) {
            if (path.startsWith(root) && (best == null || root.getNameCount() > best.getNameCount())) {
                best = root;
            }
        }
        if (best != null) return best.relativize(path);
        return path.getFileName() != null ? path.getFileName() : path;
    }


    /**
     * 将累积的变更路径构建为 JSON 并广播到所有处理器
     *
     * <p>JSON 格式：
     * <pre>{
     *   "type": "filer_change",
     *   "changes": ["src/Foo.java", "lib/README.md"],
     *   "createdAt": 1716153600000
     * }</pre></p>
     */
    private void flushChanges() {
        if (changedPaths.isEmpty()) return;

        Set<String> batch = new LinkedHashSet<>(changedPaths);
        changedPaths.clear();

        ONode changes = new ONode().asArray();
        for (String p : batch) {
            changes.add(p);
        }

        String json = new ONode()
                .set("type", "filer_change")
                .set("changes", changes)
                .set("createdAt", System.currentTimeMillis())
                .toJson();

        for (Consumer<String> handler : broadcastHandlers) {
            handler.accept(json);
        }

        if (LOG.isDebugEnabled()) {
            LOG.debug("[WorkspaceWatcher] pushed {} changes", batch.size());
        }
    }
}