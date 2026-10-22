# Mac 异地加密拉取

将服务器 `/var/backups/q` 的每日备份拉到本机 `/Users/kai/Desktop/异地备份`。每组包含同一 UTC 时间戳的数据库 dump、数据库 SHA256 与 `secrets/` 下部署配置。沿用服务器 dump 的排除策略，不重新读取业务表。清单检查三个文件的完整性、root 所有权与受限权限；导出时校验打开的数据库文件描述符 SHA256。仅打开同组描述符时短暂持有备份锁，流式传输前释放，因此网络慢不阻挡每日备份，已打开的文件即使被保留策略删除仍可完成传输。

传输通过现有 SSH；明文归档只经过管道，落盘内容只有 age 密文和密文 SHA256。客户端在原子发布前用现有 SSH 私钥通过 age 解密管道，验证归档成员及数据库 SHA；脚本不读取、复制或打印私钥和部署配置。保留本机最近 30 天的本工具输出，服务器仍为 14 天；仅完整密文和匹配侧车文件可参与清理。损坏/不完整文件会在下一次拉取时替换。启动时及每小时运行，互斥锁避免重叠。

**Mac 关机、退出登录、离线、SSH/密钥不可用时无法拉取**，下次登录/定时重试会优先拉取最新组，再补拉服务器仍保留的其余组；单组失败不阻断其他组，有任何失败则整次运行返回失败；超过服务器保留期的离线窗口不能补回。没有承诺持续可用、实时备份或自动告警。LaunchAgent 依赖用户登录；macOS 可能要求允许后台程序访问桌面。日志只有成功/失败状态，不含命令输出和秘密，需运维定期轮转。

## 审核后安装（本目录自身不会安装）

依赖：服务器 Python 3.9+；Mac Python 3.9+、OpenSSH、age（支持 ssh-ed25519 recipient）。已发现本机开发工具 `/Users/kai/Desktop/Q/backend/.local/deploy-tools/age/age`，版本 v1.3.2；由运维审核后安装到稳定路径并记录版本。无需添加网络运行库。确认 `id_ed25519_gitlab_kai.pub` 是现有私钥对应的公开 SSH recipient，不能把私钥复制到 recipient 文件。加密 SSH 私钥可能需要交互解锁；必须先验证无人值守可用，否则任务应失败而非绕过密钥保护。

1. 审核并将 `exporter.py` 安装为服务器 root:root 0755 `/usr/local/sbin/q-backup-export`；其父目录不可由 ecs-user 写入。用既有 sudo 或单独固定命令授权；脚本只接受 `list`、`export TIMESTAMP`，不接受路径。不要开放任意 Python/root shell。服务器现有备份任务保持原样。
2. 将 `pull.py` 和 `verify.py` 安装至 `/Users/kai/Library/Application Support/Q/offsite-backup/`，目录 0700、文件 0700。固定绝对 Python 与 age 路径，替换 plist 的两个占位符；不要让计划任务依赖交互 PATH。保留 SSH known_hosts，StrictHostKeyChecking=yes；首次信任必须人工核对，脚本不会自动接收主机密钥。
3. 手动执行与 plist 相同参数的 pull，确认目录为 0700、输出为 0600，并用 verify 再验。首次检查实际 PostgreSQL 恢复到独立测试库（不能覆盖业务库），包括迁移、账号和普通聊天持久化、临时数据排除；verify 只验解密/结构/校验和，不代替恢复演练。
4. 安装 plist 到 `~/Library/LaunchAgents/com.kaicloud.q.offsite-backup.plist`，`plutil -lint` 后 `launchctl bootstrap gui/$(id -u) ...`。仅在实际成功拉取和实际恢复后记录完成状态。卸载用 launchctl bootout 后移除 plist，保留已有备份。

恢复时可在受限临时目录使用 `age -d -i EXISTING_SSH_IDENTITY ARCHIVE | tar -xf -`，先用 verify 检查；`deploy.env` 含密钥，不输出到终端或测试日志，恢复完安全移除临时目录。SSH 私钥丢失将无法解密；私钥本身的安全备份需独立安排，不能与本目录密文一起公开。

测试：`python3 -m unittest discover -s backend/deploy/offsite-backup -p 'test_*.py'`。

真实 age 加密/解密/篡改验收：`Q_AGE_BIN=/absolute/path/age python3 -m unittest discover -s backend/deploy/offsite-backup -p 'test_*.py'`，测试使用临时测试密钥，不触碰现有 SSH 私钥。


## 本次验证记录（2026-10-22，安装前）

10 项测试通过，包含现有官方 age v1.3.2 的真实加解密与篡改拒绝、部分传输不得发布、原子文件发布中断恢复、去重、备份文件权限检查、导出期间解锁与清理原文件、损坏旧备份不阻止同步新备份。计划任务模板通过 `plutil -lint`；部署工具 64 项、网页部署工具 20 项、图库部署 54 项回归通过。源码审查发现的锁竞争及固定解释器问题已修复并复核。

配套 Nginx 配置在独立回环临时入口做实际请求验证：3 MiB / 5 MiB 请求可转发，5 MiB + 1 字节返回 413；两层配置均通过，未修改业务监听入口。此记录不等同异地备份已经安装，实际拉取、计划任务运行及恢复验收须在部署后另行记录。
