# TermLoom

[English](README.md)

[![CI](https://github.com/Royalvice/termloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Royalvice/termloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Royalvice/termloom)](https://github.com/Royalvice/termloom/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

TermLoom 是一个直接运行在现有终端里的轻量本机/远端文件工作区。它以支持鼠标的文件
浏览器作为默认入口，按需打开终端，并且可以在不启动其他 App 的情况下渲染 Markdown、
图片、GIF、视频和公式。

TermLoom 不是 terminal emulator，不是 Ghostty 插件，也不是 macOS GUI App。OpenTUI
负责布局、输入、鼠标和绘制区域；system OpenSSH、远端 tmux、rclone SFTP、FFmpeg、
mpv、resvg、MathJax 和成熟 parser 继续负责协议与媒体处理。

## v0.2.0 已实现功能

- 永久将 **Local** 放在侧栏顶部；没有有效 workspace 时默认选中 Local 并打开
  `$HOME`，不需要 SSH、rclone 或 tmux。其下自动显示 `~/.ssh/config` 与递归
  `Include` 中可枚举的 literal aliases。
- 单击远端 Host 只打开 Files/SFTP。选择 Host 本身不会执行 `tmux list-sessions`，
  也不会擅自创建远端 shell。
- 在远端 Host 上按 `F2` 或点击 **Terminal** 后，明确选择 **Direct SSH** 或
  **Tmux**；只有选择 Tmux 才开始发现 session。
- 每个 Local/SSH target 各自保活 Files 与 Terminal surface。切换 surface、Host tab
  或分屏不会销毁隐藏的 PTY 或文件浏览状态。
- Termius 风格的自适应文件区：
  - 84 列及以上：父目录、当前目录、预览三栏。
  - 48–83 列：当前目录、预览双栏。
  - 小于 48 列：只显示当前目录；打开预览后按 `Escape` 返回。
- 目录、文本、图片、视频、压缩包、源码/配置、可执行文件和未知文件使用不同颜色；
  目录优先、自然排序。
- 单击文件立即选择，并在短暂防抖后预览；双击目录进入。选择目录时，预览区显示其
  子项摘要。
- 通过右键菜单、当前控件的键盘命令或 `F1` Help & Commands 使用新建文件/目录、
  重命名、复制、移动、上传、下载、搜索、刷新和取消传输。
- 本机与 SFTP 文件都**不提供删除命令**。只有 copy/move/rename/transfer 的显式
  overwrite 冲突策略可以替换目标。
- 在 OpenTUI pane 内只读渲染 GFM Markdown、表格、安全 HTML、inline/block TeX、
  PNG、JPEG、WebP、SVG、动画 GIF 和 MP4。本机 Markdown 直接按本机路径解析相对媒体；
  远端 Markdown 通过 SFTP 解析。
- GIF/MP4 支持播放/暂停、seek、音量、静音、进度和 pane-native fullscreen。FFmpeg
  生成画面；视频包含音轨时，mpv 以无窗口方式提供音频与播放时钟。
- host-key、私钥口令、密码和 2FA 都通过内嵌 system SSH PTY 完成。Files、Direct SSH
  与 Tmux 共享每 Host 的 ControlMaster，不建立第二套凭证存储。
- 使用 workspace schema v3 恢复上次 target、路径、选择、预览、Files/Terminal
  surface、tabs、splits、focus 与已 attach 的 terminal 意图。

## 复用的现有轮子

| 职责 | 实现 |
| --- | --- |
| TUI 布局、输入、鼠标与渲染生命周期 | OpenTUI Core、OpenTUI keymap |
| PTY 与 VT/ANSI 状态 | `bun-pty`、`@xterm/headless` |
| SSH 配置与认证 | system OpenSSH、每 Host ControlMaster |
| SSH Config 自动发现 | `ssh-config`、Bun glob，最终以 `ssh -G` 为真相 |
| 耐久远端会话 | 远端系统 tmux，仅在用户选择后加载 |
| 本机文件 | Node/Bun `fs/promises` + `LocalFileProvider` |
| 远端文件 | rclone `:sftp:` + `--sftp-ssh` 复用 ControlMaster |
| Markdown 与安全 HTML | unified、remark、rehype |
| 公式 | MathJax 生成 SVG，resvg 栅格化 |
| 图片/GIF/视频帧 | FFmpeg、ffprobe |
| 视频音频与时钟 | mpv JSON IPC，禁用视频与窗口输出 |
| 终端媒体 | Kitty Unicode placement、iTerm2 inline image、truecolor half-block cell |

完整 ownership 与生命周期见[架构文档](docs/architecture.md)。

## 环境要求

v0.2.0 二进制发布目标是 macOS arm64；源码构建与 CI 同时覆盖 Linux x64 和 macOS
x64。当前不支持 Windows。

本机文件浏览和本机文本/Markdown/媒体预览不依赖 SSH、tmux 或 rclone。以下外部程序
分别启用对应能力：

| 程序 | 用途 |
| --- | --- |
| `ssh` | 远端认证、Direct SSH、Tmux 与 SFTP transport |
| 支持 `--sftp-ssh` 的 `rclone` | 远端文件浏览与传输 |
| 远端 Host 上的 `tmux` | 用户显式选择的持久 session 路径 |
| `ffmpeg`、`ffprobe` | 图片/GIF/视频解码与元数据 |
| `mpv` | 含音轨视频的音频与播放时钟 |
| `resvg` | SVG 与 MathJax 栅格化 |

macOS 可使用：

```bash
brew install tmux rclone ffmpeg mpv resvg
```

Release archive 不捆绑或自动安装这些工具。启动前可检查当前环境：

```bash
termloom doctor
termloom doctor --json
```

`doctor --no-terminal-probe` 适合 CI 和非交互环境，但无法确认真实终端中的媒体协议。

## 安装

### macOS arm64 Release

从同一个 v0.2.0 GitHub Release 下载 archive 与 checksum：

```bash
shasum -a 256 -c termloom-v0.2.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.2.0-darwin-arm64.tar.gz
install -d "$HOME/.local/bin"
install -m 0755 termloom-v0.2.0-darwin-arm64/termloom "$HOME/.local/bin/termloom"
```

二进制经过 ad-hoc signing，**没有 Apple notarization**。如果 macOS 隔离下载文件，
先核对 SHA-256 与 GitHub Release 来源；确认信任该精确文件后：

```bash
xattr -d com.apple.quarantine "$HOME/.local/bin/termloom"
```

不要全局关闭 Gatekeeper。

### 从源码构建

开发和编译固定使用 Bun 1.3.14：

```bash
git clone https://github.com/Royalvice/termloom.git
cd termloom
bun install --frozen-lockfile
bun run check
bun run start
```

构建并验证当前平台的 native executable：

```bash
bun run build
bun run verify:build
```

`private: true` 是有意设置。TermLoom 通过源码与 GitHub Release 二进制发布，不发布
npm package。

## 第一次使用

运行 `termloom`。没有有效已保存 workspace 时，TermLoom 默认选择 **Local** 并打开
`$HOME`，不会执行任何 SSH 或 tmux 命令。

访问远端 Host：

1. 先准备可用的 OpenSSH alias。TermLoom 枚举 literal `Host`，递归展开 `Include`；
   wildcard-only 目标可通过侧栏 `+` 添加 alias。
2. 单击 Host；如有 host-key、私钥口令、密码或 2FA，在内嵌认证区完成。此时只打开
   Files/SFTP。
3. 单击文件预览，双击目录进入；在文件行或目录空白处右键打开相应操作。
4. 需要终端时按 `F2`。选择 **Direct SSH** 打开普通 shell，或选择 **Tmux** 后再
   发现、新建、attach 持久 session。
5. 再按 `F2` 回到 Files；隐藏的 terminal backend 继续运行。

TermLoom 只刷新当前远端 Files，以及用户已经明确打开过的 Tmux picker。健康的共享
ControlMaster 会被静默复用，不会重复广播连接状态或触发 Files refresh 循环。

## 鼠标与键盘

常用路径均可点击：单击选择/聚焦，双击激活，右键打开受 viewport 边界约束的菜单，
滚轮滚动鼠标所在区域，侧栏与 split divider 可以拖拽。Context menu 会在
`Escape`、点击外部、再次右键、执行菜单项、切换 target/surface/tab、resize、
renderer 失焦或被其他 overlay 替换时关闭。

底部唯一常驻提示是 `F1 帮助`；其他命令都可以在 Help & Commands 中搜索。

| 按键 | 操作 |
| --- | --- |
| `F1` | 打开可搜索的 Help & Commands |
| `F2` | 在当前 target 的 Files 与 Terminal 间切换 |
| `Ctrl+Q` | 刷新 workspace 状态并退出 |
| `Ctrl+G` | 默认高级命令 leader |
| `Ctrl+G Ctrl+G` | 向 terminal 发送原始 Ctrl+G/BEL |
| `Ctrl+G F2` | 向 terminal 发送原始 F2 序列 |
| `Ctrl+Space` | 不被 TermLoom 截获，直接进入当前 PTY |

文件浏览聚焦时可使用：`j/k` 或方向键、`Enter`、`Escape`/Backspace、`r`
刷新、`/` 搜索、`n` 新建文件、`N` 新建目录、`R` 重命名、`c` 复制、
`m` 移动、`u` 上传、`D` 下载、`x` 取消最近传输、`[`/`]` 翻页。具体可用项
取决于 Local/SFTP provider；没有文件删除按键。

完整 leader map 和配置说明见[配置与快捷键](docs/configuration.md)。

## 终端媒体行为

TermLoom 根据 OpenTUI 的实时 capability 选择 adapter。Direct Kitty 与 iTerm2-family
协议可以保留更多图像细节；当 direct image placement 不可用，或位于外层 tmux 中时，
使用仍然完全驻留在终端内的 truecolor-cell 渲染。

| 环境 | 预期 adapter | 协议 |
| --- | --- | --- |
| Ghostty direct | `truecolor-cells` | Truecolor half-block cells |
| Kitty direct | `kitty` | Kitty graphics + Unicode placement |
| WezTerm direct | `iterm2` | iTerm2 inline image |
| iTerm2 direct | `iterm2` | iTerm2 inline image |
| 外层 tmux 内 | `truecolor-cells` | Portable truecolor half-block cells |

精确的终端版本和带日期验收证据见[终端兼容性](docs/terminal-compatibility.md)。

## 验证状态

v0.2.0 source gate 覆盖：

- 当前 lockfile 下 165 个自动化测试、678 个断言、3 个终端尺寸 snapshot，没有用 skip
  或删除断言掩盖回归。
- Local provider、无公开文件删除能力、自适应彩色文件区、鼠标选择、预览防抖/取消和
  context-menu 全部关闭路径。
- SSH Config/Include 递归发现、内嵌认证、共享 ControlMaster、加密私钥、密码/2FA
  fixture、rclone SFTP、Direct SSH 和仅在显式请求后的 tmux 操作。
- config v1→v2、workspace v1/v2→v3 迁移，包括 Local/`$HOME` 默认值，以及旧远端
  terminal、splits、focus 和 tmux attach 的保留。
- Markdown、PNG/JPEG/WebP/SVG、GIF、MP4、MathJax、FFmpeg/ffprobe、mpv JSON IPC、
  resvg、传输取消和子进程 teardown。
- native compile verifier，以及 direct 和外层 tmux 中的真实 PTY journey。

GitHub-hosted Ubuntu x64 与 macOS x64 会重复 frozen install、format、lint、
TypeScript、licenses、完整测试、native compile 和 compiled-binary verifier。
Release 验收还要求匿名 clone/download、checksum、BUILDINFO、codesign、真实 PTY、
Local/SFTP/Direct SSH/显式 Tmux、媒体与精确进程清理全部一致。

## 持久化与隐私

| 数据 | 默认路径 |
| --- | --- |
| 配置 | `~/.config/termloom/config.toml` |
| Workspace 状态 | `~/.local/state/termloom/workspaces.json` |
| Resource 与 SSH control cache | `~/.cache/termloom/` |
| 诊断日志目录 | `~/.local/state/termloom/logs/` |

配置保持 schema v2；workspace 状态使用显式 Local/SSH target 的 schema v3。有效旧文档
会先校验、以仅用户可读权限备份、迁移、再次校验，再原子写入；无效文件会明确报错并
原样保留。

密码、私钥、passphrase、OTP 和 token 从来不是配置或 workspace 字段。Markdown 引用
的 HTTP(S) 资源在对 origin 发出第一次请求前即被阻止；按 `o` 本次允许，或按 `P`
持久允许一个不含 scheme/port/path/credential/wildcard 的裸域名。

## 文档

- [架构](docs/architecture.md)
- [配置与快捷键](docs/configuration.md)
- [终端兼容性](docs/terminal-compatibility.md)
- [故障排查](docs/troubleshooting.md)
- [发布流程](docs/releasing.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [第三方说明](THIRD_PARTY_NOTICES.md)

## 范围边界

v0.2.0 不提供文本编辑器、terminal emulator、SSH/SFTP 协议实现、tmux 替代品、媒体
codec、文件删除 UI、自动系统包安装、外部 GUI 兜底、npm package、Windows build、
Developer ID signing 或 Apple notarization。

## License

TermLoom 使用 [MIT License](LICENSE)。编译分发所需声明位于
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与生成的
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
