# TermLoom

[English](README.md)

[![CI](https://github.com/Royalvice/termloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Royalvice/termloom/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Royalvice/termloom)](https://github.com/Royalvice/termloom/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

TermLoom 是一个直接运行在你现有终端里的轻量远程工作区。OpenTUI 负责侧栏、标签页、
递归分屏、焦点、设置和绘制区域；system OpenSSH、远端 tmux、rclone SFTP、FFmpeg、
mpv、resvg、MathJax 和成熟 parser 负责协议与媒体处理。

它不是 terminal emulator，不是 Ghostty 插件，也不是 macOS GUI App。它在 Ghostty、
Kitty、WezTerm、iTerm2 等终端内运行，不会打开 Finder、Quick Look、浏览器或媒体播放器
窗口。

## 已实现功能

- 自动发现 `~/.ssh/config` 与递归 `Include` 中的 literal alias，同时继续由 system
  OpenSSH 处理 ProxyJump/ProxyCommand、agent、证书和 known_hosts。host-key、私钥口令、
  密码与 2FA 都在内嵌 PTY 中完成。
- 用一棵 Host tree 同时显示连接状态与自动发现的 tmux session；单击选择，双击、
  `Enter` 或可见的 Open/Attach 按钮负责激活。
- 每个 Host 独立保活 Files 与 Terminal 两个 surface。按 `F2` 或点击顶部切换时，隐藏的
  文件状态与 terminal backend 都不会销毁。
- SSH 中断后以有界指数退避重新 attach tmux；TermLoom 重启后恢复标签页、分屏、路径、
  焦点、主机和 session 意图。
- 浏览和搜索远端文件；新建、重命名、复制、移动、上传、下载和删除，带显式冲突策略、
  进度与取消。
- 在 OpenTUI pane 内只读渲染 GFM Markdown、表格、代码、安全 HTML、inline/block TeX、
  PNG、JPEG、WebP、SVG、动画 GIF 和 MP4。
- GIF/MP4 支持播放/暂停、seek、音量、静音、进度和 pane-native fullscreen。FFmpeg
  生成画面；只有视频含音轨时，mpv 才以无视频、无窗口方式提供音频与播放时钟。
- English/简体中文界面、默认 `Ctrl+G` 的可配置 leader、默认 `F2` 的快速切换、标签页、
  递归分屏，以及覆盖列表、按钮、滚动、右键菜单、slider 和 divider 拖拽的鼠标交互。
- `termloom doctor` 以版本化报告检查依赖、SSH alias、终端能力、配置/状态 schema、
  路径、权限和疑似凭证内容。

## 复用的现有轮子

TermLoom 明确不重新实现以下系统：

| 职责 | 实现 |
| --- | --- |
| TUI 布局、输入、状态和渲染生命周期 | OpenTUI Core、OpenTUI keymap |
| PTY 与 VT/ANSI 状态 | `bun-pty`、`@xterm/headless` |
| SSH 配置与认证 | system OpenSSH、每主机 ControlMaster |
| SSH Config 自动发现 | `ssh-config` 读取结构、Bun glob 展开 `Include`，最终以 `ssh -G` 为真相 |
| 耐久远端会话 | 远端系统 tmux |
| SFTP 操作 | rclone `:sftp:` + `--sftp-ssh` 复用已认证 ControlMaster |
| Markdown 与安全 HTML | unified、remark、rehype |
| 公式 | MathJax 生成 SVG，resvg 栅格化 |
| 图片/GIF/视频帧 | FFmpeg、ffprobe |
| 视频音频与时钟 | mpv JSON IPC，强制禁用视频与窗口输出 |
| 终端媒体 | Kitty Unicode placement、iTerm2 inline image 或 truecolor half-block cell |

完整 ownership 与生命周期见[架构文档](docs/architecture.md)。

## 环境要求

v0.1.0 二进制首发目标是 macOS arm64；源码构建与 CI 同时覆盖 Linux x64。本版本不支持
Windows。

以下程序必须位于 `PATH`：

- `ssh`
- 用于 session 的每台远端主机上的 `tmux`；真实集成测试还需要本地 tmux
- `rclone`
- `ffmpeg`、`ffprobe`
- `mpv`
- `resvg`

macOS 已自带 OpenSSH，其余运行依赖可通过 Homebrew 安装：

```bash
brew install tmux rclone ffmpeg mpv resvg
```

Release 包不会捆绑或自动安装这些工具。rclone 必须提供 `--sftp-ssh`；TermLoom 会用它
复用已经认证的 system OpenSSH ControlMaster，doctor 会显式检查该能力。启动 TUI 前先运行：

```bash
termloom doctor
termloom doctor --json
```

`doctor --no-terminal-probe` 用于 CI 等非交互检查。只有在真实 TTY 中运行 capability
probe，才能确认实际媒体 adapter。

## 安装

### macOS arm64 Release

从同一个 GitHub Release 下载压缩包与校验文件，校验后安装：

```bash
shasum -a 256 -c termloom-v0.1.0-darwin-arm64.tar.gz.sha256
tar -xzf termloom-v0.1.0-darwin-arm64.tar.gz
install -d "$HOME/.local/bin"
install -m 0755 termloom-v0.1.0-darwin-arm64/termloom "$HOME/.local/bin/termloom"
```

v0.1.0 二进制是 ad-hoc signed，**没有 Apple notarization**。如果 macOS 隔离下载的
二进制，请先验证 SHA-256 与 GitHub Release 来源；确认信任后，只移除这个精确文件的
quarantine：

```bash
xattr -d com.apple.quarantine "$HOME/.local/bin/termloom"
```

不要全局关闭 Gatekeeper。

### 从源码运行

项目固定使用 Bun 1.3.14 开发与编译：

```bash
git clone https://github.com/Royalvice/termloom.git
cd termloom
bun install --frozen-lockfile
bun run check
bun run start
```

编译当前平台原生二进制：

```bash
bun run build
bun run verify:build
```

`package.json` 保持 `private: true` 是有意设计：TermLoom 通过源码和 GitHub Release
二进制分发，不发布 npm 包。

## 快速开始

先保证目标已经是可用的 OpenSSH alias：

```sshconfig
Host lab
  HostName server.example.com
  User alice
  IdentityFile ~/.ssh/id_ed25519
```

```bash
ssh -G lab >/dev/null
ssh lab
```

启动 TermLoom：

```bash
termloom doctor
termloom
```

TermLoom 启动时读取 `~/.ssh/config` 与递归 `Include`，只列出 literal `Host` alias；
wildcard-only 目标可通过可见的 `+ Alias` 添加。发现 Host 不等于连接 Host，程序不会在
后台连接所有机器。

正常使用路径只有四步：

1. 点击 Host。TermLoom 默认打开该 Host 的 Files surface，并仅在需要时建立一条共享的
   OpenSSH ControlMaster。
2. 如果出现 host-key、私钥口令、密码或 2FA，在内嵌 SSH 认证面板完成。输入不会写入
   配置或 workspace 状态。
3. 直接浏览文件；同一连接会并行加载该 Host 的 tmux session，并显示在 Host 行下方。
4. 按 `F2` 或点击 `Terminal`。可以 attach 已有 session、显式新建 session，或打开 raw
   SSH shell。切回 Files 不会终止 PTY。

窗口重新获得焦点、网络恢复或合盖唤醒时，TermLoom 只检查并刷新当前 Host。应用重启后
恢复上次 Host、surface、路径、session、分屏与焦点，再通过远端 tmux reattach。rclone
SFTP 始终复用同一个已认证 OpenSSH ControlMaster，不建立第二套凭证存储。

## 键盘模型

高级命令 leader 默认是 `Ctrl+G`，可通过 `ui.leader` 修改。`F2` 在当前 Host 的 Files 与
Terminal 间切换，可通过 `ui.quickSwitch` 修改。`Ctrl+Space` 不再是 TermLoom 全局键，
会原样传给 tmux、shell、Vim、Codex 等远端程序。

| 按键 | 操作 |
| --- | --- |
| `Ctrl+Q` | 完整 teardown 后退出 TermLoom |
| `F1` | 打开可搜索、可点击的帮助与命令面板 |
| `F2` | 在当前 Host 的 Files / Terminal 间切换 |
| `<leader>s` / `<leader>v` | 水平 / 垂直拆分当前 pane |
| `<leader>x` | 在 pane 多于一个时关闭当前 pane |
| `<leader>n` / `<leader>p` | 聚焦下一个 / 上一个 pane |
| `<leader>a` / `<leader>w` | 新建本地 shell 标签页 / 关闭当前标签页 |
| `<leader>.` / `<leader>,` | 下一个 / 上一个标签页 |
| `<leader>]` / `<leader>[` | 将最近一层 split 放大 / 缩小 5% |
| `<leader>e` | 当前 pane 与下一个 pane 交换 |
| `<leader>b` | 显示/隐藏侧栏 |
| `<leader>g` / `<leader>t` | 打开设置 / 传输管理 |
| `<leader><leader>` | 向 terminal 发送当前 leader 对应的原始控制字节 |
| `<leader>F2` | 向 terminal 发送原始 F2 序列 |
| `Ctrl+Space` | 原样透传到 terminal PTY |

footer 只保留五个最常用提示；按 `F1` 可搜索和点击全部全局命令。文件、文档、设置与
传输视图仍保留各自的局部键盘操作。完整列表见[配置与键位](docs/configuration.md)。

## 终端媒体行为

TermLoom 根据 OpenTUI 实时能力探测选择明确 adapter，不承诺不同终端具有相同像素密度。

| 环境 | Adapter | 协议 | 当前 v0.1.0 证据 |
| --- | --- | --- | --- |
| Ghostty 1.3.1，direct | `truecolor-cells` | Truecolor half-block cells | direct 结构化 probe 与截图通过 |
| Kitty 0.48.1，direct | `kitty` | Kitty graphics + Unicode placement | direct 结构化 probe 与截图通过 |
| WezTerm 20240203，direct | `iterm2` | iTerm2 inline image | direct 结构化 probe 与截图通过 |
| iTerm2 3.6.11，direct | `iterm2` | iTerm2 inline image | direct 结构化 probe 与截图通过 |
| tmux 3.7b 内 | `truecolor-cells` | Truecolor half-block cells | Ghostty/Kitty/WezTerm/iTerm2 四种宿主均通过 |

`truecolor-cells` 仍然是 OpenTUI framebuffer 中的真实栅格内容，不是文件名或文字占位。
Kitty/iTerm2-family 的 direct 协议能保留更多图像细节。v0.1.0 在 tmux 内显式选择兼容性
更强的 truecolor cells，不依赖图形 passthrough。

完整矩阵、能力规则和证据边界见[终端兼容性](docs/terminal-compatibility.md)。

## 当前验证状态

重构后的 v0.1.0 本机 Release gate 当前通过：

- 140 tests、556 assertions、3 个终端尺寸 snapshot、0 failures。
- Biome format/lint 与 TypeScript strict typecheck。
- zsh、Vim、less、htop、tmux 的真实 PTY smoke test。
- SSH Config/Include 自动发现、config/workspace v1→v2 迁移、隔离 user-level OpenSSH、
  共享认证、真实加密私钥、显式标注为模拟的 password/2FA prompt 路径、ControlMaster、
  远端 tmux 耐久/re-attach、rclone SFTP、checksum、传输取消和完整文件操作。
- 真实 FFmpeg、ffprobe、mpv no-video JSON IPC、resvg、MathJax、动画 GIF 与含音轨 MP4，
  并验证子进程 teardown。
- macOS arm64 原生编译，以及 compiled `--version`、`--help`、doctor 验证。
- OpenTUI mock mouse 覆盖 Host/session/file 操作、认证 Cancel、窄工具栏、Settings、
  Transfers、媒体控制、侧栏/split 拖拽、terminal 鼠标转发与隐藏 surface PTY 保活。
- Ghostty、Kitty、WezTerm、iTerm2 宿主上的 direct/tmux 真实 TTY 验收，以及单独记录的
  当前代码结构化与可视证据。

GitHub-hosted Ubuntu 24.04 x64 与 macOS 15 x64 执行相同的 frozen install、format、lint、
TypeScript、license、完整测试、native compile、compiled doctor 与 artifact gate。CI badge
指向当前运行；精确 run/job ID 与原位替换资产的新旧审计链记录在
[v0.1.0 Release](https://github.com/Royalvice/termloom/releases/tag/v0.1.0)。带日期的真实终端
矩阵见[终端兼容性](docs/terminal-compatibility.md)。

公开 macOS arm64 archive 还必须从无认证 URL 回下载复验：发布 SHA-256、GitHub digest、
干净解包、ad-hoc codesign、`BUILDINFO.json`、version/help、隔离 doctor、真实 PTY teardown
及外部 SSH/tmux/SFTP/media smoke 必须一致。

## 状态、路径与隐私

TermLoom 尊重 XDG 环境变量，默认路径为：

| 数据 | 默认路径 |
| --- | --- |
| 配置 | `~/.config/termloom/config.toml` |
| Workspace 状态 | `~/.local/state/termloom/workspaces.json` |
| 资源与 SSH Control cache | `~/.cache/termloom/` |
| 诊断日志目录 | `~/.local/state/termloom/logs/` |

配置与 workspace 状态使用 schema v2 和原子写入。有效 v1 文件只迁移一次并保留权限为
user-only 的 `.v1.bak`；损坏文件会原样保留并报错，不会静默重置。密码、私钥、
passphrase、OTP 和 token 都不是配置或状态字段。

远端 Markdown 中的 HTTP(S) 资源在 origin 首次请求前被阻断。按 `o` 仅允许当前 origin
一次，或按 `P` 将域名持久写入配置。

## 文档

- [架构](docs/architecture.md)
- [配置与键位](docs/configuration.md)
- [终端兼容性](docs/terminal-compatibility.md)
- [故障排查](docs/troubleshooting.md)
- [发布流程](docs/releasing.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [第三方许可证说明](THIRD_PARTY_NOTICES.md)

## 明确不做的范围

v0.1.0 不提供远端文本编辑器、terminal emulator、SSH/SFTP 协议实现、tmux 替代品、
媒体 codec、系统包自动安装器、GUI fallback、npm 包、Windows build、Developer ID
签名或 Apple notarization。

## 许可证

TermLoom 使用 [MIT License](LICENSE)。编译分发涉及的说明与完整许可证正文位于
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和自动生成的
[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
