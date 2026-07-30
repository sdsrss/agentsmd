verified: 2026-07-30 | source: official Claude Code/Codex docs + agentsmd lifecycle tests

# Automatic memory lifecycle

Use three distinct memory layers:

1. `AGENTS.md` plus repository `MEMORY.md`/`memory/*.md` are reviewed,
   version-controlled team instructions and durable lessons.
2. Codex native Memories are the opt-in, model-driven layer. They decide which
   eligible chat facts matter later, redact generated fields, and consolidate in
   the background. Never silently enable this privacy/quota choice.
3. agentsmd handoff capsules provide deterministic timing continuity. A
   substantial completed Stop captures only a redacted, bounded
   `last_assistant_message`; SessionEnd finalizes the matching capsule; a fresh
   same-repository SessionStart restores recent candidates.

Do not assume `/new` synchronously emits SessionEnd. The prior completed Stop is
the checkpoint that lets a fresh chat recover immediately. Normal `/exit` can
finalize through SessionEnd, whose official budget is at most three seconds.
Never invoke a model or parse the unstable transcript format in SessionEnd.

Git common-directory identity makes worktrees share handoffs. The official hook
contract provides no parent/predecessor ID for parallel chats, so restored
capsules are untrusted recency candidates, not a claimed immediate predecessor.
They cannot authorize actions, override current instructions/files, weaken
safety, or expand scope.

Handoff state is machine-local and physical-surface-private. Do not read
separate prompt, tool-input, tool-output, patch, or transcript fields. Hash raw
session IDs and replace matching raw/physical repository paths in the assistant
message. The user-visible message can itself quote commands, relative paths, or
code; retain the explicit untrusted label. Keep atomic `0700`/`0600` storage,
high-confidence secret redaction, byte/count/age bounds, exact-name cleanup, and
the shared `DISABLE_SESSION_HANDOFF_HOOK=1` kill switch.
