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

import org.noear.solon.Utils;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Filter;
import org.noear.solon.core.handle.FilterChain;
import com.gourdai.core.config.AgentSettings;

import java.io.IOException;
import java.util.Base64;

/**
 * Web 访问认证过滤器（Basic Auth）。
 *
 * <p>当用户在「通用设置」中配置了 webAuthUser/webAuthPass 后，
 * 所有 HTTP 请求（含 WebSocket 升级请求）都会校验 Basic Auth 头。
 * 校验失败返回 401，浏览器自动弹出登录框。</p>
 *
 * @author oisin
 */
public class WebAuthFilter implements Filter {

    private final AgentSettings settings;

    public WebAuthFilter(AgentSettings settings) {
        this.settings = settings;
    }

    @Override
    public void doFilter(Context ctx, FilterChain chain) throws Throwable {
        // ====== CORS 预检请求放行（避免跨域 OPTIONS 被 401 拦截） ======
        if ("OPTIONS".equalsIgnoreCase(ctx.method())) {
            chain.doFilter(ctx);
            return;
        }

        // ====== 白名单：静态资源放行（浏览器弹登录框时会先加载页面资源） ======
        String path = ctx.path();
        if (path.startsWith("/css/")
                || path.startsWith("/js/")
                || path.startsWith("/layui/")
                || path.startsWith("/highlight/")
                || path.startsWith("/img/")
                || path.equals("/favicon.ico")) {
            chain.doFilter(ctx);
            return;
        }

        // ====== 没设账号密码 → 直接放行 ======
        String user = settings.getGeneral().getWebAuthUser();
        String pass = settings.getGeneral().getWebAuthPass();
        if (Utils.isBlank(user) || Utils.isBlank(pass)) {
            chain.doFilter(ctx);
            return;
        }

        // ====== 检查 Authorization: Basic base64(username:password) ======
        String authorization = ctx.header("Authorization");
        if (Utils.isBlank(authorization) || !authorization.startsWith("Basic ")) {
            response401(ctx);
            return;
        }

        try {
            String base64 = authorization.substring(6);
            String nameAndPwd = new String(Base64.getDecoder().decode(base64));
            String[] parts = nameAndPwd.split(":", 2);

            if (parts.length == 2
                    && user.equals(parts[0])
                    && pass.equals(parts[1])) {
                chain.doFilter(ctx);
            } else {
                response401(ctx);
            }
        } catch (Exception e) {
            response401(ctx);
        }
    }

    private void response401(Context ctx) throws IOException {
        ctx.status(401);
        ctx.headerSet("WWW-Authenticate", "Basic realm=\"Gourd AI\"");
        ctx.output("需要访问认证");
    }
}
