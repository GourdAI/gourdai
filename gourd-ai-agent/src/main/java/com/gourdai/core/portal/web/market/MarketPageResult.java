package com.gourdai.core.portal.web.market;

import java.util.List;

/**
 * 技能市场分页结果 — cursor 游标分页。
 *
 * <p>部分市场（如 clawhub.ai）的 page/offset 参数会被上游忽略，
 * 仅支持 cursor 游标翻页；本结果对象统一各市场的分页语义：
 * 下一页请求携带本次返回的 {@code nextCursor}，为 null/空表示没有更多数据。</p>
 *
 * @author oisin
 */
public class MarketPageResult {

    /** 当前页的技能列表 */
    private List<MarketItem> items;

    /** 下一页游标；null 或空字符串表示没有更多数据 */
    private String nextCursor;

    public MarketPageResult() {
    }

    public MarketPageResult(List<MarketItem> items, String nextCursor) {
        this.items = items;
        this.nextCursor = nextCursor;
    }

    public List<MarketItem> getItems() {
        return items;
    }

    public void setItems(List<MarketItem> items) {
        this.items = items;
    }

    public String getNextCursor() {
        return nextCursor;
    }

    public void setNextCursor(String nextCursor) {
        this.nextCursor = nextCursor;
    }
}
