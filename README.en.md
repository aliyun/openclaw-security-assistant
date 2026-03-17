# OpenClaw Security Assistant Plugin

`@alicloud/openclaw-security-assistant` is a security plugin provided by Alibaba Cloud that delivers comprehensive protection for OpenClaw's Agent lifecycle.

## Key Features

- **LLM Request/Response Inspection**: Automatically intercepts requests to and responses from LLMs for security auditing
- **Tool Call Security Audit**: Performs security checks before and after tool execution to prevent malicious calls and sensitive data leakage
- **Global Fetch Interception**: Transparently intercepts underlying model calls via `global.fetch` hooking
- **Intelligent Fail-Open**: Automatically allows requests through when the security service is unavailable (fail-open), ensuring business continuity

## Quick Start

Visit the Alibaba Cloud AI Security Guardrail Console to obtain the OpenClaw runtime protection plugin. Powered by the Qwen audit model, it provides full-stack real-time protection against prompt injection, data leakage, tool abuse, and other risks — making security the solid foundation of your AI applications.

Restart the Gateway after enabling the plugin for changes to take effect.

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

For LLM requests, the following actions are supported:
- **pass**: Request allowed, normal flow continues
- **block**: Request blocked with a security notice; risky requests will not be forwarded to the model
- **hint**: Request flagged with notice but not blocked

For LLM responses, the following actions are supported:
- **pass**: Response allowed, normal flow continues
- **block**: Response blocked, returns security notice
- **hint**: Response flagged with notice but not blocked

For Tool Calls before execution, the following actions are supported:
- **pass**: Call request allowed; proceeds with normal execution
- **block**: Call request blocked; returns a security notice

For Tool Calls after execution, the following actions are supported:
- **pass**: Call result inspection passed; returns normally
- **block**: Call result blocked; returns a security notice
