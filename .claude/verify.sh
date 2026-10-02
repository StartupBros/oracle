#!/usr/bin/env bash
# Run by the Claude Code verify-on-stop hook: typecheck plus oxlint.
exec pnpm lint
