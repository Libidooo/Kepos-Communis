# Event retention

```cmd
kepos retention --days 30 --max-events 100000
```

Worker, Mission and Graph events older than the age limit are moved to SQLite `event_archive`. The per-source row cap is applied afterward. Archive reads are cursor-based and retain source/entity/sequence/type/payload metadata.

Pi session JSONL is not deleted by retention. It remains the authoritative conversation history. Retention only handles derived task and orchestration events.
