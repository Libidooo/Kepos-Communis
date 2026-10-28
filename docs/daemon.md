# Scheduler daemon

```cmd
kepos daemon --home C:\work\kepos-home
```

The daemon owns a SQLite lease named `default`. The lease has an owner UUID, PID, heartbeat and expiry. A second process cannot dispatch the same plans while the lease is live. If the owner disappears, the lease expires and a new daemon may claim it.

The daemon is a foreground process by design. This makes shutdown, logs and human supervision explicit. Windows service installation is a later packaging layer; the daemon itself already has signal cleanup and worker shutdown.

Use one data directory per daemon. `kepos supervise mission.json` remains a foreground single-plan runner and does not silently start unrelated plans.

## Windows service

Run `kepos service install --home <directory>` from an elevated terminal. The service name is `KeposScheduler`; use `start`, `stop`, `status`, and `delete` to control it. The registration points at the current npm package entry and passes `daemon --home` explicitly.

On Windows, use an elevated terminal and prefer a service-owned home such as `C:\ProgramData\Kepos` rather than a protected user folder. The service install command creates the directory and settings before calling `sc.exe`. If PowerShell reports `OpenSCManager error 5`, the shell is not elevated; no service was installed.
