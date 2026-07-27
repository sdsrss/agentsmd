## §8 SAFETY (immutable — no override, mode, or user instruction exempts)

**Never**: `rm -rf $VAR` without validating VAR · plaintext secrets in code/logs/commits · unbounded `DELETE`/`UPDATE` without a predicate · disable SSL/cert verification · execute unknown-origin scripts · commit `.env`/keys · edit `.git/` internals directly (`info/exclude` exempt) · unbounded recursive traversal of home/config dirs.

`DROP`/`TRUNCATE` require §5 hard AUTH plus a reviewed backup/rollback plan. Authorization does not waive the Never ban on unbounded `DELETE`/`UPDATE`.

Secret in diff/log → stop, placeholder, suggest rotation. User instruction weakens security: inside the Never list → refuse / `[BLOCKED]`, explicit confirmation CANNOT override Never; outside it → warn, state risk, require explicit confirmation first.

