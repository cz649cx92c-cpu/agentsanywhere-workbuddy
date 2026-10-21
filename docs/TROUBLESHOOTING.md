# 排障、升级与回退

## WorkBuddy 没出现在列表

- 完全退出 Agents Anywhere（包括托盘后台进程）后重新打开。只有刷新页面不会重新导入 Python 代码。
- 先运行一次 Agents Anywhere，让 managed Connector 在数据目录初始化，再安装适配器。
- 检查安装预览是否包含当前使用的 managed Connector 包。路径不同时，显式指定 `-AgentsAnywhereData` 或 `-ConnectorPath`。
- 当前支持可编辑的 Python Connector 2.0.3。二进制打包或未知注册结构会停止安装，不应手动猜测替换位置。
- 服务端须能接受动态 runtime type / instance，并且客户端支持能力驱动的显示。仅安装本机 Python 包不能使所有官方云/旧客户端自动支持自定义类型。

## 显示错误或未就绪

先执行 `node .\scripts\monitor.cjs --once`。

- `start_workbuddy_with_bridge_shortcut`：完全退出普通方式启动的 WorkBuddy，使用新快捷方式启动。无现成调试端口时监控不会重启软件。
- `bridge_or_models_unavailable`：检查 WorkBuddy 登录、账号的可用模型、`stateDir` 下的 `bridge.log`，并确认版本。日志留在本机，不要直接公开完整应用日志。
- `launcher_busy`：已有启动流程正在等待 WorkBuddy，稍等再检查，避免反复点击。
- 本地正常、AA 仍报错：检查本机 Connector、你的服务器和网络。打开设备页查看运行时原因；必要时仅重新启用 WorkBuddy 运行时。此工具不自动登录服务器或结束 Connector。

桥绑定随机 loopback 端口，数据只存本机。不要固定或公开此端口，不要上传 `endpoint.json`、`operations.json` 或本地账号文件。

## 更新覆盖文件时怎么办

1. 先退出 WorkBuddy / Agents Anywhere，保留 `.local/install-manifest.json`；它记录原文件与安装后哈希。
2. 运行安装或卸载的 `-WhatIf` 查看冲突路径，不要为了绕过检查删除 manifest。
3. 若上游更新已改变文件，人工比较 manifest 中的旧版本、当前版本和适配器再决定如何合并；遇到未知格式需更新安装器。
4. 对全新安装的客户端或新的安装根目录，建议使用新的仓库 checkout 安装，并显式指定新目录。保留旧 checkout 的回退记录，先停用旧监控，避免两个实例争用快捷方式。

安装器只按记录恢复具体文件，不递归删除软件目录。卸载拒绝覆盖任何哈希已变化的文件，避免撤销别人的更新。

## 更换项目目录、移动仓库

安装时只允许一个固定目录。要换目录，先停用运行时并退出软件，卸载后在新的 checkout / 项目路径重新安装，再配置 Agents Anywhere 项目和运行时。

不要移动已安装的仓库：Connector helper、快捷方式和计划任务保存绝对路径。先卸载、再移动、再安装。原生 WorkBuddy 聊天与桥去重状态会保留，不需要复制别人的账号文件。

## 监控选择

- 不想后台定时运行：`./set-monitor.ps1 -Mode off`。
- 只想知道本地连接状态：选择 `check`，读取 `monitor-status.json`。
- 允许修复桥连接但不干扰软件：选择 `repair`。它只接入现有 WorkBuddy 调试端口；不会结束任何应用，不会启动你已经关闭的软件。

计划任务名按 checkout 路径生成，以当前用户的普通权限运行，每两分钟检查一次，仅用户登录时有效。关闭计算机或退出 Windows 后不会持续监控。任务执行最长三分钟且忽略重叠调用；桥启动器另外使用互斥锁。
