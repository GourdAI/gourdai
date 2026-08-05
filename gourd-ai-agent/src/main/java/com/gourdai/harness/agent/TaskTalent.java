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

import org.noear.snack4.ONode;
import com.gourdai.agent.AgentChunk;
import com.gourdai.agent.AgentSession;
import com.gourdai.agent.react.ReActAgent;
import com.gourdai.agent.react.ReActChunk;
import com.gourdai.agent.react.ReActTrace;
import com.gourdai.agent.react.task.ActionChunk;
import com.gourdai.agent.react.task.ObservationChunk;
import com.gourdai.agent.react.task.ReasonChunk;
import com.gourdai.agent.react.task.ThoughtChunk;
import com.gourdai.agent.session.InMemoryAgentSession;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.ChatSession;
import org.noear.solon.ai.chat.prompt.Prompt;
import org.noear.solon.ai.chat.talent.AbsTalent;
import com.gourdai.harness.HarnessEngine;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Param;
import org.noear.solon.core.util.Assert;
import org.noear.solon.core.util.RunUtil;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.FluxSink;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 子代理才能
 *
 * 将子代理能力暴露为可调用的工具（Claude Code Subagent 类似实现）
 *
 * @author oisin
 * @since 3.9.5
 */
public class TaskTalent extends AbsTalent {
    private static final Logger LOG = LoggerFactory.getLogger(TaskTalent.class);

    public static final String TOOL_TASK = "task";
    public static final String TOOL_MULTITASK = "multitask";

    private final HarnessEngine engine;

    public TaskTalent(HarnessEngine engine) {
        this.engine = engine;
    }

    @Override
    public String description() {
        return "多任务调度专家：将复杂任务拆解并委派给专项子代理（如 explore, plan, bash 等），支持并行处理以提高效率。";
    }

    @Override
    public String getInstruction(Prompt prompt) {
        StringBuilder sb = new StringBuilder();

        sb.append("## 当前可用的子代理\n");
        sb.append("<available_agents>\n");
        for (AgentDefinition agentDefinition : engine.getAgentManager().getAgents()) {
            sb.append(String.format("  - \"%s\": %s\n", agentDefinition.getName(), agentDefinition.getDescription()));
        }
        sb.append("</available_agents>\n\n");

        sb.append("## 任务分配策略：\n");
        sb.append("0. **先方案后动手（改造门禁）**: 对现有代码/配置/架构的复杂改造（多文件修改、跨模块重构、破坏性变更、多种可行路径），**必须先产出方案并经用户确认，再委派执行类子代理**。可先委派 `plan` 子代理（或自行调研）产出 ≥2 个可行方案（含改动范围、优缺点对比与推荐项），呈现给用户选择；用户拍板后，才允许把方案拆解为执行子任务委派下去。用户已明确指定实现方式的除外。\n");
        sb.append("1. **主动拆分优先**: 遇到复杂任务时，**优先**拆解为独立子任务委派给子代理执行，而不是由主智能体串行完成。子代理是独立运行的智能体，能并行处理、减少主上下文消耗。\n");
        sb.append("2. **委派触发条件** — 遇到以下场景**必须**使用 `task` 或 `multitask` 委派:\n");
        sb.append("   - 需要同时分析/修改多个独立的文件或模块\n");
        sb.append("   - 需要多步验证（如：先探索代码结构，再修改，最后编译验证）\n");
        sb.append("   - 需要深度搜索或跨仓库查找（如：搜索特定模式、查找 API 用法）\n");
        sb.append("   - 需要执行独立的构建/测试/部署步骤\n");
        sb.append("   - 任务涉及不同的技术领域或知识领域\n");
        sb.append("3. **并行执行**: 当子任务互不依赖时，**必须**使用 `multitask` 并行执行以节省时间。\n");
        sb.append("4. **原子性**: 每个子任务应具备明确的输入和输出边界。\n");
        sb.append("5. **上下文传递**: 由于子代理无状态（上下文隔离），必须在 prompt 中提供任务所需的全部背景信息、具体要求及预期输出格式。不要假设子代理知道主会话的上下文。\n");
        sb.append("6. **主智能体职责**: 主智能体专注于**任务规划、进度跟踪、结果整合与最终回答**。具体执行工作应委派给子代理。\n");

        return sb.toString();
    }

