# Privacy

**Short version: nothing leaves your machine. There is no server, no account and no telemetry.**

## What SessionKeeper reads

- `~/.claude/projects/**` (or the folder in `CLAUDE_CONFIG_DIR`, or the one you set in `sessionkeeper.claudeHome`): session transcripts, subagent transcripts, spilled tool outputs and your `memory/` folder.
- `~/.claude/settings.json` and `settings.local.json`: only the `cleanupPeriodDays` value, to tell you what is at risk.
- `~/.claude/sessions/*.json`: only to check whether a session is running before restoring it.
- `~/.codex/sessions/**`: only if you turn on `sessionkeeper.includeCodex`.

It reads these files. It does not modify them.

## What SessionKeeper writes

- **The vault**, in the folder you choose (`sessionkeeper.vaultPath`) or the default location for your system. It contains gzip copies of your session files, a `meta.json` per session and a `gen.json` per version.
- **A file you asked to restore**, and only after saving a byte-for-byte copy of whatever was there into `_pre-restore/` inside the vault.

Nothing else. Ever.

## Network

**Without a Pro licence: none at all.** SessionKeeper makes no HTTP request of any kind. It does not check for updates, does not report errors, does not count users. On a machine with no licence it does not even read its own secret storage.

**With a Pro licence**, one endpoint is contacted, and only that one: `api.polar.sh/v1/customer-portal/license-keys` (activate / validate / deactivate). What is sent: your licence key, this computer's host name (as the activation label), your platform and the extension version. Nothing else — no session content, no paths, no settings.

When: once when you enter the key, once every 24 hours to revalidate, and when you ask for the licence status. If the network is down, Pro keeps working for 14 days on the last positive validation. Removing the licence sends one deactivation call so the activation slot is freed.

Polar (Polar Software Inc.) is the merchant of record for the purchase: they receive your e-mail and billing details, not us. See [polar.sh/legal/privacy](https://polar.sh/legal/privacy).

## Credentials in your transcripts

Anthropic documents that if a tool reads a `.env` file or a command prints a credential, that value is written into the transcript. Backing up transcripts therefore multiplies copies of those secrets.

SessionKeeper:

- **counts** credential-shaped strings when it backs up and warns you, without ever printing the value;
- **redacts** them when you export a session to Markdown;
- **never edits** your session files or the backup — a redacted backup would not be a backup.

Consequences for you: the vault inherits the permissions of the folder you pick. If you point it at OneDrive, Dropbox, Google Drive or any synced folder, those secrets go to that provider, possibly outside your country. That may be exactly what you want (off-machine copies), but it is your decision to make knowingly.

## Data controller

We process no personal data: nothing ever reaches Tecniart Galicia / Argalla. Licence validation goes to Polar, which acts as merchant of record and controller for the purchase data.

## Questions

[github.com/TecniartGalicia/sessionkeeper/issues](https://github.com/TecniartGalicia/sessionkeeper/issues)
