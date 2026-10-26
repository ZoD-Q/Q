# 小Q外部可用性与邮件监测

本目录只准备监测程序、测试和 GitLab 接线，不自行创建计划、保存授权码、发邮件或修改业务服务器。审核合入 main 后，由运维完成下列配置和真实投递验收。

## 监测范围

- 固定检查 https://q.kaicloudpay.com/health 和 https://q.kaicloudpay.com/plugins/beauty/health，不接受自定义目标或凭据。
- API 必须返回 HTTP 200 和 JSON status=ok；图库还核对服务标识、300 张照片、固定公开 origin 和合法源码 SHA 格式。图库源码 SHA 不与当前监测流水线提交绑定：后续文档或客户端提交不会被误报成图库故障。
- 不跟随跳转、不使用代理环境变量、不发送 Cookie 或 Authorization；HTTPS 与 SMTP 都验证证书。响应最多读取 4 KiB，每个 HTTP 操作超时 8 秒，每个独立探测子进程总限时 12 秒（覆盖 DNS 或慢速响应体）；子进程不继承 SMTP 或 GitLab 凭据。SMTP 操作超时 10 秒，整个 CI 作业上限 3 分钟。
- 它检查公开入口可达性和健康响应，不登录、不调用模型、不读取钱包或数据库，也不证明所有业务、供应商、备份或数据恢复均正常。

## 告警与状态

正常保留缓存时，每个目标连续两次计划检查失败才创建告警事件；单次异常后恢复不发邮件。告警、恢复和显式测试邮件分别保存投递状态、尝试次数及最后尝试时间，两个目标在同一轮有可发送事件时合并成一封邮件。

| 投递状态 | 自动处理 |
| --- | --- |
| pending | 尚未尝试；先保存 in_flight 检查点，再发送 |
| accepted | SMTP 在完整 DATA 后返回 250；不再发送同一事件 |
| not_delivered | 明确未投递，例如 TLS/认证/MAIL/RCPT 阶段失败或服务器明确拒绝 DATA；至少冷却 30 分钟后重试，包含首次最多 3 次 |
| unknown | DATA 阶段断连、超时、未分类异常，或从上轮 in_flight 恢复；停止自动重发，等待人工核对 |
| exhausted | 明确未投递且已达 3 次；停止自动重发，等待人工处理 |

发送前检查点写入失败时不发邮件，作业返回错误。若 SMTP 已接受但后续保存失败，磁盘上的 in_flight 会在下一次读取时转为 unknown，不能据此自动重发。QUIT 在 DATA 已返回 250 后失败仍算 accepted；发生不确定交换后直接关闭连接，不继续写 SMTP 命令。Message-ID 仅用于关联事件，不作为收件方去重保证。

健康事件和邮件投递分开：观察到恢复后生成独立恢复通知，即使之前故障邮件投递未知，也可发送恢复通知并说明之前未获确认。恢复通知同样最多 3 次、30 分钟冷却，未知后停止。若恢复邮件仍 unknown/exhausted，之后服务再次连续失败仍会创建新的故障事件及独立预算，不被旧邮件阻塞。新故障出现后不再自动投递旧事故的恢复邮件，避免发送过时的“已恢复”。

状态仅包含固定服务名、连续失败计数、时间戳、事件编号和投递元数据，保存在独立缓存 backend/.local/monitor-state/state.json。每个服务保留当前及最近 4 个已结束事件，另保留最近一次测试邮件状态，避免状态无限增长超过 32 KiB。报告含这些非敏感记录及 manual_attention 标记；不保存响应正文、业务日志、密码、用户数据或 SMTP 原始错误。resource_group 串行执行；固定缓存 key、pull-push、when: always 和受保护缓存隔离保持不变。状态格式为 v2，但不更换原缓存 key；旧 v1 中无法区分失败或未知的记录保守迁移为 unknown。

**缓存不是可靠数据库。** Runner 更换、清理或上传失败可能丢失状态。真正缺失或损坏的缓存只能重新建立；失败目标会在同一作业内间隔 2 秒再做一次独立 GET，双失败即创建告警，避免持续 cache miss 永远凑不齐两次失败。有效缓存超过 20 分钟时只重置连续探测计数，投递记录与预算不失效，不能借此重发 unknown/exhausted。缓存丢失或回退仍可能重复告警或缺少恢复通知，不承诺严格 exactly-once。SMTP 接受也不等于收件箱实际收到。

退出码：0 为本轮健康且当前需要的邮件已由 SMTP 接受；1 为目标检查失败；2 为配置、状态保存、冷却等待或需人工处理的投递问题。失败作业仍上传状态缓存。值守者应根据报告中的事件 ID、阶段、次数和时间检查 QQ 投递/收件证据；不要删除整个缓存来绕过未知或耗尽状态。本版本没有自动强制重发入口，确需重发须人工核对后另行明确执行。GitLab 自身的失败作业通知设置独立于本程序。