    @ToolMapping(name = TOOL_TASK, description =
            "委派单一任务给专项子代理。适用于需要深度思考、多步操作或特定领域知识（如文件操作、代码分析）的场景。不支持并行调用（并行请用 multitask）。")
    public String task(@Body SingleTaskOp taskSpec, String __cwd, String __sessionId) {
        if (Assert.isEmpty(__sessionId)) {
            throw new IllegalStateException("__sessionId is required");
        }

        AgentSession __parentSession = engine.getSession(__sessionId);
        ReActTrace __parentTrace = ReActTrace.getCurrent(__parentSession.getContext());

        MultiTaskOp taskOp = new MultiTaskOp();
        taskOp.agent_name = taskSpec.agent_name;
        taskOp.description = taskSpec.description;
        taskOp.prompt = taskSpec.prompt;

        return taskDo(__parentTrace, __cwd, __sessionId, __parentSession, taskOp, 1, false)
                + TODO_UPDATE_REMINDER;
    }

    @ToolMapping(name = TOOL_MULTITASK, description =
            "并行执行多个互不依赖的子任务。要求任务之间必须没有资源竞争（例如：不同的模块开发、多路搜索）。")
    public String multitask(@Param(name = "tasks", description = "任务列表") List<MultiTaskOp> tasks, String __cwd, String __sessionId) {
        if (Assert.isEmpty(tasks)) {
            return "WARNING: 任务列表为空";
        }

        if (Assert.isEmpty(__sessionId)) {
            throw new IllegalStateException("__sessionId is required");
        }


        AgentSession __parentSession = engine.getSession(__sessionId);
        ReActTrace __parentTrace = ReActTrace.getCurrent(__parentSession.getContext());

        if (__parentTrace == null) {
            if (LOG.isWarnEnabled()) {
                LOG.warn("任务接收[{}, __parentTrace=null]：{}", __sessionId, ONode.serialize(tasks));
            }
        } else {
            if (LOG.isDebugEnabled()) {
                LOG.debug("任务接收[{}]：{}", __sessionId, ONode.serialize(tasks));
            }
        }


        List<CompletableFuture<String>> futures = new ArrayList<>();

        for (MultiTaskOp task : tasks) {
            CompletableFuture<String> future;
            try {
                future = CompletableFuture.supplyAsync(() ->
                                taskDo(__parentTrace, __cwd, __sessionId, __parentSession, task, tasks.size(), true), RunUtil.io())
                        //兜住 taskDo 自身 try 之外的漏网异常，使其就地降级为一条失败结果；
                        //否则 allOf 整体失败会连带丢弃已经成功的兄弟任务
                        .exceptionally(ex -> {
                            Throwable cause = (ex instanceof CompletionException && ex.getCause() != null)
                                    ? ex.getCause() : ex;
                            LOG.error("任务异常[{}/{} - {}]: {}", task.index, tasks.size(), task.agent_name, describe(cause), cause);
                            return formatTaskResp(task, false, "ERROR: 任务执行失败: " + describe(cause), true);
                        });
            } catch (Throwable e) {
                //线程池拒绝是 supplyAsync 同步抛出的，此刻派生 future 尚未生成，exceptionally 拦不到
                LOG.error("任务提交失败[{}/{} - {}]: {}", task.index, tasks.size(), task.agent_name, describe(e), e);
                future = CompletableFuture.completedFuture(
                        formatTaskResp(task, false, "ERROR: 任务提交失败: " + describe(e), true));
            }

            futures.add(future);
        }

        String result = CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                .thenApply(v -> {
                    StringBuilder compositeResult = new StringBuilder();
                    compositeResult.append("<multitask_results>\n");
                    for (CompletableFuture<String> f : futures) {
                        compositeResult.append(f.join()).append("\n");
                    }
                    compositeResult.append("</multitask_results>");
                    compositeResult.append(TODO_UPDATE_REMINDER);
                    return compositeResult.toString();
                })
                .exceptionally(ex -> "ERROR: Multitask aggregate failed: " + ex.getMessage())
                .join();

        if (LOG.isDebugEnabled()) {
            LOG.debug("任务完成[{}]：{} 个全部完成", __sessionId, tasks.size());
        }

        return result;
    }

