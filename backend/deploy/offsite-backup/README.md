# Mac 异地加密拉取

将服务器 `/var/backups/q` 的每日备份拉到本机 `/Users/kai/Desktop/异地备份`。每组包含同一 UTC 时间戳的数据库 dump、数据库 SHA256 与 `secrets/` 下部署配置。沿用服务器 dump 的排除策略，不重新读取业务表。清单检查三个文件的完整性、root 所有权与受限权限；导出时校验打开的数据库文件描述符 SHA256。仅打开同组描述符时短暂持有备份锁，流式传输前释放，因此网络慢不阻挡每日备份，已打开的文件即使被保留策略删除仍可完成传输。

传输通过现有 SSH；明文归档只经过管道，落盘内容只有 age 密文和密文 SHA256。客户端在原子发布前用现有 SSH 私钥通过 age 解密管道，验证归档成员及数据库 SHA；脚本不读取、复制或打印私钥和部署配置。保留本机最近 30 天的本工具输出，服务器仍为 14 天；仅完整密文和匹配侧车文件可参与清理。损坏/不完整文件会在下一次拉取时替换。启动时及每小时运行，互斥锁避免重叠。

**Mac 关机、退出登录、离线、SSH/密钥不可用时无法拉取**，下次登录/定时重试会优先拉取最新组，再补拉服务器仍保留的其余组；单组失败不阻断其他组，有任何失败则整次运行返回失败；超过服务器保留期的离线窗口不能补回。没有承诺持续可用、实时备份或自动告警。LaunchAgent 依赖用户登录；macOS 可能要求允许后台程序访问桌面。日志只有成功/失败状态，不含命令输出和秘密，需运维定期轮转。

## 审核后安装（本目录自身不会安装）

依赖：服务器 Python 3.9+；Mac Python 3.9+、OpenSSH、age（支持 ssh-ed25519 recipient）。已发现本机开发工具 `/Users/kai/Desktop/Q/backend/.local/deploy-tools/age/age`，版本 v1.3.2；由运维审核后安装到稳定路径并记录版本。无需添加网络运行库。确认 `id_ed25519_gitlab_kai.pub` 是现有私钥对应的公开 SSH recipient，不能把私钥复制到 recipient 文件。加密 SSH 私钥可能需要交互解锁；必须先验证无人值守可用，否则任务应失败而非绕过密钥保护。

1. 审核并将 `exporter.py` 安装为服务器 root:root 0755 `/usr/local/sbin/q-backup-export`；其父目录不可由 ecs-user 写入。用既有 sudo 或单独固定命令授权；脚本只接受 `list`、`export TIMESTAMP`，不接受路径。不要开放任意 Python/root shell。服务器现有备份任务保持原样。
2. 将 `pull.py` 和 `verify.py` 安装至 `/Users/kai/Library/Application Support/Q/offsite-backup/`，目录 0700、文件 0700。随后按下方“macOS 桌面权限修正”构建并安装专用应用；当前模板固定执行应用启动器，不直接执行 Python。不要让计划任务依赖交互 PATH。保留 SSH known_hosts，StrictHostKeyChecking=yes；首次信任必须人工核对，脚本不会自动接收主机密钥。
3. 通过最终安装位置的专用应用请求用户允许桌面访问，再运行固定 pull，确认目录为 0700、输出为 0600，并用 verify 再验。首次检查实际 PostgreSQL 恢复到独立测试库（不能覆盖业务库），包括迁移、账号和普通聊天持久化、临时数据排除；verify 只验解密/结构/校验和，不代替恢复演练。
4. 安装 plist 到 `~/Library/LaunchAgents/com.kaicloud.q.offsite-backup.plist`，`plutil -lint` 后 `launchctl bootstrap gui/$(id -u) ...`。仅在实际成功拉取和实际恢复后记录完成状态。卸载用 launchctl bootout 后移除 plist，保留已有备份。

恢复时可在受限临时目录使用 `age -d -i EXISTING_SSH_IDENTITY ARCHIVE | tar -xf -`，先用 verify 检查；`deploy.env` 含密钥，不输出到终端或测试日志，恢复完安全移除临时目录。SSH 私钥丢失将无法解密；私钥本身的安全备份需独立安排，不能与本目录密文一起公开。

