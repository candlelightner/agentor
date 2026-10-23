# Repository instructions

## Visible failure reasons

When adding a timeout, limit, guard, or other behavior that can abort an
operation, block progress, or cause a crash, document why it exists and log
the reason when it triggers and the resulting outcome. Include whether the
operation stopped, cleanup completed, or recovery is still needed. Do not
leave silent blockers; keep diagnostics bounded and free of secrets.

## Publication privacy

Do not publish deployment-specific server information to GitHub. Keep real
operational logs, diagnostic journals, inventories, recovery receipts and local
incident histories private and untracked. This includes real host/user/worker
names and IDs, domains, IP/MAC addresses, disk UUIDs/serials, host paths,
production topology or runtime state, and backup/recovery-key metadata. Never
publish credentials, tokens, private keys or authentication databases.

Use synthetic identifiers/placeholders and reusable product documentation or
reproducible tests instead. Review staged diffs and outgoing prose for private
operational details before publishing. Apply this rule to every public surface:
all branches and tags, commit messages, PRs, issues/comments, Actions logs and
artifacts, and published image contents/metadata. An archive tag is still public.

Authorization to save work, commit or push code does not authorize publishing
server diagnostics. If specific operational information is necessary, ask the
user to approve the exact information before publication. Before removing or
redacting existing published material, deleting privacy-related refs, or rewriting
history, discuss the proposed cleanup and impact with the user and obtain approval.
