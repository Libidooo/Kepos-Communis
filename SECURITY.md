# Security

Kepos never stores credentials in the repository. Provider credentials are handled by the Pi SDK under the selected Kepos home, normally `~/.kepos/agent/auth.json`. Remote Worker authentication is supplied through `KEPOS_WORKER_TOKEN` or an explicit CLI argument and is never generated, persisted, or logged by Kepos.

Do not commit `.env` files, `auth.json`, private keys, certificates with private material, SQLite databases, session JSONL files, or terminal captures. The public audit runs in CI and rejects high-confidence API keys, private-key headers, credential filenames, and credential-like URL query parameters.

The documented Worker port `7788` is only an example listening port. It is not a credential. Runtime defaults bind the Worker to loopback; non-loopback binding requires TLS and a token.

To report a security issue, open a private GitHub security report on the repository or contact the maintainer before publishing exploit details.
