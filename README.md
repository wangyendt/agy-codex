# agy-codex

[English](README_EN.md) · [MIT 许可证](LICENSE)

用 Antigravity 做规划、设计和写作，把编码、调试、测试和审查交给 Codex。`agy-codex` 安装分工规则，并为每个工作区保存可继续的 Codex 会话。文生图和图生图优先交给 `codex-task image`。工具不安装启动钩子，也不新建后台服务。

## 快速开始

需要 Node.js 20 或更高版本。macOS、Ubuntu/Linux 和 Windows（PowerShell 或 CMD）均可运行：

```sh
npm install -g agy-codex
agy-codex setup
agy-codex doctor
```

npm 首次发布前，可克隆仓库并在仓库中依次运行 `npm ci`、`npm run build` 和 `npm install -g .`。如果 Windows PowerShell 禁止执行 `.ps1`，请用 `npm.cmd` 和 `agy-codex.cmd`。

缺少 `@openai/codex` 或 `codex-task` 时，`setup` 会在交互终端询问是否全局安装。`--yes` 或 `--install-deps` 表示同意自动安装；`--no-install-deps` 只配置文件。非交互模式下不主动安装，而是给出可复制的命令。需要登录时运行 `codex login`；`doctor` 只读取本地认证状态和已知过期时间，不检查令牌能否通过服务端验证。

## 交接任务

用简短的 UTF-8 交接文件记录计划路径、相关文件和验收命令。若不想让 Git 跟踪状态和报告，请将它们放到工作区外。

```sh
agy-codex run --cwd . --brief handoff.md --thread-state threads.json -o result.md --json
agy-codex run --cwd . --thread-state threads.json "只重新跑失败的测试"
agy-codex run --cwd . --review --uncommitted
```

首次成功运行后，会话 ID 按解析后的工作区路径保存。第二条命令自动恢复这次会话，只需传入增量要求。`--new` 开始新任务，`--resume ID` 指定会话，`--fork ID` 分叉会话。审查可选 `--uncommitted`、`--base BRANCH` 或 `--commit SHA`，也可不选范围而使用自定义审查要求。审查和失败的运行不会覆盖已有会话。

交接内容可以来自 `--brief`、命令行参数和管道输入，顺序依次为文件、参数、标准输入。`--events-log FILE` 保存原始 JSONL，可能包含任务敏感内容。`--json` 只输出状态、会话 ID、Codex 路径及版本、退出码、输出路径和最终消息。产物的相对路径以调用目录为准。默认沙箱为 `workspace-write`；只读任务可用 `--sandbox read-only`。

## 配置和升级

| 命令 | 用途 |
| --- | --- |
| `agy-codex setup --dry-run --json` | 预览规则文件变更和依赖安装命令。 |
| `agy-codex doctor --offline --json` | 不访问 npm，检查本地 CLI、Desktop、SDK、认证、规则和代理。 |
| `agy-codex upgrade --only codex,codex-task --dry-run` | 检查 npm 版本并预览升级。去掉 `--dry-run` 才会执行；`--yes` 同意安装。Desktop 和内置 SDK 单独报告。 |
| `agy-codex uninstall --sync-gemini-cli` | 删除托管规则及 Gemini CLI 镜像，不卸载 npm 包或删除用户规则。 |

默认管理 `~/.gemini/config/AGENTS.md` 和 `~/.gemini/config/rules/codex-delegation-protocol.md`。自定义内容请写在 `agy-codex` 标记外。已知且未修改的旧规则会原位迁移；无法识别的手写规则会保留并告警，以免重复或覆盖。`--sync-gemini-cli` 可将托管块同步到 `~/.gemini/GEMINI.md`。当 CodexTask 自带的技能文件与本地不同时会同步；若已自行修改，可用 `--no-sync-skill` 保留本地版本。升级时用 `--no-rules` 或 `--no-restart-service` 跳过对应操作。只有成功升级 `codex-task` 后才会重启正在运行的服务。

用 `agy-codex <命令> --help` 查看全部参数，包括自定义配置目录、npm registry/prefix、模型和二进制路径。

## 开发和发布

```sh
npm ci
npm run verify
```

CI 在三种操作系统上执行 lint、类型检查、测试、构建、打包检查和安装冒烟测试。新包需由有权限的维护者完成首次发布，再为 `wangyendt/agy-codex` 的 `publish-npm.yml` [配置 npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)，允许发布且不填写 Environment。设置仓库变量 `AUTO_PUBLISH_NPM=true` 后，可在 `main` 上手动运行 **Publish npm** 发布尚未发布的版本；如果当前版本已存在，运行 **Bump patch on main**。若分支保护禁止工作流推送，可用 PR 提升版本，合并后手动发布。OIDC 工作流不需要 npm token 或 GitHub PAT。
