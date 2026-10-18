# 独立 Web 客户端（后续阶段）

此目录保留给独立 React Web 界面。用户网页、开发者工作台及平台运营后台将放在这里，按需复用 `../mobile/shared` 的接口类型和领域工具。API 合同位于 `../backend/contracts`。

当前移动端预览从仓库的 `mobile` 目录运行 `npm install`、`npm run dev`。它独立启动 Expo UI，不要求数据库或 Rust API 运行；本目录的独立 Web 产品尚未实现。
