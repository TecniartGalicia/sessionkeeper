# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Please do not open a public issue for security problems.

We aim to acknowledge within 72 hours.

## Scope

SessionKeeper runs entirely on your machine and makes no network requests. The security-relevant surface is:

- reading session files from `~/.claude` and `~/.codex`;
- writing inside the vault folder;
- writing a file you explicitly asked to restore (always after saving a copy of the previous contents).

Reports about data loss, writing outside the vault without consent, or credentials leaking into logs or reports are especially welcome.

## Supported versions

The latest published version.
