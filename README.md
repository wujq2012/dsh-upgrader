# dsh-upgrader

把 DeepSeek Harness **桌面版同款**的更新胶囊接回**网页版**：侧栏底部、设置按钮旁边那颗「↓ 新版本」胶囊就是桌面版自己的 `DesktopUpdateIndicator` 组件（网页版前端包里本来就带着它，只是没有 Electron preload 提供的载体，所以永远不渲染）。本插件在页面加载前伪造 `globalThis.dshDesktop` 载体，让它按桌面版的样子渲染，并把背后的 `status / subscribe / open` 桥接到真实的更新路由。

不是仿制 UI，是**同一份官方组件**；升级逻辑也是桌面版那一套：发现问题 → 用户确认 → 停掉宿主 → `npm install -g @deepseek-ai/dsh@<精确版本>` → 自动重开服务。

## 效果

- 侧栏左下角出现官方样式胶囊：`新版本`；检查中显示「正在检查更新」，执行升级时显示「正在安装」。
- 点胶囊打开「DeepSeek Harness 更新」面板：当前版本、最新版本（npm dist-tag）、检查时间、将要执行的命令。
- 「检查更新」立即查询 npm dist-tags；「重启并安装」需要二次确认（第一次点会变成「确认停止服务并安装」）。
- 自动检查默认开启：启动 3 秒后一次，之后每 6 小时一次。

## 安装

```powershell
# 从 npm（发布后）
dsh plugin --profile web add dsh-upgrader
```

```powershell
# 本地开发 / 未发布时
dsh plugin --profile web add link:G:\dsh-plugins\dsh-upgrader
```

装完重启 `dsh web`，刷新页面即可看到胶囊。

## 配置

`cordis.patch.yml` 的 `config` 段（或用 `dsh plugin` 的 patch 层覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `channel` | `latest` | npm dist-tag。`latest` 取最新正式标签；也可填 `next` / `alpha` 等 |
| `checkOnStart` | `true` | 启动 3 秒后自动检查一次 |
| `checkIntervalHours` | `6` | 自动检查间隔（小时），`0` 关闭周期检查 |

## 升级流程（和桌面版同构）

1. 「重启并安装」二次确认后，宿主写一个 `upgrade.ps1` 到 `$DSH_HOME/plugins/dsh-upgrader/`，并脱离当前进程启动它。
2. helper 等待 2.5 秒 → 结束当前宿主进程（释放全局包文件锁和端口）→ 等待 1.5 秒。
3. helper 执行 `npm install -g @deepseek-ai/dsh@<目标版本>`，日志追加到 `upgrade.log`。
4. 无论 npm 成功与否，helper 用原启动命令重新拉起 `dsh`（失败时仍是旧版本，不会把服务弄死）。
5. 页面随服务重启恢复，刷新即生效。

## 安全边界

- 只接受本机环回请求；写操作（检查/升级）额外要求同源 `Origin` 和每个进程随机生成的 `actionToken`（从状态接口拿，页面内的桥自动携带）。
- 版本信息只从 `registry.npmjs.org` 读取；升级命令固定为 `npm install -g @deepseek-ai/dsh@<版本>`，不接受任意命令。
- 伪造的载体只提供官方组件实际用到的 `updates.{status,subscribe,open}` 与 `channel.{get,set,subscribe}`，不注入其它能力。

## 限制

- 仅支持 **npm 全局安装** 的 DSH（`npm i -g @deepseek-ai/dsh`）；源码安装 / 桌面应用不适合本插件。
- 升级 helper 目前只实现 **Windows（PowerShell）**。
- 依赖 DSH 自带的 `DesktopUpdateIndicator` 组件：要求 DSH `>=0.2.2-alpha.3`；官方以后改了这个内部组件，插件需要跟进。
- 升级会使当前页面短暂断开，正在进行的对话轮次可能被打断——面板里已提示。

## 卸载

```powershell
dsh plugin --profile web remove dsh-upgrader
```

重启 `dsh web` 后胶囊消失，页面不再伪造载体。

## License

MIT
