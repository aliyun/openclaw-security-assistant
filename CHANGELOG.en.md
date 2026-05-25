# Changelog

This file documents all notable changes to the `@alicloud/openclaw-security-assistant` plugin.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [v1.4.0] - 2026-05-18

### Added
1. Added Aliyun IDaaS Agent credential and secret hosting: scans plaintext API keys and automatically replaces them with securely hosted credentials

### Changed
1. Agent runtime information collection compatibility improvement: now supports OpenClaw >= 2026.3.7

## [v1.3.0] - 2026-05-09

### Added
1. Added plugin runtime status exposure: query health and detailed diagnostics via CLI (`openclaw ali-osa health`/`status`) and HTTP endpoints
2. Added Agent runtime information collection: captures Agent actions at runtime for improved observability

### Changed
1. Optimized authentication logic for more stable and effective identity assignment
2. Asset reporting performance optimization: in-process collectors and caching reduce I/O overhead and improve plugin loading speed on Gateway restart

## [v1.2.0] - 2026-04-16

### Added
1. Added Skill security detection: periodically scans Skill file changes and submits them to the security service for inspection, blocks loading of Skills with security risks at runtime

### Changed
1. Improved Agent asset scanning and reporting performance, faster plugin loading during Gateway restart

## [v1.1.0] - 2026-03-26

### Changed
1. Improved the behavior of the `hint` action
2. Optimized log timing — stays silent by default, only emitting error/warn level logs at critical phases
3. Renamed the pass-through action from `pass` to `allow`

### Fixed
1. Fixed fetch re-entry issue caused by multiple `plugin.Register` calls

## [v1.0.0] - 2026-03-17

### Added

Initial v1.0.0 release with LLM and Tool Call request/response inspection and enforcement

<!-- Version links -->
[v1.0.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.0.0
[v1.1.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.1.0
[v1.2.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.2.0
[v1.3.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.3.0
[v1.4.0]: https://github.com/aliyun/openclaw-security-assistant/tree/release/v1.4.0
