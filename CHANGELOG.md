# 更新日志

本文件记录 `@alicloud/openclaw-security-assistant` 插件的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，

## [v1.2.0] - 2026-04-16

### 新增
1. 新增 Skill 安全检测能力：定时扫描 Skill 文件变更并上报安全服务检测，在运行时拦截存在安全风险的 Skill 加载

### 变更
1. 优化Agent资产扫描和上报时的性能表现，提升gateway重启时的插件加载速度

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
[v1.2.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.2.0
