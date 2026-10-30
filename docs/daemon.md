# Scheduler daemon

```cmd
kepos daemon --home C:\work\kepos-home
```

The daemon owns a SQLite lease named `default`. The lease has an owner UUID, PID, heartbeat and expiry. A second process cannot dispatch the same plans while the lease is live. If the owner disappears, the lease expires and a new daemon may claim it.

The daemon is a foreground process by design. This makes shutdown, logs and human supervision explicit. Since 0.3.0-beta.5 a lost lease ends `run()` with an error and a non-zero exit instead of stopping silently, and a second daemon cannot start against the same data directory.

Use one data directory per daemon. `kepos supervise mission.json` remains a foreground single-plan runner and does not silently start unrelated plans.

## Windows service

`kepos service install --home <directory>` registers a `KeposScheduler` service via `sc.exe` from an elevated terminal; `start`, `stop`, `status`, and `delete` control it. The registration points at the current npm package entry and passes `daemon --home` explicitly. If PowerShell reports `OpenSCManager error 5`, the shell is not elevated; no service was installed.

**This path is unverified and likely broken**: a raw `sc.exe` registration does not set up the working directory and account environment the Node CLI needs, so the service may register but fail to start. Until packaging is fixed (for example a logon scheduled task), prefer running `kepos daemon` in a foreground terminal with explicit logs.
