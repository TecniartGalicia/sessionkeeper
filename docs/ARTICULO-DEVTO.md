# Artículo para dev.to (borrador listo para publicar)

> Interno. Publicar desde la cuenta del usuario. Etiquetas sugeridas: `vscode`, `ai`, `claudecode`, `backup`.
> Portada: `media/shots/03-huerfana.png`.

---

**Title:** Claude Code deletes your session transcripts after 30 days. I measured what that actually means.

**Canonical:** https://github.com/TecniartGalicia/sessionkeeper

---

I found out the way everyone finds out: I went looking for a conversation from a month ago and it was not there.

Claude Code stores every session as a JSONL file under `~/.claude/projects/`. It also deletes them: `cleanupPeriodDays` defaults to **30**, and on startup anything older than that goes away. No warning, no trash, no undo. There are open issues from people who lost [58 of 69 transcripts](https://github.com/anthropics/claude-code/issues/86730), [around 950 at once](https://github.com/anthropics/claude-code/issues/85466) and [months of history](https://github.com/anthropics/claude-code/issues/84279).

I ended up writing a VS Code extension for it — [SessionKeeper](https://marketplace.visualstudio.com/items?itemName=argalla.sessionkeeper), MIT — but the interesting part is not the extension. It is what I measured on the way, because almost everything I assumed at the start was wrong.

## A session is not a file

This is the mistake that would have shipped a useless product. I modelled a session as `~/.claude/projects/<project>/<id>.jsonl`, wrote a test that restored one and compared sha256 with the original, and it passed.

Then I looked at the actual directory:

```
projects/<project>/
    <id>.jsonl                     ← the transcript
    <id>/subagents/agent-*.jsonl   ← what each subagent did
    <id>/tool-results/*.txt        ← large tool output, spilled to files
    memory/*.md                    ← persistent project memory
```

On my machine that is **651 subagent files (155 MB)** next to **91 transcripts**. A backup that copies only the `.jsonl` passes every hash check you can write and still loses the work of every subagent and every large tool output. If you are writing your own backup script, this is the part to get right.

## The numbers, on a real corpus

91 sessions, 2.09 GB. Median session 5.3 MB, p90 40.5 MB, largest **324 MB** — and **68 % of all bytes live in 9 files**. It is a heavy-tail problem, not a many-small-files problem, and that changes the design: you cannot re-copy, you have to append.

Which you can, because transcripts are append-only. Compaction *adds* a summary rather than rewriting, so a backup only needs the new bytes. Measured on the 324 MB file: a full first pass at **100 MB/s** (3.2 s), and each later cycle at **0.5 ms** because it only re-reads two 64 KB windows to check nothing moved. gzip level 4 gives a 0.257 ratio: 2.09 GB of sessions becomes a **538 MB** vault.

## Checking both ends is not enough

To know a file only grew, hash the first 64 KB and the last 64 KB of what you already copied. If both match, append the delta.

That is what I did, and an auditor broke it in one line: change 10 bytes **in the middle**, keep the length, keep both ends. My code said "no change", and from then on the backup and the original disagreed forever, while every internal checksum still matched. Now there are probes spread every 16 MB — verifying the 324 MB file costs 1.3 MB of reads.

## The other things that only show up in the real world

- **`fs.renameSync` fails on Windows.** Atomic write is temp file + rename. Measured: **118 failures out of 2000** rewrites of the same file (5.9 %), EPERM, because an antivirus or the indexer held the file for an instant. Without a retry, one failure aborted the whole backup run.
- **Windows does not lock an appended file.** A `.jsonl` that Claude Code has open in append mode can be overwritten, renamed and deleted with no error — and the agent keeps writing into an orphaned handle until it fails silently. So "is this session running?" matters, and the pid files Claude Code leaves behind are stale **39 times out of 48**. Rule: when in doubt, assume it is alive.
- **A hand-copied duplicate breaks resume.** From the docs: cross-project lookup resolves an ID only when exactly one project holds it, so leaving a copy in the wrong folder makes `claude --resume <id>` report *not found*. Restoring to the wrong place is not neutral.
- **Transcripts contain secrets.** Anthropic documents it: if a tool reads a `.env` or a command prints a credential, the value is written into the transcript. My first secret detector caught **0 of 7** real formats and happily flagged temp paths as `sk-` keys.

## What I would tell you if you only take one thing

You probably do not need my extension. You do need to know that the default is 30 days, that a session is a directory, and that the copy of it you are relying on may be silently incomplete.

If you want the ten-second fix and nothing else, raise the retention (`cleanupPeriodDays` in `~/.claude/settings.json`; the minimum is 1 and `0` is a validation error, so use something large). If you want it backed up and rescued from inside VS Code, that is what SessionKeeper is for: free, MIT, no telemetry, and the vault is an open format with a standalone `restore.mjs` so your copies work without the extension.

*Not affiliated with Anthropic or OpenAI.*
