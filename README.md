# 渔村智慧助手（千人百村）

面向**平谷区**淡水鱼养殖场景的智慧助手 Web 应用 —— 把天气、鱼价、鱼病诊断等日常信息整合到一个页面。

> 「千人百村」项目成果之一：为养殖户提供「看得懂、用得上」的轻量工具，其中鱼病诊断由 DeepSeek 大模型辅助。

## 功能

- 🐟 **鱼价预测**：查看/预测淡水鱼行情
- 🌧️ **暴雨预警**：实时天气与未来预报，异常天气提前提醒
- 🔬 **鱼病诊断**：选择症状 → DeepSeek 给出病害分析、治疗方案与注意事项
- 🏛️ **一键上报**：诊断结果可确认后上报政府

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JS（`public/`，单页） |
| 后端 | Node.js + Express（`server.js`） |
| 大模型 | DeepSeek（`deepseek-chat`，鱼病诊断） |
| 外部数据 | 天气 / 逆地理编码 API（经后端代理转发） |

后端负责**天气 API 代理、DeepSeek AI 诊断代理、静态文件托管**，并支持通过
`HTTPS_PROXY / HTTP_PROXY` 环境变量走代理隧道。

## 运行

```bash
npm install
npm start            # 等价于 node server.js
# 默认端口 8383 → http://localhost:8383
```

可选环境变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 服务端口 | `8383` |
| `DEEPSEEK_KEY` | DeepSeek API Key（鱼病诊断用） | 空（请自行设置） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出口代理（可选） | 空 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/weather/live` | 实时天气 |
| GET | `/api/weather/forecast` | 天气预报（暴雨预警） |
| GET | `/api/geocode/regeo` | 逆地理编码 |
| POST | `/api/diagnose` | 鱼病诊断（代理 DeepSeek） |
| POST | `/api/report` | 诊断结果上报 |
| GET | `/*` | 静态文件托管 |

## 部署（宝塔）

仓库自带 `deploy.sh`（宝塔一键部署）：安装 Node.js 18 与 PM2 → 拉取代码 → `npm install`
→ `pm2 start server.js --name 渔村助手` → 放行端口。

```bash
bash deploy.sh
```

部署后按脚本提示在宝塔面板添加站点与反向代理（目标 `http://127.0.0.1:8383`）。

## 目录结构

```text
├── server.js            # Express 后端（天气代理 / AI 诊断 / 静态托管）
├── public/index.html    # 前端页面
├── deploy.sh            # 宝塔一键部署脚本
├── package.json         # 依赖与脚本
└── package-lock.json
```

## 相关仓库

同属「千人百村」系列：
- [`qianrenbaicun`](https://github.com/hong-red/qianrenbaicun) —— 投资马昌营 · 招商专区（乡镇招商门户）
