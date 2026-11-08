# per-OS 工具子包（esbuild/swc 模式）

主包把 Windows 的 fd/rg 直接打进 `vendor/win32-x64/`（对 GitHub Release 分发即刻生效）。
当其余平台也需要离线供给、且你已 `npm login` 后，用这里的脚手架发布平台子包：

```bash
npm login                       # 交互式，只需一次
npm run fetch:tools             # 在可达网络环境下抓取各平台 fd/rg 到 tools/<plat>/bin
npm run publish:tools           # 发布全部 kepos-tools-* 子包（公共、跳过未抓取的平台）
```

随后在主 package.json 的 `optionalDependencies` 加入（npm 会按 os/cpu 自动只装匹配平台）：

```json
"optionalDependencies": {
  "kepos-tools-win32-x64": "0.1.0",
  "kepos-tools-darwin-x64": "0.1.0",
  "kepos-tools-darwin-arm64": "0.1.0",
  "kepos-tools-linux-x64": "0.1.0"
}
```

启动器（bin/kepos.cjs 的 `prependBundledTools`）已经优先解析
`node_modules/kepos-tools-<plat>-<arch>/bin`，子包一发布即自动生效，无需改代码。

| 平台 | fd 资产 | rg 资产 |
|---|---|---|
| win32-x64 | `fd-v*-x86_64-pc-windows-msvc.zip` | `ripgrep-*-x86_64-pc-windows-msvc.zip` |
| darwin-x64 | `fd-v*-x86_64-apple-darwin.tar.gz` | `ripgrep-*-x86_64-apple-darwin.tar.gz` |
| darwin-arm64 | `fd-v*-aarch64-apple-darwin.tar.gz` | `ripgrep-*-aarch64-apple-darwin.tar.gz` |
| linux-x64 | `fd-v*-x86_64-unknown-linux-gnu.tar.gz` | `ripgrep-*-x86_64-unknown-linux-musl.tar.gz` |

许可证：fd 为 MIT，ripgrep 为 UNLICENSE——再分发均已记入 THIRD_PARTY_NOTICES.md。
