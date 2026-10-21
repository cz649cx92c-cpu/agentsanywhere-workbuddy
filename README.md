# Agents Anywhere × WorkBuddy

在 **自托管 Agents Anywhere** 中选择 WorkBuddy，查看指定项目的原生会话、新建对话、继续对话、选择 WorkBuddy 模型和处理基础审批。

这是社区适配器，面向 Windows。通过本机桥接连接已安装的 WorkBuddy；不分发、替换或修改 WorkBuddy 的 EXE / ASAR，不包含模型、账号、聊天记录或服务器凭据。模型仍由你自己的 WorkBuddy 账号提供。

## 支持范围

| 项目 | 当前支持 |
| --- | --- |
| 系统 | Windows 10 / 11，当前登录用户的桌面环境 |
| WorkBuddy | **5.8.4** 的原生新建、续聊、模型选择和重启恢复有历史实机验证 |
| Agents Anywhere | **2.0.3**，含可编辑 Python Connector 的桌面安装；需要先完成首次启动 |
| Node.js | **24 或更高**，使用内置 WebSocket，无 npm 依赖 |
| 项目 | 安装时指定一个已经存在的本地项目目录，仅操作该目录中的会话 |
| 服务端 | 自行部署并登录的 Agents Anywhere；本仓库不部署服务端，也不保证官方云接受自定义 runtime |

二进制形式且没有 Python 源文件的 Connector、macOS、Linux / Pi，以及未来版本的兼容性尚不支持或未经验证。更新后的 WorkBuddy 会尝试现有桌面接口并检查版本、模型目录和会话清单；不能保证每次更新都兼容。公开版仅接入原生桌面会话，不自动切换到另一套 CLI 会话。

## 1. 准备软件

