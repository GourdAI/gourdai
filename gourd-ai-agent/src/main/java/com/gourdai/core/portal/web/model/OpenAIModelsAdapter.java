package com.gourdai.core.portal.web.model;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * OpenAI 兼容协议实现
 * 接口：GET {baseUrl}/models
 */
@Slf4j
public class OpenAIModelsAdapter implements ModelsAdapter {

@Override
    public String getStandard() {
        return "openai";
    }

    @Override
    public List<ModelInfo> fetchModels(String baseUrl, Map<String, String> headers, String apiKey) {
        String modelsUrl = baseUrl + "/v1/models";
        List<ModelInfo> result = new ArrayList<>();

        try {
            HttpUtils http = HttpUtils.http(modelsUrl).timeout(15);

            if (headers != null) {
                headers.forEach(http::header);
            }
            if (apiKey != null && !apiKey.isEmpty()
                    && (headers == null || !headers.containsKey("Authorization"))) {
                http.header("Authorization", "Bearer " + apiKey);
            }

            String body = http.get();

            ONode root = ONode.ofJson(body);
            ONode data = root.get("data");
            if (data.isArray()) {
                for (ONode item : data.getArray()) {
                    ModelInfo modelInfo = item.toBean(ModelInfo.class);

                    // supported_endpoint_types 为下划线命名，toBean 不会自动映射；
                    // 手动解析并据此推断该模型的对话接口协议（识别不了则留空，前端回退 openai）。
                    ONode endpointsNode = item.get("supported_endpoint_types");
                    if (endpointsNode != null && endpointsNode.isArray()) {
                        List<String> endpointTypes = new ArrayList<>();
                        for (ONode ep : endpointsNode.getArray()) {
                            endpointTypes.add(ep.getString());
                        }
                        modelInfo.setSupportedEndpointTypes(endpointTypes);
                        modelInfo.setStandard(ModelInfo.inferStandard(endpointTypes));
                    }

                    result.add(modelInfo);
                }
            }
        } catch (Exception e) {
            log.warn("[OpenAI] Error fetching models from {}: {}", modelsUrl, e.getMessage());
        }

        return result;
    }
}