测试：`python3 -m unittest discover -s backend/deploy/offsite-backup -p 'test_*.py'`。

真实 age 加密/解密/篡改验收：`Q_AGE_BIN=/absolute/path/age python3 -m unittest discover -s backend/deploy/offsite-backup -p 'test_*.py'`，测试使用临时测试密钥，不触碰现有 SSH 私钥。


## 本次验证记录（2026-10-22，安装前）

10 项测试通过，包含现有官方 age v1.3.2 的真实加解密与篡改拒绝、部分传输不得发布、原子文件发布中断恢复、去重、备份文件权限检查、导出期间解锁与清理原文件、损坏旧备份不阻止同步新备份。计划任务模板通过 `plutil -lint`；部署工具 64 项、网页部署工具 20 项、图库部署 54 项回归通过。源码审查发现的锁竞争及固定解释器问题已修复并复核。

配套 Nginx 配置在独立回环临时入口做实际请求验证：3 MiB / 5 MiB 请求可转发，5 MiB + 1 字节返回 413；两层配置均通过，未修改业务监听入口。此记录不等同异地备份已经安装，实际拉取、计划任务运行及恢复验收须在部署后另行记录。

## macOS 桌面权限修正（2026-10-22，待审核安装）

实际 LaunchAgent 验收发现：Python 定时进程能读取依赖并连接服务器，但枚举桌面目标目录被 TCC 拒绝（`PermissionError` / errno 1）。终端手动成功不能证明定时任务可用。不要给 Python 完全磁盘访问权限，也不要重置/修改 TCC 数据库绕过授权。

采用本目录 `macos/BackupLauncher.swift` 的 AppKit 应用启动器：固定 bundle ID `com.kaicloud.q.offsite-backup`，`Info.plist` 只声明 `NSDesktopFolderUsageDescription`。应用先通过 FileManager 访问固定目标文件夹，由 macOS 显示桌面权限提示，再执行原有固定 Python 拉取命令。没有任意路径、参数、shell 或凭据复制入口，子进程退出状态传回 LaunchAgent。Apple 文档说明首次无隐含同意的桌面访问会提示用户，并要求提供该用途说明：[NSDesktopFolderUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsdesktopfolderusagedescription)。是否成功归属该应用、子进程是否继承允许状态仍须在实际 GUI 与 LaunchAgent 中验证。

准备命令：`backend/deploy/offsite-backup/macos/prepare-app.sh`。只在当前工作树 `.local/offsite-backup-macos/Q Offsite Backup.app` 编译并临时签名，不启动、不安装、不修改计划任务。使用现有 `/usr/bin/swiftc` 与 AppKit，无第三方依赖。当前 app 固定调用 `/usr/bin/python3`、已有 `~/Library/Application Support/Q/offsite-backup/{pull.py,verify.py,age}` 与原 SSH 身份位置。

审核及 MR 合并后，将构建应用完整安装到 `/Users/kai/Library/Application Support/Q/offsite-backup/Q Offsite Backup.app`（父目录 0700）；通过图形界面首次打开该**最终安装位置**的应用，由用户确认系统的桌面访问提示。用户拒绝时任务失败并保留现有密文，不自动申请更广权限。不要从临时构建目录先授权后宣称正式安装也已授权。ad-hoc 签名不是 Developer ID 发布签名；保留稳定路径、bundle ID 与已审核二进制，后续重建更新可能重新要求用户允许，必须重新验收，不能宣称跨升级永久保留授权。

模板 LaunchAgent 已改为直接运行稳定 `.app/Contents/MacOS/QBackupLauncher`，无参数。完成首次 GUI 同意后，再用新模板替换旧任务并 bootstrap/kickstart，核对真实退出状态、密文校验及新增备份；必须确认至少一次由 launchd 启动的实际拉取成功，才能标记定时异地备份可用。仅打开应用或看见权限项不算完成。既有定时任务在替换前仍有桌面权限阻碍。日志依旧只含通用状态。
