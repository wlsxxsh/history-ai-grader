# 历史作业批改与学情分析平台

这是一个面向中学历史作业场景的 React + Express 应用，支持题目抽取、答题卡识别、选择题批阅、主观题阅卷和结果导出，适合本地评估演示与校内试用。

## 当前能力

- 选择题批阅与统计分析
- 普通主观题、论述题批改
- 题目与参考答案上传、识别、回填
- 学生答题卡上传、切分、识别与归属修正
- 选择题详解导出与主观题结果导出
- 本地运行、免安装 ZIP 打包发布

## 内置范例

仓库中保留了脱敏后的演示资料，便于下载者直接查看：

- `Samples/范例-试题.pdf`
- `Samples/范例-参考答案.pdf`
- `Samples/范例-答题卡.pdf`

这些资料仅用于演示，不包含真实学生隐私信息。

## 开源与隐私说明

- 仓库默认不包含真实学生数据、运行日志、缓存、本地调试痕迹和 API Key。
- 请不要提交 `data/app-state.json`、`data/uploads/`、`data/generated/`、`logs/`、`.env` 以及导出的批改文档。
- API Key 只应在本机或服务器部署后填写，不能提交到 GitHub。

## 本地开发

### 环境要求

- 当前已验证环境：Windows x64 + Node.js 24.x

### 安装依赖

```bash
npm install
npm --prefix frontend install
npm --prefix server install
npm run prepare:native
```

### 开发运行

```bash
npm run dev:server
npm run dev:frontend
```

前端开发地址：`http://127.0.0.1:5173`

后端接口地址：`http://127.0.0.1:3857`

## 本地生产方式运行

先构建前端，再启动后端：

```bash
npm run build
npm start
```

构建完成后，后端会在同一端口托管前端页面。

## 免安装 ZIP 发布

仓库内置了 Windows x64 免安装打包流程。

### 本地打包

```bash
npm run release:zip:win-x64
```

生成文件位置：`release/history-ai-grader-win-x64.zip`

### ZIP 内容

- 已构建前端页面
- 后端源码与运行依赖
- 运行所需的 `data/` 和 `logs/` 目录
- 内置 `Samples/` 演示资料
- `start.bat` 与 `start.ps1` 启动脚本

### GitHub Release 自动化

发布 GitHub Release 或手动触发 `Release Portable ZIP` 工作流后，会自动构建 Windows x64 ZIP 并挂到 Release 页面。

## 已知限制

- 当前仍以本地单机使用为主，尚未实现多用户隔离。
- 后台设置保存在本地运行数据中，不建议多人共享同一份 `data/` 目录。
- 如果要部署到公网，请先补齐登录鉴权和权限控制。
