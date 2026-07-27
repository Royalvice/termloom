export const englishCatalog = {
  "app.name": "TermLoom",
  "status.ready": "Ready",
  "status.connecting": "Connecting",
  "status.connected": "Connected",
  "status.reconnecting": "Reconnecting",
  "status.error": "Error",
  "sidebar.hosts": "Hosts",
  "sidebar.sessions": "Sessions",
  "sidebar.files": "Files",
  "pane.terminal": "Terminal",
  "pane.files": "Files",
  "pane.preview": "Preview",
  "footer.shortcuts": "Ctrl+Space: commands  ? help  Ctrl+Q quit",
  "error.unsupported": "Unsupported capability: {capability}",
  "error.missingDependency": "Missing dependency: {dependency}",
  "empty.hosts": "No hosts configured",
  "empty.sessions": "No sessions loaded",
  "empty.files": "No directory loaded",
} as const;

export type MessageKey = keyof typeof englishCatalog;
export type Catalog = Readonly<Record<MessageKey, string>>;

export const simplifiedChineseCatalog: Catalog = {
  "app.name": "TermLoom",
  "status.ready": "就绪",
  "status.connecting": "正在连接",
  "status.connected": "已连接",
  "status.reconnecting": "正在重连",
  "status.error": "错误",
  "sidebar.hosts": "主机",
  "sidebar.sessions": "会话",
  "sidebar.files": "文件",
  "pane.terminal": "终端",
  "pane.files": "文件",
  "pane.preview": "预览",
  "footer.shortcuts": "Ctrl+Space：命令  ? 帮助  Ctrl+Q 退出",
  "error.unsupported": "不支持的能力：{capability}",
  "error.missingDependency": "缺少依赖：{dependency}",
  "empty.hosts": "尚未配置主机",
  "empty.sessions": "尚未加载会话",
  "empty.files": "尚未加载目录",
};
