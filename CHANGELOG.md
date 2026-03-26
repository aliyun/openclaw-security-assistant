# 更新日志

本文件记录 `@alicloud/openclaw-security-assistant` 插件的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，

## [v1.1.0] - 2026-03-26

### 变更
1. 优化了hint处置动作的表现
2. 优化了log日志时机，默认保持静默，只在关键阶段输出err/warn级别日志
3. 放行的处置动作命名由pass改为allow


### 修复
1. 修复多次plugin.Register调用导致的fetch重入问题

## [v1.0.0] - 2026-03-17

### 新增

发布v1.0.0版本，支持LLM/ToolCall请求和响应的检测和处置

<!-- 版本链接 -->
[v1.0.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.0.0
[v1.1.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.1.0
