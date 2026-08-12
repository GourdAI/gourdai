package com.gourdai.core.portal.web;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.Result;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * FileService 文件树过滤测试 —— 验证点前缀文件/目录正常展示，
 * 仅排除清单内的目录（如 .git、node_modules）被隐藏。
 *
 * @author oisin
 */
public class FileServiceTest {

    @Test
    public void testTreeShowsDotFiles() throws Exception {
        Path root = Files.createTempDirectory("filer-test");
        try {
            // 应展示的点前缀条目
            Files.createFile(root.resolve(".gitignore"));
            Files.createFile(root.resolve(".env"));
            Files.createDirectory(root.resolve(".github"));
            Files.createFile(root.resolve(".github").resolve("workflow.yml"));
            // 应隐藏的排除清单目录
            Files.createDirectory(root.resolve(".git"));
            Files.createDirectory(root.resolve("node_modules"));
            // 普通条目
            Files.createFile(root.resolve("pom.xml"));
            Files.createDirectory(root.resolve("src"));

            FileService service = new FileService(root.toString());
            Result<List<Map>> rst = service.tree("", 1, root.toString());
            List<Map> nodes = rst.getData();
            List<String> names = nodes.stream()
                    .map(m -> String.valueOf(m.get("name")))
                    .collect(Collectors.toList());

            Assertions.assertTrue(names.contains(".gitignore"), "点前缀文件 .gitignore 应展示");
            Assertions.assertTrue(names.contains(".env"), "点前缀文件 .env 应展示");
            Assertions.assertTrue(names.contains(".github"), "点前缀目录 .github 应展示");
            Assertions.assertTrue(names.contains("pom.xml"));
            Assertions.assertTrue(names.contains("src"));

            Assertions.assertFalse(names.contains(".git"), ".git 应被隐藏");
            Assertions.assertFalse(names.contains("node_modules"), "node_modules 应被隐藏");

            // 文件搜索同样覆盖点前缀文件
            Result<List<Map>> srst = service.search(".env", root.toString());
            List<String> paths = srst.getData().stream()
                    .map(m -> String.valueOf(m.get("path")))
                    .collect(Collectors.toList());
            Assertions.assertTrue(paths.contains(".env"), "搜索应能命中点前缀文件");
        } finally {
            deleteRecursively(root.toFile());
        }
    }

    private void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursively(c);
            }
        }
        f.delete();
    }
}
