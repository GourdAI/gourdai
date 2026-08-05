package com.gourdai.core.config;

import org.noear.snack4.ONode;
import org.noear.solon.core.util.DateUtil;
import org.noear.solon.core.util.IoUtil;
import org.noear.solon.net.http.HttpUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Date;

/**
 *
 * @author oisin
 *
 */
public class AgentFlags {
    private final static Logger LOG = LoggerFactory.getLogger(AgentFlags.class);
    public final static String NAME_CONFIG_YML = "config.yml";
    public final static String NAME_SETTINGS_JSON = "settings.json";
    public final static String NAME_AGENTS_MD = "AGENTS.md";

    public final static String X_SESSION_ID = "X-Session-Id";
    public final static String X_SESSION_CWD = "X-Session-Cwd";

    public final static String FLAG_VERSION = "version";

    public final static String FLAG_RUN = "run";
    public final static String FLAG_SERVE = "serve";
    public final static String FLAG_ACP = "acp";
    public final static String FLAG_WEB = "web";
    public final static String FLAG_CLI = "cli";

    public final static String SCOPE_USER = "user"; //作用域：用户（用局）
    public final static String SCOPE_LOCAL = "workspace"; //作用域：本地

    public static String getVersion() {
        return "v2026.6.21";
    }

    private static String lastVersion;

    public static String getLastVersion() {
        if (lastVersion == null) {
            try {
                String json = HttpUtils.http("https://www.gourd-ai.cn/info.json")
                        .timeout(2)
                        .get();

                lastVersion = ONode.ofJson(json).get("cli_version").getValueAs();
            } catch (Throwable e) {
                LOG.warn("Update detection failed: {}", e.getMessage());
            }
        }

        return lastVersion;
    }


    public static boolean checkUpdate() {
        String tmp = getLastVersion();
        if (tmp != null) {
            Date lastDate = DateUtil.parseTry(tmp.substring(1));
            Date currDate = DateUtil.parseTry(getVersion().substring(1));

            if (lastDate != null && currDate != null) {
                if (lastDate.getTime() > currDate.getTime()) {
                    return true;
                }
            }
        }

        return false;
    }

    //------------------

    //马具目录
    private static final String harnessHome = ".gourdai/";

    /**
     * 当前目录（进程工作目录 user.dir）。
     * <p>桌面端由 backend.js 以 {@code cwd=安装资源目录} 拉起后端，故此值即“安装目录”。</p>
     */
    public static String getUserDir() {
        return System.getProperty("user.dir");
    }

    /**
     * 用户主目录（操作系统真实 HOME）。
     * <p>仅用于“目录选择器起点/默认父目录、向前端回报 homeDir、沙箱主目录判定”等
     * <b>确需操作系统 HOME 语义</b>的场景；<b>不再</b>作为 {@code .gourdai} 全局区的落盘根。</p>
     */
    public static String getUserHome() {
        return System.getProperty("user.home");
    }

    /**
     * 马具全局区落盘根（<b>安装目录</b>，与进程当前工作目录解耦）。
     *
     * <p>解析顺序：系统属性 {@code -Dgourdai.home} → 环境变量 {@code GOURDAI_HOME} →
     * 回退 {@code user.dir}。</p>
     *
     * <p>桌面端由 {@code backend.js} 以 {@code cwd=安装资源目录} 拉起 web 后端，二者恰好一致；
     * 但 <b>ACP 子进程</b>由编辑器从<b>工作区</b>拉起（{@code cwd=工作区}），若仍用 {@code user.dir}
     * 会把全局区错误地指向工作区，导致读不到全局模型配置。故桌面端在拉起 Java 时统一注入
     * {@code -Dgourdai.home=<安装目录>}，使 web/桌面/CLI/ACP 四种入口解析到同一份全局配置。
     * 纯 CLI 安装（无注入）时回退 {@code user.dir}，行为与历史一致。</p>
     *
     * <p>注意：全局区仅承载<b>配置/技能/子代理/命令/扩展</b>等跨工作区不变的数据；
     * <b>会话、工作区记忆、channel 凭据</b>等随工作区走的数据走 {@link #getUserDir()}，不经此方法。</p>
     */
    public static String getHarnessBase() {
        String home = System.getProperty("gourdai.home");
        if (home == null || home.isEmpty()) {
            home = System.getenv("GOURDAI_HOME");
        }
        if (home != null && !home.isEmpty()) {
            return home;
        }
        return getUserDir();
    }

    public static String getUserExtensions() {
        return Paths.get(getHarnessBase(), getHarnessHome(), "extensions").toString();
    }

    public static URL getConfigUrl() throws MalformedURLException {
        //1. 工作区配置
        Path path = Paths.get(getUserDir(), getHarnessHome(), NAME_CONFIG_YML);
        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        //2. 全局区配置（安装目录）
        path = Paths.get(getHarnessBase(), getHarnessHome(), NAME_CONFIG_YML);

        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        return null;
    }

    public static URL getAgentsUrl() throws MalformedURLException {
        //1. 工作区配置
        Path path = Paths.get(getUserDir(), getHarnessHome(), NAME_AGENTS_MD);
        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        //2. 全局区配置（安装目录）
        path = Paths.get(getHarnessBase(), getHarnessHome(), NAME_AGENTS_MD);

        if (Files.exists(path)) {
            return path.toUri().toURL();
        }

        return null;
    }

    public static String getAgentsMd() {
        try {
            URL agentsUrl = getAgentsUrl();

            if (agentsUrl != null) {
                try (InputStream is = agentsUrl.openStream()) {
                    String content = IoUtil.transferToString(is, "utf-8").trim();

                    if (content.length() > 10000) { // 例如限制在 1万字符以内
                        LOG.warn("AGENTS.md is too large, truncating...");
                        return content.substring(0, 10000);
                    }
                    return content;
                }
            }
        } catch (Throwable e) {
            LOG.warn("AGENTS.md load failure: {}", e.getMessage(), e);
        }

        return null;
    }

    /**
     * 马具主目录
     */
    public static final String getHarnessHome() {
        return harnessHome;
    }

    /**
     * 马具会话存放区
     */
    public static final String getHarnessSessions() {
        return getHarnessHome() + "sessions/";
    }

    /**
     * 马具技能存放区
     */
    public static final String getHarnessSkills() {
        return getHarnessHome() + "skills/";
    }

    /**
     * 马具子代理描述存放区
     */
    public static final String getHarnessAgents() {
        return getHarnessHome() + "agents/";
    }

    /**
     * 马具命令描述存放区
     */
    public static final String getHarnessCommands() {
        return getHarnessHome() + "commands/";
    }

    /**
     * 马具记忆存放区
     */
    public static final String getHarnessMemory() {
        return getHarnessHome() + "memory/";
    }

    /**
     * 马具下载存放区
     */
    public static final String getHarnessDownload() {
        return getHarnessHome() + "download/";
    }

    /**
     * 马具连接通道存放区
     */
    public static final String getHarnessChannels() {
        return getHarnessHome() + "channels/";
    }

    /**
     * 马具循环任务状态存放区
     */
    public static final String getHarnessLoops() {
        return getHarnessHome() + "loops/";
    }

    /**
     * 马具循环任务 worktree 存放区
     */
    public static final String getHarnessLoopWorktrees() {
        return getHarnessHome() + "loop-worktrees/";
    }
}
