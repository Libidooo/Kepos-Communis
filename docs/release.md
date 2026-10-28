# Release checklist

1. `npm ci --ignore-scripts`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:legacy`
5. `npm run test:terminal:sdk` on Windows
6. `npm run test:terminal:profiles` on Windows
7. React Flow host fixture and Svelte compiler smoke
8. Remote TLS worker smoke
9. `kepos service install` from an elevated terminal
10. `npm run test:package`
11. `npm pack --dry-run` and inspect the whitelist
12. Check `LICENSE`, `THIRD_PARTY_NOTICES.md`, dependency licenses and version lock
13. Test `npm install -g <tarball>` in a clean Node 24 environment
14. Do not commit `~/.kepos`, `auth.json`, SQLite databases, `recovery/`, logs, or model outputs
