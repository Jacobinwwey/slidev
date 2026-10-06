# notemd-standalone-v52.16.0-2

## English

This release repairs standalone exports in fresh npm installations. The module transformer preserves named exports alongside default Vue components, preventing missing Mermaid layout functions. The published manifest pins the tested UnoCSS cohort and Twoslash/FloatingVue pair; runtime aliases keep consumer-installed versions from replacing the latter pair.

Validation: 22 Vitest suites / 241 tests; a fresh archive installation with minified, offline Chinese/code/Mermaid rendering and no browser errors; NoteMD's 36-slide architecture deck exported as HTML, PDF, PNG, PPTX and MP4 after the fixes. The offline smoke fixture explicitly disables online fonts and wake lock. Linux execution is still required before claiming cross-platform acceptance.

Asset: `slidev-cli-notemd-standalone-v52.16.0-2.tgz`

SHA-256: `2014844bd8422d6280be155fd46c24f49acb1621e03241a2c3335d0faadc6847`

Additional acceptance used a new Obsidian vault with fully migrated settings: real API generation produced 32 slides and completed all five formats. All PNGs decoded, PDF/PPTX page counts matched, the video parsed, and all three Mermaid blocks were preserved. Standalone pages loaded; a headless Wake Lock permission rejection remains an environment limitation. The existing `-1` asset remains unchanged.

## 中文

此版本修复全新 npm 安装环境中的 standalone 导出。模块转换器在保留默认 Vue 组件的同时保留命名导出，防止 Mermaid 布局函数丢失。发布清单固定经过验证的 UnoCSS 组合及 Twoslash／FloatingVue 配对版本；运行时别名防止消费者安装的其他版本替代后一组依赖。

验证：22 个 Vitest 套件、241 项测试通过；全新压缩包安装通过压缩构建及离线中文、代码、Mermaid 渲染，浏览器错误为零；修复后通过 NoteMD 的 36 页 architecture 文档 HTML、PDF、PNG、PPTX、MP4 导出。离线样例明确关闭在线字体与屏幕唤醒。宣称跨平台验收前，仍需执行 Linux 验证。

资产：`slidev-cli-notemd-standalone-v52.16.0-2.tgz`

SHA-256：`2014844bd8422d6280be155fd46c24f49acb1621e03241a2c3335d0faadc6847`

补充验收使用完整迁移配置的新 Obsidian vault：真实 API 生成 32 页并完成全部五格式导出。全部 PNG 可解码，PDF／PPTX 页数一致，视频解析成功，三个 Mermaid 源块保持原样。standalone 页面均可加载；无头环境的 Wake Lock 权限拒绝仍作为环境限制保留。现有 `-1` 资产保持不变。