## 审核后配置

1. 保持 main 受保护、MR 不可访问受保护变量、受保护和非受保护分支缓存分离。确认使用既有 docker + linux 共享 Runner，Runner 在业务服务器之外；多 Runner 需共享分布式缓存或稳定命中同一 Runner。无需 SSH、业务数据库凭据、长期 GitLab token 或新的 Runner。
2. 在项目 CI/CD Variables 保存 Q_MONITOR_SMTP_AUTH_CODE：QQ SMTP 授权码，Variable 类型，Protected、Masked、Hidden，Environment scope 精确为 monitoring，关闭变量值展开。不得放到计划变量、YAML、缓存、制品或命令参数。用户提供的本地 0600 ignored 文件仅用于运维录入；程序不读取该文件，也不读取其他业务配置。
3. QQ 发件和收件账号均固定为 xzy070212@qq.com，使用 smtp.qq.com:465 的 SMTP over TLS。须先为该账号开启 SMTP 并取得授权码；不是邮箱登录密码。程序不打印授权码或原始 SMTP 异常。
4. API 与图库均完成上线后，创建指向 main 的 Pipeline schedule，由有该受保护分支权限的维护者持有；计划变量仅设置 Q_MONITOR_SCHEDULE=1。期望 cron 为 */5 * * * *，建议 UTC。实际频率受 GitLab 实例的计划任务频率、调度延迟和 Runner 排队影响，不承诺精确五分钟。普通 push/MR/web 仍执行原有验证；监测计划只包含 q-external-monitor，不执行编译、打包或发布。
5. environment 使用 monitoring / action: verify，供监测专属变量限定作用域，不创建业务部署。作业本身再次验证 project 197、protected main、schedule 来源、显式开关及作业名，拒绝 CI_DEBUG_TRACE=true。
6. 首次验收临时添加非敏感计划变量 Q_MONITOR_TEST_ID=acceptance-20261026，然后手动运行这条 schedule。确认 report 的 delivery=smtp_accepted，并核对实际收件；此测试邮件不表示服务故障。随后移除 Q_MONITOR_TEST_ID，避免缓存丢失时再次发测试邮件。再次运行并确认 state=restored。该固定测试 ID 同样采用未知停发、最多 3 次与 30 分钟冷却；主动更换 ID 表示另一次明确测试，不用于绕过旧邮件的未知结果。
7. 检查至少两轮计划实际按预期执行、仅有监测作业且状态可连续恢复。故障/恢复状态机通过本地替身验收，不停止生产 API、数据库或图库来制造故障。

监测在共享 Runner 上，业务主机失联时仍有机会发送邮件。但 GitLab、Runner、DNS、网络或 QQ SMTP 自身不可用时，监测/投递也可能中断；需要值守者检查计划是否停用、排队或失败。若这些基础设施与业务主机处于同一故障域，不能称为完全独立监控。此程序不自动重启、回滚或部署业务。

## 本地验证

~~~sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s backend/deploy/monitor -p 'test_*.py'
~~~

测试只使用 loopback HTTP、注入 SMTP 对象和临时状态文件，涵盖连续失败、恢复、缓存丢失、SMTP 阶段分类、未知停发、有限重试、崩溃检查点、固定目标和秘密不进入输出。告警与恢复分别跨 100 轮从磁盘重新加载验证；另验证 100 次独立事故仍有固定历史上限，以及 SMTP 已接受但保存失败后从实际 in_flight 文件恢复而不再发送。它们不建立真实 SMTP 连接，不读取用户授权码。真实计划、Runner 缓存和收件结果须单独记录，不能用本地通过替代。

## GitLab 兼容性依据

依据 [Scheduled pipelines](https://docs.gitlab.com/ci/pipelines/schedules/)、[Resource group](https://docs.gitlab.com/ci/resource_groups/)、[缓存可用性](https://docs.gitlab.com/ci/caching/#availability-of-the-cache)、[cache:when](https://docs.gitlab.com/ci/yaml/#cachewhen) 和 [环境 verify action](https://docs.gitlab.com/ci/environments/#access-an-environment-for-preparation-or-verification-purposes)。这些机制不依赖新增 SDK 或业务运行库。

本实现不读取“最近成功流水线”的制品来恢复状态。[Job Artifacts API](https://docs.gitlab.com/api/job_artifacts/) 将 search_recent_successful_pipelines 的归档查询支持列为 18.7 引入，单文件查询为 18.9；不能假定 18.3 有该参数。默认按 ref 查询还受最近成功流水线和手动作业状态影响，普通代码流水线可能没有监测制品。缓存重建与 SMTP 故障分别报告，HTTP 404 的制品查询不参与本程序。
