# OpenClaw 安全助手插件

`@alicloud/openclaw-security-assistant` 是由阿里云提供的安全防护插件，为 OpenClaw 的 Agent 生命周期提供全方位的安全保护。

## 核心特性

- **LLM 请求/响应检测**：自动拦截发往大模型的请求和响应，进行安全审计
- **Tool Call 安全审计**：在工具执行前后进行安全检查，防止恶意工具调用和敏感数据泄露
- **Skill 安全检测**：定时扫描 Skill 文件变更并上报检测，在运行时拦截存在安全风险的 Skill 加载
- **全局 Fetch 拦截**：通过 `global.fetch` 实现对底层模型调用的透明拦截
- **智能降级机制**：安全服务不可用时自动放行（fail-open），保障业务连续性

## 兼容性

要求 OpenClaw 版本 >= `2026.2.26`。

## 快速开始

欢迎前往阿里云 AI 安全护栏控制台获取 OpenClaw 运行时防护插件。该插件基于 Qwen 审核大模型，提供针对提示词注入、数据泄露、工具滥用等各类风险的全栈实时防护，让安全成为您 AI 应用最坚实的底座。

启用后重启 Gateway 即可生效。

## 配置说明

在 OpenClaw 配置文件中添加插件配置：

```yaml
plugins:
  openclaw-security-assistant:
    enabled: true
    config:
      endpointAddr: "https://cn-shanghai.agent-security.aliyuncs.com"    # Agent安全服务地址
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `endpointAddr` | string | `https://cn-shanghai.agent-security.aliyuncs.com` | Agent 安全服务地址，包括 LLM 和 Tool Call 的安全审计，身份认证和管理 |

## 安全策略

### LLM

| 检测阶段 | 处置动作 | 说明 |
|----------|----------|------|
| 请求 | `allow` | 请求通过，正常放行 |
| 请求 | `block` | 请求被拦截，返回安全提示信息；风险请求不会发送到模型端 |
| 请求 | `hint` | 请求被标记，返回提示信息但不阻断 |
| 响应 | `allow` | 响应通过，正常放行 |
| 响应 | `block` | 响应被拦截，返回安全提示信息 |
| 响应 | `hint` | 响应被标记，返回提示信息但不阻断 |

### Tool Call

| 检测阶段 | 处置动作 | 说明 |
|----------|----------|------|
| 执行前 | `allow` | Tool 调用请求通过，正常执行 |
| 执行前 | `block` | 拦截 Tool 调用请求，返回安全提示信息 |
| 执行后 | `allow` | Tool 调用结果检测通过，正常返回 |
| 执行后 | `block` | 拦截 Tool 调用结果，返回安全提示信息 |

### Skill 安全检测

| 检测阶段 | 处置动作 | 说明 |
|----------|----------|------|
| Skill 加载 | `allow` | Skill 安全检测通过，正常加载 |
| Skill 加载 | `block` | Skill 存在安全风险，阻断加载 |
