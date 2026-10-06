# NoteMD standalone 运行时可靠性

[English](./notemd-runtime-reliability.md) | 简体中文

## 契约

NoteMD 必须使用 Jacobinwwey Slidev fork。包名、版本号和帮助选项不能单独证明其来源。发布前必须在新的消费者目录测试实际可供 npm 安装的压缩包；工作区构建通过并不充分。已经公开的发布资产不得替换。

## 已确认的失败机制

1. 发布包允许 UnoCSS `^66.7.0`，工作区锁文件却使用 66.7.0。新安装得到 66.10.5，其 Vite 集成创建 MagicString 1.4.3 实例。Uno 指令先修改该实例，再在清理空规则时替换原始范围；保留的插入内容导致无选择器的非法 CSS 声明。将四个 UnoCSS catalog 包固定为经过验证的 66.7.0 组合，使约束进入最终发布清单。
2. standalone ESM 转换器生成 `module.exports.default=module.exports=component`，覆盖同一分块此前的命名导出。新安装的 Mermaid 将布局函数与幻灯片组件放进共享分块，导致命名布局函数丢失。修复保留 `module.exports`，仅设置其 `.default`，并使用 `Symbol.toStringTag = 'Module'` 标记命名空间，从而保留这些导出及 Vue 异步组件解包行为。回归测试真实执行转换后的模块，覆盖基本类型默认导出和重新导出。
3. 新安装选择 Twoslash 4.5.0／FloatingVue 5.4.0。Twoslash 访问 `VMenu.components.Popper.extends`，但这一组件结构已不匹配。经过验证的组合为 4.2.0／5.2.2。两者均成为明确的 CLI 依赖，Vite 从 CLI 解析其运行时入口，避免消费者的新版本副本覆盖它们。后续应成组升级，并重新执行消费者渲染测试。

命名空间修复解决模块语义问题；依赖约束处理独立的已验证兼容边界，两者不能互相替代。

## 可复现的发布包门禁

构建 CLI，并用 `pnpm pack` 生成最终压缩包，然后运行：

```sh
node scripts/smoke-standalone-package.mjs /absolute/path/cli.tgz /absolute/path/new-consumer
```

命令拒绝已存在的消费者目录，通过 npm 安装指定压缩包，使用消费者自身的 Playwright 包安装 Chromium，在没有插件生成的 Vite 配置时构建压缩 standalone HTML，并检查离线中文、代码与 Mermaid 渲染。生成的 `standalone-smoke.json` 包含压缩包 SHA-256 和浏览器错误。可通过 `PLAYWRIGHT_BROWSERS_PATH` 与 `npm_config_cache` 指定缓存。若 npm 不在当前 Node 安装目录旁，应通过 npm 运行，或提供 `npm_execpath`。

测试样例明确关闭在线字体和屏幕唤醒。默认样例另行记录了离线字体请求及屏幕唤醒权限拒绝；本门禁不宣称这些可选功能在离线无头环境中可用。发布前应在 Windows 与 Linux 执行。本地 Windows 验收不代表 Linux 已通过。

## 本地证据与发布状态

旧 `notemd-standalone-v52.16.0-1` 压缩包与 NoteMD 安装的 CLI 逐字节一致。最初候选包构建成功，但 FloatingVue 与 Mermaid 渲染失败；修复后候选包通过明确的离线样例，错误及失败请求为零。转换器定向测试通过 33 项。NoteMD 的 36 页 architecture 文档已针对原 fork main checkout 通过五种格式导出；修复后的重跑状态记载于 NoteMD 的双语可靠性记录。

这些均为本地改动，尚未上传替换资产或新版本。现有发布工作流仅匹配 `v*` 标签，不能假定 `notemd-standalone-*` 发布自动执行了上述发布包门禁。
