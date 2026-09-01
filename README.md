# 客户跟进管理系统 - 桌面版（Windows）

个人 CRM 工具的桌面封装版，基于 Electron 37 + electron-builder 25，
数据使用浏览器 localStorage 持久化，支持 `.crmbak` 文件导入导出。

## 自动更新
桌面端通过 **GitHub Releases** 自动更新：
- 已安装用户启动时会检查 `latest.yml`，有新版本则自动下载安装。
- 发布新版本只需在本机改源 HTML（`E:\分贝通资料\测试的\crm-app-mobile.html`），
  把 `package.json` 的 `version` 加一，再跑一键脚本 `release-all.js --publish`。

## 目录结构
- `main.js`            Electron 主进程
- `sync-app.js`        把源 HTML 同步进 `app/crm-app.html`
- `app/crm-app.html`   应用页面（由源 HTML 生成）
- `app/desktop.css`    桌面端样式
- `assets/icon.ico`    应用图标

## 本地构建（开发者）
需要 Node.js 与本工程依赖。正常流程由 `release-all.js` 一键完成，
详见同目录说明。本仓库仅托管源码与发布产物（Release 中的 exe），
实际构建在本地/CI 完成。
