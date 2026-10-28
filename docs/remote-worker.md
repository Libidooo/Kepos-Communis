# Remote Worker

The remote Worker protocol uses newline-delimited JSON over TCP/TLS:

- `health`
- `submit`
- `status`
- `result`
- `cancel`
- `events`

A token is required for every request. Plaintext binding is accepted only on loopback; non-loopback binding requires both `--tls-cert` and `--tls-key`.

```cmd
set KEPOS_WORKER_TOKEN=use-a-long-random-value
kepos worker serve --host 0.0.0.0 --port 7788 --token %KEPOS_WORKER_TOKEN% --tls-cert server.crt --tls-key server.key
```

The server stores internal Worker capability handles and returns only a remote job id. The current scheduler still defaults to local dispatch; remote routing and zone-aware failover are the next layer.
