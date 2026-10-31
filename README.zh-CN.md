# kie-skills

[English](README.md) | **简体中文**

一个 agent skill 和配套的小型 CLI，用来通过 [KIE](https://kie.ai) 的任务模型生成图片、
音乐和语音。内置模型发现、schema 校验、额度记账和本地产物记录。

零依赖，无构建步骤，Node 22+ 上的纯 ESM。

## 为什么需要它

KIE 在一个任务 API 后面挂了 200 多个生成模型，而且这个接口面一直在动：模型会新增、改名、
下线，每个模型的 `input` 结构还不一样。把模型名或字段列表写死，正是这类集成腐坏的方式。

这个 skill 在调用时才去读目录和模型发布的 schema，所以新模型不需要改代码就能用，而不合规的
输入会在花掉额度之前被拦下来。

它也会挡住代价高昂的错误：video 系列默认关闭，余额下限会阻止跑不完的任务，每次运行都会记录
实际花费。

## 环境要求

- Node.js 22 或更高
- KIE API key：<https://kie.ai/api-key>

```sh
export KIE_API_KEY=your_key
```

## 安装

作为 agent skill：

```sh
npx skills add favoyang/kie-skills
```

作为本地 CLI：

```sh
git clone git@github.com:favoyang/kie-skills.git
cd kie-skills
node scripts/cli.js models --family image
```

## 快速开始

```sh
# 有哪些模型可用？
node scripts/cli.js models --family image --q gpt-image

# 需要哪些参数？
node scripts/cli.js schema gpt-image-2-text-to-image

# 要花多少？
node scripts/cli.js price gpt-image-2-text-to-image
node scripts/cli.js balance

# 不花任何额度地做完整检查。
node scripts/cli.js plan gpt-image-2-text-to-image \
  --input '{"prompt":"a red ceramic mug on a light oak table","resolution":"1K","aspect_ratio":"1:1"}'

# 然后真正执行。
node scripts/cli.js run gpt-image-2-text-to-image \
  --input '{"prompt":"a red ceramic mug on a light oak table","resolution":"1K","aspect_ratio":"1:1"}'
```

每次运行都会把结果下载到每个用户一份的共享 store，并在旁边写一条 metadata 记录：

```
~/Library/Application Support/kie/        # macOS
%LOCALAPPDATA%\kie\                        # Windows
~/.local/share/kie/                       # Linux
  images/gpt-image-2-text-to-image/20261028-172545-a-red-ceramic-mug-01.png
  metadata/20261028-172545-a-red-ceramic-mug-<taskId>.metadata.json
```

## 产物落在哪里

每个用户一份 store，所有项目共用。过去产物落在项目内的 `kie-output/`，这在 git worktree 下
会出问题：那个目录被 gitignore，无法合并回主检出，worktree 一删它就跟着消失。

优先级：

```
--out DIR            （仅本次命令生效）
KIE_STORE_DIR
平台数据目录
```

`--out` 是唯一的重定向方式，而且只对一条命令生效。这里刻意不提供项目级输出设置：在
`kie.config.json` 里写一个固定路径，正是让运行结果落到 dashboard 看不见的地方的方式。写到
store 外面的运行不会出现在 dashboard 里。

`node scripts/cli.js info` 会打印解析后的项目目录、它的来源（`cwd` 或 `env`）、仓库名和 git
common dir，以及 store 位置，产物落在意外的地方时用它排查。

每条记录都会保存调用目录、git common dir 和仓库名。同一个仓库的多个 worktree 共享一个
common dir，所以它们会显示成一个项目，而不是每个检出各算一个。

### 迁移旧产物

```sh
node scripts/cli.js import ~/projects/old-project/kie-output
```

把 metadata 和被引用的资产复制进 store，并改写资产路径。运行记录按 task id 去重，所以对同一
个目录重复导入不会产生任何变化。

## 安全默认值

| 保护 | 行为 |
| --- | --- |
| 系列闸门 | 只运行 `image`、`music`、`speech` 三个系列。`video` 和 `chat` 被阻止，映射表里没有的任务类型同样被阻止 |
| 余额下限 | 余额低于 20 credits 时拒绝创建任务 |
| `--max-credits N` | 可选，只能收紧，上限取自模型公布的定价 |

这些是默认值，不是写死在代码里的立场：可以在 `kie.config.json` 里按项目覆盖。

## 成本记账

对基于任务的模型，`recordInfo` 会返回 `creditsConsumed`，所以记录下来的花费是真实数字，不是
估算。有些系列（Suno）不返回这个字段，那些记录会标记 `cost_source: "unavailable"`，而不是
编一个数字出来。

```sh
node scripts/cli.js spend --today
```

花费是从运行 metadata 推导出来的，没有单独的账本文件，也就不会出现账本与事实脱节。

## 用本地文件作为输入

给一个路径，它会自动上传：

```sh
node scripts/cli.js run gpt-image-2-image-to-image \
  --input '{"prompt":"watercolor version","input_urls":["./photos/mug.png"]}'
```

远程 URL 原样透传。上传文件 24 小时后失效，所以 metadata 保存的是本地源路径，重跑时会重新
上传。

## Dashboard

```sh
node scripts/cli.js dashboard
# KIE dashboard: http://127.0.0.1:4173
```

一个只读页面，读的是 store：prompt、输入、额度、耗时和可直接播放的媒体。它会盯着 metadata
目录，几秒内显示新运行；可以按仓库和系列筛选；导航栏可以在列表视图和画廊视图之间切换。

```sh
node scripts/cli.js dashboard --open          # 复用或启动，然后打开浏览器
node scripts/cli.js service install --host 0.0.0.0 --port 4173
node scripts/cli.js service status
```

`dashboard` 是幂等的：如果端口上已经有 dashboard 在应答，它就打印那个 URL 然后退出。
`service install` 通过 macOS 的 launchd 或 Windows 的任务计划程序把它变成常驻服务，所以它能
跨过注销，并在崩溃后自动重启。默认只绑定 localhost；`--host 0.0.0.0` 可以让它在可信网络内
访问，注意它没有身份认证。

## 已知限制

- **video 默认关闭。** 这类运行要花几百 credits，启用它是一次有意的策略修改。
- **chat 模型不在范围内。** 它们走厂商的对话协议，不是任务 API。
- **发现接口没有版本保证。** `/api/v1/models`、`/models/{model}/schema` 和 `/chat/credit`
  被 KIE 自家工具使用，但不承诺稳定性。接口变了会明确报错，而不是悄悄猜一个结构。

## 开发

```sh
npm test        # 127 个测试，不需要网络或凭据
npm run check   # 测试加一次 dashboard 渲染检查
```

测试使用假的 fetch 层，所以这里的一切都不会产生费用。

## 许可证

MIT
