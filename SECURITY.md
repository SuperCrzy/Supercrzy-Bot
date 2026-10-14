# Security Policy

[中文摘要](#中文摘要)

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use either channel:

1. **GitHub private vulnerability reporting (preferred)** —
   [Security → Report a vulnerability](https://github.com/SuperCrzy/supercrzy-agent/security/advisories/new).
   This keeps the report private and gives us a place to coordinate the fix.
2. **Email** — `security@supercrzy.com`. Encrypt if you can; ask for our PGP key in the first message.

### What to include

- Affected version or commit (`git rev-parse --short HEAD`, or the App version for the packaged build)
- Impact: what an attacker gains, and what access they need to start
- Reproduction steps or a proof of concept
- Any relevant logs — **with secrets redacted**

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | within 72 hours |
| Initial assessment (severity + affected scope) | within 7 days |
| Fix or mitigation for high-severity issues | within 30 days |

We will credit you in the release notes unless you prefer to stay anonymous.
Please give us a reasonable window to ship a fix before public disclosure.

## Supported versions

This project is pre-1.0 and ships from `main`. Only the latest `main` commit and the
most recent packaged release are supported — there are no maintained back-branches yet.

## Scope

This is a **local-first desktop application**. It runs an HTTP API, executes shell
commands, and reads/writes files on the machine it is installed on. That design makes
the following security-relevant surfaces:

- **Permission and approval logic** — anything that lets a tool run without the user's
  consent, or that mis-classifies a dangerous command as safe (the approval decision is
  a pure function with its own unit tests; regressions there are security bugs).
- **Path sandboxing** — reading or writing outside the allowed workspace roots,
  especially anything that reaches credential files.
- **Authentication and CORS** — bypassing the API token, or a hostile web page being
  able to reach the local API from a browser.
- **Injection through rendered content** — SVG/HTML produced by a model being treated
  as trusted and executing script in the app's origin.
- **Credential handling** — keys or tokens leaking into logs, files committed to the
  repository, crash reports, or outbound requests to unintended hosts.

## Out of scope

- **You are running unsupported code.** If the vulnerability only exists after you edit
  the source, disable the permission system, or expose the API to the public internet
  yourself, that is a configuration choice, not a vulnerability in the project.
- **Third-party services and models.** Bugs in model providers, or in the behaviour of a
  model itself (including prompt injection that stays inside the sandbox the user granted),
  belong upstream. Report them to the respective vendor.
- **Dependency issues with no exploitable path** in this project. If you can show a
  reachable exploit, that is in scope.
- **The unofficial speech (TTS) endpoint.** See `NOTICE` — the read-aloud Pro voice uses
  a third-party endpoint that is not ours to secure. Denial of service or endpoint
  changes there are expected, not vulnerabilities.

## Hardening checklist for self-hosting

If you expose this app beyond `localhost`, at minimum:

- Set `API_TOKEN` so non-local API requests require `Authorization: Bearer <token>`.
- Restrict `CORS_ORIGINS` to the exact origins you use (never `*`).
- Keep the workspace directories narrow — the file tools are scoped to them.

---

## 中文摘要

- 报告漏洞**请勿开公开 issue**。优先用 GitHub 私密漏洞报告（仓库 Security 页 → Report a vulnerability），
  或邮件 `security@supercrzy.com`。请附版本/commit、影响、复现步骤，**日志务必脱敏**。
- 响应目标：72 小时内确认，7 天内给出定级，高危 30 天内修复。修复发布后可为你署名。
- **在范围内**：授权/审批判定被绕过或误判、路径沙箱越界（尤其触及凭据文件）、API 鉴权与 CORS 绕过、
  模型产出的 SVG/HTML 在本应用源内执行脚本、凭据泄漏到日志/仓库/外部请求。
- **不在范围内**：你自己改坏了代码、自行把接口暴露到公网、上游模型或服务商自身的问题、
  以及朗读所用的第三方语音端点（其可用性变化属预期，见 `NOTICE`）。
- 自部署加固：设 `API_TOKEN`、把 `CORS_ORIGINS` 限成确切来源、工作区目录开到最小。
