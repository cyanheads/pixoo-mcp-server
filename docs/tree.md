# pixoo-mcp-server - Directory Structure

Generated on: 2026-06-12 10:20:55

```text
pixoo-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   └── FUNDING.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 1.0.x/
│   └── template.md
├── docs/
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── pixoo-design-guide.resource.ts
│   │   │       ├── pixoo-device-status.resource.ts
│   │   │       ├── pixoo-icons.resource.ts
│   │   │       └── pixoo-themes.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── pixoo-compose-scene.tool.ts
│   │           ├── pixoo-control-device.tool.ts
│   │           ├── pixoo-design-brief.tool.ts
│   │           ├── pixoo-discover-devices.tool.ts
│   │           ├── pixoo-display-text.tool.ts
│   │           ├── pixoo-overlay-text.tool.ts
│   │           └── pixoo-push-image.tool.ts
│   ├── renderer/
│   │   ├── icons.ts
│   │   ├── keyframes.ts
│   │   ├── preview.ts
│   │   ├── scene-renderer.ts
│   │   ├── text-engine.ts
│   │   └── themes.ts
│   ├── services/
│   │   └── pixoo/
│   │       └── pixoo-service.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── renderer/
│   │   ├── icons.test.ts
│   │   ├── keyframes.test.ts
│   │   ├── preview.test.ts
│   │   ├── scene-renderer.test.ts
│   │   ├── text-engine.test.ts
│   │   └── themes.test.ts
│   ├── resources/
│   │   ├── pixoo-device-status.resource.test.ts
│   │   ├── pixoo-icons.resource.test.ts
│   │   └── pixoo-themes.resource.test.ts
│   ├── services/
│   │   └── pixoo/
│   │       └── pixoo-service.test.ts
│   └── tools/
│       ├── pixoo-compose-scene.tool.test.ts
│       ├── pixoo-control-device.tool.test.ts
│       ├── pixoo-design-brief.tool.test.ts
│       ├── pixoo-discover-devices.tool.test.ts
│       ├── pixoo-display-text.tool.test.ts
│       ├── pixoo-overlay-text.tool.test.ts
│       └── pixoo-push-image.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
