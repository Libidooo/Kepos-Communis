# Third-party notices

Kepos depends on the Pi packages published by `@earendil-works`: `pi-coding-agent`, `pi-ai`, and `pi-tui`. Their package metadata and bundled notices are distributed with the installed dependencies. Kepos does not copy their source into this repository.

Before publishing a release, run `npm pack --dry-run`, inspect the resolved dependency licenses, and preserve upstream notices required by their licenses.

## Bundled binaries: fd (vendor/win32-x64/fd.exe, tools/*/bin/fd*)

fd by David Peter — MIT License, Copyright (c) 2017 David Peter.
Source: https://github.com/sharkdp/fd

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Bundled binaries: ripgrep (vendor/win32-x64/rg.exe, tools/*/bin/rg*)

ripgrep by Andrew Gallant — dual-licensed under the MIT License or the UNLICENSE, at your option. Copyright (c) 2015 Andrew Gallant.
Source: https://github.com/BurntSushi/ripgrep (full license texts: LICENSE-MIT, UNLICENSE)

Both licenses permit redistribution; the UNLICENSE dedicates the work to the public domain and the MIT license grants the same terms as reproduced above for fd.
