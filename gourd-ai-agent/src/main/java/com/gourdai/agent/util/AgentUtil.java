/*
 * Copyright 2017-2025 noear.org and authors
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
package com.gourdai.agent.util;

import org.noear.snack4.ONode;
import com.gourdai.agent.Agent;
import com.gourdai.agent.AgentProfile;
import org.noear.solon.core.util.Assert;
import org.noear.solon.flow.FlowContext;

import java.util.Map;

/**
 * 智能体辅助工具类
 *
 * @author oisin
 * @since 3.9.0
 */
public class AgentUtil {
    public static ONode toMetadataNode(Agent<?, ?> agent, FlowContext context) {
        ONode node = new ONode().asObject();

        node.set("name", agent.name());

        if (Assert.isNotEmpty(agent.role())) {
            node.set("role", agent.roleFor(context));
        }

        AgentProfile profile = agent.profile();

        if (profile != null) {
            if (Assert.isNotEmpty(profile.getCapabilities())) {
                node.getOrNew("capabilities").addAll(profile.getCapabilities());
            }

            if (Assert.isNotEmpty(profile.getInputModes())) {
                node.getOrNew("inputModes").addAll(profile.getInputModes());
            }
        }

        return node;
    }

    /**
     * 从工具参数表安全取字符串参数。
     *
     * <p>模型输出的参数不保证为字符串（可能是数组/对象等任意 JSON 结构），
     * 渲染层不得直接强转；非字符串值退化为 {@link String#valueOf(Object)}，确保不抛异常。</p>
     *
     * @param args 参数表（可为 null）
     * @param key  参数名
     * @return 字符串值；缺失时为 null
     */
    public static String asStringArg(Map<String, Object> args, String key) {
        if (args == null) {
            return null;
        }

        Object val = args.get(key);

        if (val == null) {
            return null;
        }

        return (val instanceof String) ? (String) val : String.valueOf(val);
    }
}
