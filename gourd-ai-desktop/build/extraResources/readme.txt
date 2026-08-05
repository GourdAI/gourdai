此目录用于存放打包到安装包中的第三方资源文件。

构建时会自动放入：
- gourd-ai-agent.jar  （Maven 构建产物）
- jre/              （jlink 精简 JRE）

打包后位于应用安装目录的 resources/extraResources/ 下，
运行时通过 path.join(process.resourcesPath, 'extraResources') 访问。
