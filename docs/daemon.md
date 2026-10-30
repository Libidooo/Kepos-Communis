# Scheduler daemon

```cmd
kepos daemon --home C:\work\kepos-home
```

The daemon owns a SQLite lease named `default`. The lease has an owner UUID, PID, heartbeat and expiry. A second process cannot dispatch the same plans while the lease is live. If the owner disappears, the lease expires and a new daemon may claim it.

The daemon is a foreground process by design. This makes shutdown, logs and human supervision explicit. Since 0.3.0-beta.5 a lost lease ends `run()` with an error and a non-zero exit instead of stopping silently, and a second daemon cannot start against the same data directory.

Use one data directory per daemon. `kepos supervise mission.json` remains a foreground single-plan runner and does not silently start unrelated plans.

## Windows autostart (scheduled task)

`kepos service install --home <directory>` registers a per-user scheduled task named `KeposScheduler` that starts the daemon at logon. It needs **no administrator rights** and never stores your credentials in a system account. `start`, `stop`, `status`, and `delete` map to run/end/query/unregister of that task.

Two earlier approaches were rejected: a raw `sc.exe` registration starts and dies with error 1053 (node.exe does not implement the Windows service protocol), and `schtasks /SC ONLOGON` from the CLI demands elevation. The logon-triggered per-user task is verified working unelevated on Windows 10/11.

The task only runs while your session exists: it starts when you sign in and does not survive a reboot until you log in again. For always-on service semantics, wrap the daemon yourself or run it under a dedicated account.
