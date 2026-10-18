# 视频创作与创作者广场（前端原型）

用户于本轮明确选择先完成前端原型和完整交互。没有供应商调用、真实广告、收费、上传或公开发布。

## 入口与流程

左侧栏新增视频创作；页面右上进入创作者广场。创建页包含画面描述、模型与格式、API Key演示配置、品牌选择、价格、生成/取消/重试与结果。结果可以预填发布表单，发布到当前会话的本机广场。

模型为Kling、Runway、Veo名称选择，时长5/10秒、比例9:16/16:9/1:1都是布局选项，不代表供应商当前能力规格。API Key输入仅为演示，界面提示不要填写真实密钥；不持久化、不打印、不发送，连接或关闭后清空。provider只存演示连接布尔值。

报价以最小整数单位计算：5秒基础2000（20.00 Q），10秒4000（40.00 Q），为虚构示例。按唯一品牌ID计算每个5%，最多10个，最高50%。不足最小单位的优惠向下取整。具体边界测试在pricing.test.mjs。

## 品牌目录

1000个唯一真实品牌文本来自Simple Icons固定版本元数据，只作原型选择目录，不代表广告主、合作、授权或真实优惠。每项可追溯来源。详见brand-catalog.md。未下载或使用品牌logo。

## 演示素材

播放器使用项目自带三段原创短动画：海边日光、蓝色流动、纸间山丘。由本地Pillow/NumPy程序绘制并编码，5秒、24fps、360×640、H.264 baseline、yuv420p、faststart、无音轨。没有复制远程素材，也不是视频模型输出。

文件在native/assets/video，manifest.json记录参数和SHA256，scripts/generate-demo-clips.py可复现。Expo Asset解析原生与Web地址，不依赖外部片源网站。作品始终标记为演示素材/非提示词生成，广告只是选择的预览元数据。

实现参考Expo58官方Video/DocumentPicker文档：https://docs.expo.dev/versions/v58.0.0/sdk/video/ 。最初评估公开演示片源但本机网络加载失败，实际交付已全部改为内置原创素材。

## 播放与本地发布

广场使用expo-video，默认静音，仅当前页播放；打开发布/信息弹层、后台或离页都会暂停。支持暂停、静音、上下翻页、本地点赞、加载失败重试。用户通过DocumentPicker主动选视频，当前会话本地展示，未上传网络。

未发布web blob由发布弹层负责替换/取消/卸载清理；发布后转交VideoStudioProvider，provider卸载清理。原生file://文件不被删除。

## 代码边界

- video-state.tsx：内存草稿、生成任务、取消隔离、作品、发布队列。
- video-create.tsx：单页创作UX与演示Key配置。
- brand-picker.tsx：虚拟化1000项选择、搜索/已选/上限。
- pricing.ts：独立纯计算；pricing.test.mjs：10项边界和目录检查。
- creator-feed.tsx / feed-card.tsx / publish-sheet.tsx：刷视频、媒体生命周期、本地发布。

不会调用旧Rust账户/钱包接口，原账本未改动。
