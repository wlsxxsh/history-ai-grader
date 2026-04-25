<div align="center">
  <img src="./frontend/src/assets/hero.png" alt="历史作业批改与学情分析平台" width="160" />
  <h1>历史作业批改与学情分析平台</h1>
  <p>面向中学历史作业场景的 AI 批改软件，支持题目识别、答题卡识别、自动批改、结果导出和演示评估。</p>
  <p>
    <a href="https://github.com/wlsxxsh/history-ai-grader/releases/latest/download/history-ai-grader-win-x64.zip"><strong>下载 Windows 免安装版</strong></a>
    ·
    <a href="https://github.com/wlsxxsh/history-ai-grader/releases/latest"><strong>查看全部版本</strong></a>
    ·
    <a href="./使用说明.md"><strong>查看使用说明</strong></a>
    ·
    <a href="./Samples/README.md"><strong>查看范例资料</strong></a>
  </p>
</div>

> [!IMPORTANT]
> 如果你只是想使用软件，不需要下载源码。请直接点击上面的“下载 Windows 免安装版”。

> [!TIP]
> 第一步：先根据火山引擎官方文档申请 API Key。
> 官方文档：
> [获取 API Key 并配置](https://www.volcengine.com/docs/82379/1263279)
> ｜ [管理 API Key](https://www.volcengine.com/docs/82379/1361424)

> [!NOTE]
> 当前默认配置下，综合识别使用火山引擎方舟；答题卡识别与主观题阅卷默认使用硅基流动。
> 如果你想完整体验全部自动功能，建议把这两类 API Key 都准备好。

## 这是什么软件

这是一款给中学历史作业批改、演示评估和学情分析准备的软件。

它适合：

- 需要向评估人员展示“AI 如何辅助历史作业批改”的老师或团队
- 想快速演示“题目上传、答案识别、答题卡识别、自动批改、结果导出”完整流程的人
- 希望先用范例数据看效果，再决定是否深入部署的人

## 基本功能

| 功能 | 说明 |
| --- | --- |
| 题目与答案识别 | 上传试题和参考答案后，可自动识别并回填题目配置 |
| 答题卡识别 | 上传学生答题卡后，可自动识别选择题与主观题作答内容 |
| 选择题批阅 | 自动统计正误、得分、错因分布与题目情况 |
| 主观题批改 | 支持普通主观题与论述题批改 |
| 结果导出 | 支持导出批改结果和解析文档 |
| 范例演示 | 仓库和 ZIP 包都自带试题、参考答案、答题卡范例 |

## 软件亮点

### 1. 面向历史作业场景，不是通用空壳

软件不是单纯的“上传文件给模型”，而是围绕中学历史批改流程设计的，包含题目配置、答题卡识别、选择题批阅、主观题阅卷和结果导出等完整环节。

### 2. 对小白更友好

普通用户可以直接下载 ZIP 免安装版，不必自己部署前后端，也不需要先研究源码结构。

### 3. 自带范例，打开就能演示

仓库和 Release 包内都已经附带脱敏范例资料，下载后可以直接查看：

- `Samples/范例-试题.pdf`
- `Samples/范例-参考答案.pdf`
- `Samples/范例-答题卡.pdf`

### 4. 适合评估展示

从“上传资料”到“AI 识别填充”再到“批改与导出”的流程是连贯的，适合做成果展示、项目申报演示或现场评估说明。

### 5. 源码与成品同时提供

会用源码的人可以直接二次开发；只想试用的人可以直接下载 Release，不需要折腾安装环境。

## 下载地址

- Windows 免安装版 ZIP： [history-ai-grader-win-x64.zip](https://github.com/wlsxxsh/history-ai-grader/releases/latest/download/history-ai-grader-win-x64.zip)
- Release 页面： [查看全部版本](https://github.com/wlsxxsh/history-ai-grader/releases/latest)
- 使用说明： [使用说明.md](./使用说明.md)
- 范例资料说明： [Samples/README.md](./Samples/README.md)

## 简要使用方法

### 1. 先去火山引擎申请 API Key

这是最重要的第一步。没有 API Key，软件无法调用 AI 能力。

- 官方文档： [获取 API Key 并配置](https://www.volcengine.com/docs/82379/1263279)
- 补充文档： [管理 API Key](https://www.volcengine.com/docs/82379/1361424)

### 2. 下载软件

普通用户直接下载上面的 Windows 免安装版 ZIP 即可，不需要先下载源码。

### 3. 解压并启动

- 把 ZIP 解压到一个可写目录
- 双击 `start.bat`
- 浏览器会自动打开软件页面
- 如果没有自动打开，可手动访问 `http://127.0.0.1:3857`

### 4. 填写后台设置

打开软件右上角“后台设置”，先把 API Key 填进去。

说明：

- 综合识别默认使用火山引擎方舟
- 答题卡识别与主观题阅卷默认使用硅基流动

### 5. 先用范例试一遍

建议先用包内 `Samples/` 目录里的范例资料试跑一遍，再导入你自己的试题和答题卡。

### 6. 正式使用

建议按这个顺序操作：

1. 新建任务
2. 上传试题和参考答案
3. 点击 AI 识别并回填题目配置
4. 上传学生答题卡
5. 进行答题卡识别
6. 查看选择题批阅和主观题批改结果
7. 导出结果文档

更详细的步骤请看： [使用说明.md](./使用说明.md)

## 仓库里有什么

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 源码 | `frontend/` `server/` | 前后端代码 |
| 使用说明 | `使用说明.md` | 给普通用户看的上手文档 |
| 范例资料 | `Samples/` | 试题、答案、答题卡范例 |
| Release 成品 | `Releases` | 免安装 ZIP 下载 |

## 常见问题

### 找不到下载地址怎么办

直接点这里：
[下载 Windows 免安装版](https://github.com/wlsxxsh/history-ai-grader/releases/latest/download/history-ai-grader-win-x64.zip)

### 我只是想试用，需要看源码吗

不需要。普通用户直接下载 ZIP 包就行。

### 为什么打开软件后不能直接批改

因为 AI 功能需要 API Key。请先看：
[使用说明.md](./使用说明.md)

### 范例资料里的姓名是真实的吗

不是，范例中的姓名均为演示用途的虚构姓名。

## 技术细节与开发说明

<details>
<summary>展开查看技术细节</summary>

### 运行环境

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

### 本地生产方式运行

```bash
npm run build
npm start
```

### 免安装打包

```bash
npm run release:zip:win-x64
```

生成文件位置：`release/history-ai-grader-win-x64.zip`

### 开源与隐私说明

- 仓库默认不包含真实学生数据、运行日志、缓存、本地调试痕迹和 API Key
- 请不要提交 `data/app-state.json`、`data/uploads/`、`data/generated/`、`logs/`、`.env` 以及导出的批改文档
- API Key 只应在本机或服务器部署后填写，不能提交到 GitHub

</details>
