package com.gourdai.core.portal.web.market;

import org.noear.solon.core.handle.Result;

import java.nio.file.Path;
import java.util.List;

/**
 * 技能市场接口 — 抽象技能市场的浏览、搜索、安装能力。
 *
 * <p>不同市场（ClawHub、Skills.sh 等）可实现此接口，由 MarketManager 注入管理。</p>
 *
 * @author oisin
 */
public interface Market {
    /**
     * 获取市场名称
     */
     String name() ;

    /**
     * 获取市场描述
     */
    default String description() {
        return "";
    }

    /**
     * 获取热门技能列表
     * @param page 页码（从 1 开始）
     */
    Result<List<MarketItem>> trending(int page, int limit);

    /**
     * 搜索技能
     * @param page 页码（从 1 开始）
     */
    Result<List<MarketItem>> search(String query, int page, int limit);

    /**
     * 获取技能详情
     */
    Result<MarketDetail> detail(String slug);

    /**
     * 安装技能 — 下载并解压到指定目录
     */
    Result<String> install(String slug, Path skillsDir);
}