    private String taskDo(ReActTrace __parentTrace, String __cwd, String __sessionId, AgentSession __parentSession, MultiTaskOp task, int count, boolean isMultitask) {
        //注意：getAgent 找不到时抛 IllegalArgumentException，而该异常会被 ActionTask.executeTool
        //归类为“参数 schema 错误”，从而误导模型反复纠正参数格式。这里必须先判存在性，
        //把“代理名不存在”转成可读结果并附上可选列表，让模型能自行改名重试。
        AgentDefinition agentDefinition;
        try {
            if (engine.getAgentManager().hasAgent(task.agent_name) == false) {
                return formatTaskResp(task, false, unknownAgentMessage(task.agent_name), isMultitask);
            }

            agentDefinition = engine.getAgentManager().getAgent(task.agent_name);
        } catch (Throwable e) {
            LOG.error("解析子代理失败[{}]: {}", task.agent_name, e.getMessage(), e);
            return formatTaskResp(task, false, unknownAgentMessage(task.agent_name), isMultitask);
        }

        final ReActAgent agent;
        final AgentSession session;
        final Prompt originalPrompt;
        try {
            if (LOG.isDebugEnabled()) {
                LOG.debug("任务开始[{}/{} - {}]: {}", task.index, count, task.agent_name, ONode.serialize(task));
            }

            String modelSelected = __parentSession.getContext().getAs(HarnessEngine.CTX_MODEL_SELECTED);

            //模型未配置时 getModelOrMain 返回 null，AgentFactory 随后 ReActAgent.of(null)。
            //异常若从这里逸出，会丢掉 <task_result> 信封与 index，多任务下无法与请求对应
            agent = agentDefinition.builder(engine, modelSelected).build();
            session = InMemoryAgentSession.of(agent.name());

            originalPrompt = Prompt.of(task.prompt);
            originalPrompt.attrs().computeIfAbsent(ChatSession.ATTR_SESSIONID,
                    k -> session.getSessionId());
        } catch (Throwable e) {
            LOG.error("子代理构建失败[{}/{} - {}]: {}", task.index, count, task.agent_name, describe(e), e);
            return formatTaskResp(task, false, "ERROR: 子代理构建失败: " + describe(e), isMultitask);
        }

        String result = null;

        try {
            AtomicReference<Throwable> errRef = new AtomicReference<>();

            if (__parentTrace == null || __parentTrace.getOptions() == null || __parentTrace.getOptions().getStreamSink() == null) {
                // 同步模式
                ReActChunk agentChunk = (ReActChunk) agent.prompt(originalPrompt)
                        .session(session)
                        .options(o -> {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                            o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                        })
                        .stream()
                        .doOnError(err -> {
                            errRef.set(err);
                        })
                        .blockLast();

                if (errRef.get() != null) {
                    throw errRef.get();
                }

                if (__parentTrace != null) {
                    __parentTrace.getMetrics().addMetrics(agentChunk.getMetrics());
                }

                result = agentChunk.getContent();
            } else {
                // 流式模式
                final FluxSink<AgentChunk> sink = __parentTrace.getOptions().getStreamSink();

                // 推送子代理启动信号
                sink.next(new AgentStartChunk(task.agent_name, task.description, __sessionId));

                ReActChunk response = (ReActChunk) agent.prompt(originalPrompt)
                        .session(session)
                        .options(o -> {
                            o.toolContextPut(HarnessEngine.ATTR_CWD, __cwd);
                            o.toolContextPut(ChatSession.ATTR_SESSIONID, __sessionId);
                        })
                        .stream()
                        .takeUntil(r -> sink.isCancelled())
                        .doOnNext(chunk -> {
                            // 统一标记 chunk 的父智能体归属（__parentAgentName/__parentAgentDesc），
                            // 下游流构建器据此把 agentName/agentDesc 透传给前端，使子代理的思考/正文/工具
                            // 内容能路由到对应智能体卡片内部渲染，而不是漏进主对话。
                            chunk.getMeta().put("__parentAgentName", task.agent_name);
                            chunk.getMeta().put("__parentAgentDesc", task.description);

                            if (chunk instanceof ContextUsageChunk) {
                                sink.next(chunk);
                            } else if (chunk instanceof ActionChunk) {
                                sink.next(chunk);
                            } else if (chunk instanceof ObservationChunk) {
                                sink.next(chunk);
                            } else if (chunk instanceof ReasonChunk) {
                                // 单任务模式转发增量思考/正文；multitask 时由 ThoughtChunk 承载，避免重复
                                if (isMultitask == false) {
                                    sink.next(chunk);
                                }
                            } else if (chunk instanceof ThoughtChunk) {
                                if (isMultitask) {
                                    chunk.getMeta().put(TOOL_MULTITASK, 1);
                                    sink.next(chunk);
                                }
                            }
                        })
                        .doOnError(err -> {
                            errRef.set(err);
                        })
                        .blockLast();

                if (errRef.get() != null) {
                    // 推送失败信号
                    sink.next(new AgentEndChunk(task.agent_name, task.description, false, errRef.get().getMessage(), __sessionId));
                    throw errRef.get();
                }

                __parentTrace.getMetrics().addMetrics(response.getMetrics());
                result = response.getContent();

                // 推送子代理结束信号
                sink.next(new AgentEndChunk(task.agent_name, task.description, true, result, __sessionId));
            }


            if (LOG.isDebugEnabled()) {
                LOG.debug("任务成功[{}/{} - {}]: {}", task.index, count, task.agent_name, task.description);
            }

            return formatTaskResp(task, true, result, isMultitask);
        } catch (Throwable e) {
            LOG.error("任务失败[{}/{} - {}]: {}", task.index, count, task.agent_name, e.getMessage(), e);

            result = String.format("ERROR: 任务执行失败: %s", describe(e));

            return formatTaskResp(task, false, result, isMultitask);
        }
    }

