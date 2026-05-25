# 更新日志

本文件记录 `@alicloud/openclaw-security-assistant` 插件的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，

## [v1.4.1] - 2026-05-22

### 修复
1. 修复 OpenClaw 2026.5.19 因 OpenAI SDK 升级可能带来的 LLM 检测失效问题

## [v1.4.0] - 2026-05-18

### 新增
1. 新增 Aliyun IDaaS Agent 身份凭据和密钥托管：支持扫描明文 API 密钥并自动替换为安全托管凭据

### 变更
1. Agent 运行时信息采集兼容性增强：支持 OpenClaw >= 2026.3.7 版本

## [v1.3.0] - 2026-05-09

### 新增
1. 新增插件运行状态透出：支持通过 CLI 命令（`openclaw ali-osa health`/`status`）和 HTTP 接口查询插件健康状态与运行详情
2. 新增 Agent 运行时信息采集：全面采集 Agent 配置、模型、Skills、Tools 等运行态信息，提升可观测性

### 变更
1. 优化鉴权逻辑，提供更稳定有效的身份分配机制
2. 资产上报性能优化：采用进程内采集器与缓存机制，降低 IO 开销，提升 Gateway 重启时的插件加载速度

## [v1.2.0] - 2026-04-16

### 新增
1. 新增 Skill 安全检测能力：定时扫描 Skill 文件变更并上报安全服务检测，在运行时拦截存在安全风险的 Skill 加载

### 变更
1. 优化 Agent 资产扫描和上报时的性能表现，提升 Gateway 重启时的插件加载速度

## [v1.1.0] - 2026-03-26

### 变更
1. 优化了 hint 处置动作的表现
2. 优化了日志输出时机，默认保持静默，只在关键阶段输出 err/warn 级别日志
3. 放行的处置动作命名由 pass 改为 allow

### 修复
1. 修复多次 plugin.Register 调用导致的 fetch 重入问题

## [v1.0.0] - 2026-03-17

### 新增

发布 v1.0.0 版本，支持 LLM/ToolCall 请求和响应的检测和处置

<!-- 版本链接 -->
[v1.0.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.0.0
[v1.1.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.1.0
[v1.2.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.2.0
[v1.3.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.3.0
[v1.4.1]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.4.1
[v1.4.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.4.0
