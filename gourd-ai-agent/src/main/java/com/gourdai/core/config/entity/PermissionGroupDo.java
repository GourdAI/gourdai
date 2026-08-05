package com.gourdai.core.config.entity;

import lombok.Getter;
import lombok.Setter;

import java.util.ArrayList;
import java.util.List;

/**
 *
 * @author oisin
 *
 */
@Setter
@Getter
public class PermissionGroupDo {
    //允许工具  {"**"};
    private final List<String> tools = new ArrayList<>();
    //禁用工具
    private final List<String> disallowedTools = new ArrayList<>();
}
