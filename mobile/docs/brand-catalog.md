# 视频原型品牌目录与报价规则

这是可搜索的 **1000 条品牌名称演示目录**，供用户预览品牌选择与模拟降价。它不是广告库存、合作方名单或投放承诺；没有任何品牌已与小Q合作的声明。包含公司、消费品牌及有名称的软件产品/项目，不把每个条目都解释为独立公司或可接受广告的主体。全部内容仅为文本，未复制 logo、SVG、品牌配色或图标路径。

## 固定来源

- 仓库：[Simple Icons](https://github.com/simple-icons/simple-icons)。
- 读取日期：2026-10-18（Asia/Shanghai）。
- 版本：`16.35.0`；固定提交：[`4d29a35c954699b389a834aacc97dd6e7e74143c`](https://github.com/simple-icons/simple-icons/commit/4d29a35c954699b389a834aacc97dd6e7e74143c)，提交时间 `2026-10-13T06:53:31Z`。
- 元数据：[data/simple-icons.json](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json)，原始记录 **3466** 条，顶层为数组。
- 元数据字节 SHA-256：`256322f4f06fe56b5ae8aed66375fda9d8f16a8955449f010c8533ef8b993ad2`。
- 当前生成文件 SHA-256：`862a65feca97aff1fdae738d5e6a46d504cee1b755eaa872b8d75bf4f91fc6b7`。
- 使用标准库下载、JSON 解析和本地生成逻辑；没有下载图标、运行上游仓库代码或安装依赖。

## 字段核实与映射

[上游 JSON schema](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/.jsonschema.json) 中，必填字段是 `title`、`hex`、`source`，可选字段为 `slug`、`guidelines`、`aliases`、`license`。`aliases` 的结构是 `aka` / `dup` / `loc` / `old`，不是字符串数组。此快照只有13条原始记录显式给出 `slug`。

本地导出：`Brand { id: string; name: string; aliases?: string[]; source: string }`、`brands: Brand[]`、`popularBrandIds: string[]`。`name` 原样保留上游 `title`；`source` 原样保留该条上游 `source`（该地址是原图标资料来源，可能是品牌网站、代码仓库或第三方资料，并不保证每个链接仍在线）。

`id` 优先用上游显式 `slug`；否则对标题做 NFKD、casefold、æ/ø/œ/ß 转写，保留 ASCII 字母数字，以连字符替代其他部分并去掉首尾连字符。空结果用标题 SHA-256 前12位，碰撞追加标题哈希前8位。这是本应用稳定选择 ID，并非声称全部都是 Simple Icons 官方 slug。

## 选择与校验

1. 原始 `3466` 条中剔除明显通用语言/格式/标准、非商业机构/泛分类以及显眼不适合此原型的内容；`Beats by Dre` 与优先保留的 `Beats` 视为同一品牌，不重复收入。
2. 人工预置优先顺序只从源内实际存在的名称中取值，共 **74** 条，前9项为 Apple、Nike、Adidas、Sony、Samsung、Spotify、小米对应的 Xiaomi、Huawei、Tesla。不补造缺失品牌。
3. 剩余 **3193** 条按 `(NFKD(title).casefold(), title)` 排序，用索引 `floor(i × (N−1) / (926−1))` 等距取 **926** 条，`i = 0…925`。因此覆盖完整字母范围，而不是仅从开头截取。
4. 最终 **1000** 条；ID和大小写归一后的名称均唯一；20条有中文搜索别名；74个 `popularBrandIds` 全部能在目录中找到。原始 `aliases.dup` 不展开为额外品牌。
5. 首字母分布：#=5, A=79, B=47, C=70, D=44, E=28, F=39, G=53, H=34, I=28, J=14, K=28, L=37, M=56, N=36, O=27, P=70, Q=12, R=47, S=91, T=60, U=16, V=27, W=24, X=6, Y=8, Z=12, Š=1, Ż=1。

当前快照实际剔除的 198 个名称（相同快照下可复核）：

.ENV, .NET, 1001Tracklists, 30 seconds of code, 4chan, ACM, ActivityPub, Ada, AIOHTTP, AMP, Apache Avro, Apache Parquet, Archive of Our Own, AssemblyScript, Basic Attention Token, Beats by Dre, BEM, Betfair, Binance, Bitcoin, Bitcoin Cash, Bitcoin SV, BitTorrent, Bluetooth, BNB Chain, BSD, C, C++, Cardano, Chainlink, Clojure, CNES, Codeforces, Codewars, Common Lisp, Contactless Payment, Contributor Covenant, Conventional Commits, Creative Commons, Crystal, CSS, D, Dart, Delphi, Deno, DLNA, Dogecoin, Elixir, Elm, ENS, Erlang, Ethereum, Ethers, European Union, Exercism, F#, F-Droid, FCC, Fido Alliance, Fortran, Fraunhofer-Gesellschaft, freeCodeCamp, freedesktop.org, Frontend Mentor, Fur Affinity, Gleam, GNU, GNU Bash, GNU Emacs, GNU IceCat, GNU Privacy Guard, Go, GraphQL, GTK, Haskell, Hedera, HTML5, ICON, IEEE, Internet Archive, IOTA, ISC2, Jabber, JavaScript, JPEG, JSON, JSON Web Tokens, Julia, Kotlin, LaTeX, LeetCode, Let's Encrypt, Linux, Linux Foundation, Litecoin, Lua, Markdown, Material Design, Max-Planck-Gesellschaft, MDX, Monero, Nano, NASA, NEAR, NFC, Nim, OCaml, Odin, OKX, OnlyFans, ONNX, Open Access, Open Badges, Open Containers Initiative, Open Source Hardware, Open Source Initiative, OpenAPI Initiative, OpenCV, OpenGL, OpenID, OpenJDK, OpenJS Foundation, OpenSSL, OpenStack, OpenStreetMap, Optimism, Org, OSGeo, Perl, PHP, Pi, Pine Script, Pix, Polymer Project, PureScript, PWA, Python, R, Racket, Rarible, Reason, ReScript, RSS, Ruby, Rust, Sass, Scala, Semantic UI, Semantic UI React, Semantic Web, Shell, Simple Icons, Solidity, SPDX, Steem, Stellar, Sui, SVG, Swift, Taichi Lang, Teal, Tether, The Algorithms, TOML, Tor Project, TypeScript, UKCA, United Nations, V, V8, Vala, W3Schools, Wagmi, WazirX, WebAssembly, WebGL, WebRTC, Wiki.js, Wikibooks, Wikidata, Wikimedia Commons, Wikipedia, Wikiquote, Wikisource, Wikiversity, Wikivoyage, World Health Organization, XML, XMPP, XRP, YAML, YouHodler, Zcash, ZebPay, ZecTrix, Zig, Zigbee, Zsh。

另对名称应用不区分大小写的 `porn|xhamster|xnxx|xvideos|fuck|hentai` 排除规则。筛选是原型目录整理，不是对未入选主体的资质或商业价值判断；后续正式广告库需要自己的主体、权益和投放数据。

## 中文搜索别名

以下20个别名保持原英文名称不变，仅用于搜索。5项直接来自同一固定快照的 `aliases.loc['zh-CN']`；15项参考品牌中文官方页面用名，未自动翻译全部目录。

| 原名 | 搜索别名 | 名称参考 |
| --- | --- | --- |
| Apple | 苹果 | [品牌中文官网](https://www.apple.com.cn/) |
| Nike | 耐克 | [品牌中文官网](https://www.nike.com.cn/) |
| Adidas | 阿迪达斯 | [品牌中文官网](https://static1.adidas.com.cn/ecp-cms/cdn-file/tac/content/WMS/0/TAC_PRIVACY.html) |
| Sony | 索尼 | [品牌中文官网](https://www.sony.com.cn/) |
| Samsung | 三星 | [品牌中文官网](https://www.samsung.com.cn/) |
| Xiaomi | 小米 | [品牌中文官网](https://www.mi.com/) |
| Huawei | 华为 | [品牌中文官网](https://www.huawei.com/cn/) |
| Tesla | 特斯拉 | [品牌中文官网](https://www.tesla.cn/) |
| DJI | 大疆 | [品牌中文官网](https://www.dji.com/cn/) |
| Lenovo | 联想 | [品牌中文官网](https://www.lenovo.com.cn/) |
| Honor | 荣耀 | [品牌中文官网](https://www.honor.com/cn/) |
| Alipay | 支付宝 | [品牌中文官网](https://payservice.alipay.com/) |
| WeChat | 微信 | [品牌中文官网](https://weixin.qq.com/) |
| Bilibili | 哔哩哔哩 | [品牌中文官网](https://www.bilibili.com/) |
| ByteDance | 字节跳动 | [品牌中文官网](https://www.bytedance.com/zh/) |
| Meituan | 美团 | [上游 aliases.loc.zh-CN](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json) |
| Meizu | 魅族 | [上游 aliases.loc.zh-CN](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json) |
| Dazhong Dianping | 大众点评 | [上游 aliases.loc.zh-CN](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json) |
| NetEase Cloud Music | 网易云音乐 | [上游 aliases.loc.zh-CN](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json) |
| Xiaohongshu | 小红书 | [上游 aliases.loc.zh-CN](https://raw.githubusercontent.com/simple-icons/simple-icons/4d29a35c954699b389a834aacc97dd6e7e74143c/data/simple-icons.json) |

## 许可与标识使用边界

仓库整体使用 [CC0 1.0 Universal](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/LICENSE.md)。其[免责声明](https://github.com/simple-icons/simple-icons/blob/4d29a35c954699b389a834aacc97dd6e7e74143c/DISCLAIMER.md)明确说明：仓库 CC0 不代表每个图标都适用 CC0；单项图标许可和品牌指南可能另有要求。CC0 不授予商标权。当前仅复用名称及来源元数据，不引入图标，也不由目录推导品牌授权、广告合作或收益承诺。以后如果使用品牌素材，应另外处理素材许可和实际合作关系。

## 纯前端模拟报价

`quoteVideo(baseMinor, brandIds)` 以整数最小单位计算：每个不同品牌减 **5%**，最多 **10** 个，总折扣最高 **50%**。输入先按 ID 去重；超过10个不同ID直接抛错。基础金额必须是非负安全整数；品牌ID必须是非空字符串。此函数只计算展示数值，不访问后端、不扣款，也不验证ID是否属于此目录；调用者从目录选择并负责保持ID有效。

节省金额采用精确整数运算并向下取整到最小单位，实付 = 基础金额 − 节省金额。例如基础2000：0个品牌实付2000，1个1900，10个1000；基础1999选1个，节省99、实付1900。基础值由页面设置，此文件不绑定默认价格。

从 `mobile/native/` 使用 Node 24 直接运行：

```sh
node --test src/prototype/video/pricing.test.mjs
```

测试覆盖0/1/10/11个品牌、重复项、非法金额、最小单位取整与安全整数上界、非法品牌ID及输入不变性；另对目录执行1000条、ID/名称唯一、常用品牌存在、来源URL和中文别名数量断言。
