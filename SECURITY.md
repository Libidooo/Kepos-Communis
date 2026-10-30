# Security

Kepos never stores credentials in the repository. Provider credentials are handled by the Pi SDK under the selected Kepos home, normally `~/.kepos/agent/auth.json`. Remote Worker authentication is supplied through `KEPOS_WORKER_TOKEN` or an explicit CLI argument and is never generated, persisted, or logged by Kepos.

Do not commit `.env` files, `auth.json`, private keys, certificates with private material, SQLite databases, session JSONL files, or terminal captures. The public audit runs in CI and rejects high-confidence API keys, private-key headers, credential filenames, and credential-like URL query parameters.

The documented Worker port `7788` is only an example listening port. It is not a credential. Runtime defaults bind the Worker to loopback; non-loopback binding requires TLS and a token.

## Approval modes and main-agent boundaries (0.3.0-beta.5)

The main agent runs with the Pi SDK's default tools (read/bash/edit/write), so a determined model could previously have approved its own human gates or mutated Kepos's own store through shell commands. Kepos now ships three approval postures (F2 → 审批模式, persisted in config, default strict):

- **严格（默认）**：tool calls that approve gates (`kepos … approve` in a single pipe-free segment) or touch Kepos data (`orbital.sqlite`, the `.kepos` home with write-ish operators, or edit/write paths under the data directory) trigger a confirmation dialog; refusal or a missing UI blocks the call and the model is told to involve the human.
- **代理审批**：the model may approve plan gates (`orbital_plan` action `approve`, `NEEDS_HUMAN` jobs only) and proceed through those calls; every proxy approval and data mutation surfaces a notice in the workspace.
- **只读监督**：bash/powershell/edit/write are removed from the main agent's active tool set, so gate or store mutation is not possible at all; delegation tools and read-only orbital tools stay available (child workers keep their own read-only tool constraint).

This is an application-level control: pattern matching can be evaded by a model deliberately obfuscating commands, and the strict/proxy postures are audit-and-confirm barriers rather than cryptographic guarantees. The hard boundary is the readonly posture. OS-level isolation of the store is tracked as future work.

## Worker sandbox (0.3.0-beta.5)

Delegated workers run as separate Pi processes with read-only tools only (read/grep/find/ls; anything else is refused at launch). Two controls bound what they can reach:

- **Environment whitelist**: worker processes receive only Node/runtime essentials, Pi's credential-directory variables, and `ORBITAL_PARENT_PID`. Secrets in the operator's shell (API keys, cloud tokens) no longer reach workers. Providers that authenticate through environment variables can be passed explicitly with `KEPOS_WORKER_ENV_PASSTHROUGH=KEY1,KEY2`.
- **Read sandbox**: a sandbox extension loaded into every worker guards the read tools' targets. Always refused, with no override: the Kepos data directory (`workspace.json`, `orbital.sqlite`), credential stores (`.ssh`, `.aws`, `.gnupg`, `.azure`, `.kube`, `.docker`, `.gcloud`), and auth-style files (`auth.json`, `.env`, `credentials`, `id_rsa`) under the user home. Beyond that, read scope is adjustable per delegation: `project` (default — the task directory plus `readAllow` directories) or `machine` (everything except the deny list). Confidentiality-sensitive delegations should stay on `project`.

Boundaries: the sandbox intercepts the model's tool calls, not Pi's internal file access — a worker still reads the provider credentials it needs to call its model, which is unavoidable without a model-proxy architecture. Reads that are allowed still flow back to the lead agent as evidence. The capability stored in `mission_jobs` rows is now a hash, so a leaked database no longer hands out live handles.

To report a security issue, open a private GitHub security report on the repository or contact the maintainer before publishing exploit details.