    /**
     * 取异常的可读描述：NPE 等异常 getMessage() 恒为 null，
     * 直接回灌给模型会得到 “任务执行失败: null” 这种零信息量的 observation
     */
    private static String describe(Throwable e) {
        String msg = e.getMessage();
        return (msg != null && msg.isEmpty() == false) ? msg : e.toString();
    }

    /**
     * 构造“未知子代理”的可读提示（附当前可选列表，便于模型自行纠正）
     */
    private String unknownAgentMessage(String agentName) {
        StringBuilder buf = new StringBuilder();
        buf.append("ERROR: 未知的子代理类型 '").append(agentName).append("'。");

        //本方法会在 catch 块里被调用，自身绝不能再抛：getAgents() 会触发 MountManager 解析，
        //挂载定义被删除/无权限时 loadFromAgentMd 会抛 RuntimeException，届时异常将逃出 taskDo
        StringBuilder names = new StringBuilder();
        try {
            for (AgentDefinition definition : engine.getAgentManager().getAgents()) {
                if (names.length() > 0) {
                    names.append(", ");
                }
                names.append(definition.getName());
            }
        } catch (Throwable e) {
            LOG.error("枚举可用子代理失败: {}", e.getMessage(), e);
            buf.append("当前无法枚举可用子代理（子代理定义加载异常），请勿再调用本工具，改由自己直接完成任务。");
            return buf.toString();
        }

        if (names.length() == 0) {
            //子代理清单为空属于部署异常（内置定义资源缺失），需明确暴露而不是让模型反复重试
            buf.append("当前没有任何可用的子代理，请勿再调用本工具，改由自己直接完成任务。");
        } else {
            buf.append("可用的子代理：").append(names).append("。");
        }

        return buf.toString();
    }

    /**
     * 提醒主代理在拿到委派结果后立即更新 TODO 清单，避免状态滞后（模型惯于“干完再统一补记”，
     * 一旦此时异常中断，落盘清单会停留在旧状态，续跑时易重复执行已完成的步骤）。
     */
    private static final String TODO_UPDATE_REMINDER =
            "\n[提醒] 子任务结果已返回：若存在 TODO 清单，请立即调用 todowrite 更新对应项状态（成功则置 [x]），再继续后续动作，禁止延后补记。";

    private String formatTaskResp(MultiTaskOp task, boolean successful, String result, boolean isMultitask) {
        StringBuilder buf = new StringBuilder();

        buf.append("<task_result>");
        if (isMultitask) {
            buf.append("<index>").append(task.index).append("</index>");
        }
        buf.append("<description>").append(task.description).append("</description>");
        buf.append("<agent_name>").append(task.agent_name).append("</agent_name>");
        buf.append("<result_status>").append(successful ? "success" : "failure").append("</result_status>");
        buf.append("<result_content><![CDATA[").append(result != null ? result : "").append("]]></result_content>");
        buf.append("</task_result>");

        return buf.toString();
    }

    public static class SingleTaskOp {
        @Param(name = "agent_name", description = "子代理名称")
        public String agent_name;
        @Param(name = "prompt", description = "发给子代理的详细指令。由于子代理是无状态的（上下文隔离），必须在此提供任务所需的所有背景信息、具体要求及预期输出格式。")
        public String prompt;
        @Param(name = "description", description = "任务内容的极简摘要（如：'重构用户认证逻辑'）。该描述将作为标签出现在执行日志和结果摘要中，用于快速识别任务意图。")
        public String description;

        @Override
        public String toString() {
            return "SingleTaskOp{" +
                    "agent_name='" + agent_name + '\'' +
                    ", description='" + description + '\'' +
                    '}';
        }
    }

    /**
     * 任务定义
     */
    public static class MultiTaskOp extends SingleTaskOp {
        @Param(name = "index",
                description = "任务唯一序号，每个任务分配唯一的递增整数（从1开始），以便匹配返回结果",
                defaultValue = "1")
        public int index = 1;

        @Override
        public String toString() {
            return "MultiTaskOp{" +
                    "index='" + index + '\'' +
                    "agent_name='" + agent_name + '\'' +
                    ", description='" + description + '\'' +
                    '}';
        }
    }
}