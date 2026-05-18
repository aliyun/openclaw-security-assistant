# OpenClaw Security Assistant Plugin

`@alicloud/openclaw-security-assistant` is a security plugin provided by Alibaba Cloud that delivers comprehensive protection for OpenClaw's Agent lifecycle.

## Key Features

- **LLM Request/Response Inspection**: Automatically intercepts requests to and responses from LLMs for security auditing
- **Tool Call Security Audit**: Performs security checks before and after tool execution to prevent malicious calls and sensitive data leakage
- **Skill Security Detection**: Periodically scans Skill file changes for security inspection, and blocks loading of Skills with security risks at runtime
- **Global Fetch Interception**: Transparently intercepts underlying model calls via `global.fetch` hooking
- **Credential and Secret Hosting**: Integrates Aliyun IDaaS to automatically scan plaintext API keys and replace them with securely hosted credentials
- **Runtime Status Exposure**: Query plugin health status in real time via CLI commands and HTTP endpoints
- **Agent Runtime Observability**: Comprehensive collection of Agent runtime information for improved observability
- **Intelligent Fail-Open**: Automatically allows requests through when the security service is unavailable (fail-open), ensuring business continuity

## Compatibility

Requires OpenClaw version >= `2026.3.7`.

## Quick Start

Visit the Alibaba Cloud AI Security Guardrail Console to obtain the OpenClaw runtime protection plugin. Powered by the Qwen audit model, it provides full-stack real-time protection against prompt injection, data leakage, tool abuse, and other risks — making security the solid foundation of your AI applications.

Restart the Gateway after enabling the plugin for changes to take effect.

## Status Query

Query the current security protection status through multiple channels:

### CLI Commands

```bash
# View health overview
openclaw ali-osa health
```

### HTTP Endpoints

```bash
# Health check
curl http://127.0.0.1:<GATEWAY_PORT>/plugin/openclaw-security-assistant/health
```

## Configuration

Add the plugin configuration to your OpenClaw config file:

```yaml
plugins:
  openclaw-security-assistant:
    enabled: true
    config:
      endpointAddr: "https://cn-shanghai.agent-security.aliyuncs.com"    # Agent security service address
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpointAddr` | string | `https://cn-shanghai.agent-security.aliyuncs.com` | Agent security service address, including LLM and Tool Call security auditing, authentication and token management |

## Security Policy

### LLM

| Phase | Action | Description |
|-------|--------|-------------|
| Request | `allow` | Request allowed, normal flow continues |
| Request | `block` | Request blocked with a security notice; risky requests will not be forwarded to the model |
| Request | `hint` | Request flagged with notice but not blocked |
| Response | `allow` | Response allowed, normal flow continues |
| Response | `block` | Response blocked, returns security notice |
| Response | `hint` | Response flagged with notice but not blocked |

### Tool Call

| Phase | Action | Description |
|-------|--------|-------------|
| Pre-execution | `allow` | Call request allowed; proceeds with normal execution |
| Pre-execution | `block` | Call request blocked; returns a security notice |
| Post-execution | `allow` | Call result inspection passed; returns normally |
| Post-execution | `block` | Call result blocked; returns a security notice |

### Skill Security Detection

| Phase | Action | Description |
|-------|--------|-------------|
| Skill loading | `allow` | Skill passed security detection, loading proceeds normally |
| Skill loading | `block` | Skill has security risks, loading is blocked |