1. 安装 [Git for Windows](https://git-scm.com/downloads/win) 和 [Node.js 24](https://nodejs.org/en/download)。重新打开 PowerShell，确认 `git --version`、`node --version` 正常。
2. 安装并登录 WorkBuddy，在软件中确认能正常选择模型、发送消息。
3. 按 [Agents Anywhere 上游说明](https://github.com/anywhere-labs/Agents-Anywhere) 完成自己的服务端和 Windows 桌面客户端部署。在客户端填写自己的服务器地址并登录，绑定本机；先打开一次客户端，让受管 Connector 初始化完成。
4. 准备一个现有的项目目录。例如 `C:\Projects\MyApp`。不要把项目目录填成软件安装目录。

此安装器只安装适配器和独立快捷方式；不会安装 Node.js、WorkBuddy 或 Agents Anywhere，不会要求你的服务器密码或 GitHub Token。

## 2. 克隆并安装

在普通 PowerShell 中运行。建议放在长期保留、当前用户可写的目录，**不要安装后移动或删除这个仓库**。

```powershell
git clone https://github.com/cz649cx92c-cpu/agentsanywhere-workbuddy.git
cd agentsanywhere-workbuddy
.\install.ps1
```

按提示填写：

- **WorkBuddyAI.exe 路径**：右键 WorkBuddy 快捷方式 → 属性 → 查看目标。
- **允许操作的项目目录**：例如 `C:\Projects\MyApp`，必须已经存在。
- **Agents Anywhere 安装根目录**：安装版通常包含 `resources`，便携目录可能包含 `app\resources`。
- **是否开启监控**：默认 `0`，见下一节。

如果当前 PowerShell 阻止本地脚本运行，可在确认源码后仅对本次进程运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

不需要永久修改系统执行策略。若应用装在受保护的目录而出现写入拒绝，请将软件安装到当前用户可写的目录；本项目不自动提权。

也可以显式指定所有参数，先预览改动：

```powershell
.\install.ps1 `
  -WorkBuddyExe 'C:\Apps\WorkBuddy\WorkBuddyAI.exe' `
  -Workspace 'C:\Projects\MyApp' `
  -AgentsAnywhereRoot 'C:\Apps\Agents Anywhere' `
  -MonitorMode off `
  -WhatIf
```

确认路径后去掉 `-WhatIf` 安装。目录自动发现不适合你的安装布局时，可用 `-ConnectorPath` 指定一个或多个 **connector Python 包目录**：其中必须有 `runtimes\providers.py`、`server\protocol.py` 和 `runtime_protocol\supervisor.py`。可用 `-AgentsAnywhereData` 指定含 `connector-source` 的数据目录；`-NodePath`、`-StateDir` 也可以覆盖默认值。

安装前请退出 WorkBuddy 和 Agents Anywhere，等待后台进程退出，避免边运行边更新文件。安装器会修改发现的 bundled / managed Connector 注册及协议文件，添加 `workbuddy` 包，并保存原文件；遇到未知结构会停止。

## 3. 选择是否监控掉线

| 安装选项 | 行为 |
| --- | --- |
| `0` / `-MonitorMode off` / `-DisableWatchdog` | 不创建定时监控任务，默认值 |
| `1` / `-MonitorMode check` | 每两分钟检查本地认证桥及模型目录，仅记录状态 |
| `2` / `-MonitorMode repair` / `-EnableWatchdog` | 检查失败时，尝试重新连接**已在运行、已有本机调试端口**的 WorkBuddy 桥 |

安装后随时切换，无需重装：

```powershell
.\set-monitor.ps1 -Mode check
.\set-monitor.ps1 -Mode repair
.\set-monitor.ps1 -Mode off
```

监控使用当前用户的 Windows 计划任务，仅在用户登录时运行，不保存登录密码。不会启动已被你关闭的 WorkBuddy、强制结束程序、重启 Connector、发送消息、创建会话或批准操作。

**监控范围是本地桥和模型目录，不是服务器在线状态的端到端保证。** 服务器、网络、客户端或 Connector 本身离线，需要分别排查。Connector 适配器本身有短暂断连后的重试能力；关闭可选监控不会关闭必要的会话同步和重连。

手动查看一次本地状态（只读，不修复）：

```powershell
node .\scripts\monitor.cjs --once
```

结果写在安装配置 `stateDir` 下的 `monitor-status.json`；仅状态变化追加到 `monitor.log`，并限制日志大小。无邮件、IM 或外部告警。

## 4. 在 Agents Anywhere 使用

1. 完全退出并重新启动 Agents Anywhere，让 Connector 加载新适配器。
2. 从桌面新增的 **WorkBuddy - Agents Anywhere** 快捷方式启动 WorkBuddy，保持它运行。原有快捷方式保持原样。
3. 如果此前普通方式启动的 WorkBuddy 仍在后台，请手动退出一次，再使用新快捷方式。安装器和监控不会强制关闭它。
4. 在 Agents Anywhere 打开本机设备，点刷新，在可添加运行时中添加 **WorkBuddy**。
5. 添加/选择与安装时相同路径的项目，创建会话时选择 WorkBuddy。已有原生会话需要接管后才能继续。
6. 从运行时返回的模型列表选择需要的模型。如果你的账号提供 `Deepseek-V4.1-Flash`，直接选择；安装器不强制默认模型，不保证每个账号的模型相同。

登录自托管服务仍然是必要的，用于保护设备与会话；这不等于连接 Agents Anywhere 官方云。WorkBuddy 自身的登录和模型网络请求由 WorkBuddy 管理。

## 更新与卸载

更新前退出两个软件，在本仓库运行：

```powershell
git pull --ff-only
.\install.ps1
```

重新确认同一项目及软件路径，并选择监控模式。Git 拉取只更新仓库代码，**不会自动重装 Connector**。上游客户端升级可能覆盖适配器或改变目录，请再运行安装检查；若检测到安装文件被其他更新改过，安装/卸载会拒绝覆盖，先参阅 [排障及回退说明](docs/TROUBLESHOOTING.md)。

卸载前在 Agents Anywhere 中停用 WorkBuddy 运行时并退出两个软件，然后运行：

```powershell
.\uninstall.ps1 -WhatIf
.\uninstall.ps1
```

卸载关闭本仓库的监控任务，删除本仓库创建的快捷方式，按文件哈希检查后恢复安装前的 Connector 文件。它保留原生聊天、账号、模型设置和桥接去重状态。重新启动 Agents Anywhere 完成卸载。

## 实现与验证

```text
Agents Anywhere 客户端 → 你的服务端 → 本机 Connector
                                      ↓
                              认证 Windows named pipe
                                      ↓
                             独立桥 → WorkBuddy 桌面 SDK
```

本地 Electron 调试端口只用于桌面桥，绑定 `127.0.0.1`，不可转发到公网。该端口具有本机桌面调试权限；桥的认证状态目录由安装器限制为当前用户 / SYSTEM。只允许安装时指定的项目、固定 RPC 动作和 WorkBuddy 原生审批选项；未知发送结果不会自动重放。暂不支持附件、steer、复杂问卷和所有工具审批类型。

测试不需要 npm install：

```powershell
npm test
# 有 Connector 2.0.3 环境时，补跑 Python 检查：
.\scripts\test.ps1 `
  -PythonPath 'C:\path\to\connector\.venv\Scripts\python.exe' `
  -ConnectorPackageParent 'C:\path\to\resources\connector'
```

公开版本已在 Windows 上通过安装/回退、监控分支、认证、会话身份和断线重试的隔离测试。历史 5.8.4 集成曾实测真实新建、续聊及重启恢复；这不代表公开安装器已在所有新电脑/账号上完成实测。详细验证边界见 [验证记录](docs/VALIDATION.md)。

仓库的 `.local/`、`config.local.json`、认证端点、日志与原文件备份均不提交。不要分享整个安装目录的数据文件。
