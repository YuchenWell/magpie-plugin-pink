# PinK

让 PinK 使用 Magpie 中配置的模型，并查看调用用量与费用。

## 安装

需要 Magpie 0.1.2136 或更新版本，并先启动一次 PinK。
在 Magpie 的插件页面输入 `magpie-plugin-pink` 安装，或执行：

```sh
magpie plugin add magpie-plugin-pink
```

也可通过本地安装包安装：
从 [GitHub Releases](https://github.com/YuchenWell/magpie-plugin-pink/releases/latest)
下载 `magpie-plugin-pink-0.1.0.tgz`，解压后将包含 `package.json` 的目录命名为 `PinK`。
在 Magpie 的插件页面添加该目录，或执行：

```sh
magpie plugin add /absolute/path/to/PinK
```

本地插件的显示名称取自安装目录名。
macOS 的 CLI 位于 `/Applications/magpie.app/Contents/MacOS/magpie`。

## 使用

1. 在 Agent 页面重新检测，找到 PinK，打开接入开关或选择模型
2. 在 PinK 中选择 `Magpie (PinK)` 分组下的模型
3. 在 Magpie 的用量页面按 PinK 查看调用量、Token 用量和费用

连接和模型切换会自动同步到 PinK，可能需要稍等片刻。
断开、停用或移除插件时，自动恢复仍由插件管理的配置，保留用户的手动修改。

仅统计经过 Magpie 网关的请求，不导入 PinK 历史会话或关联逐会话费用。
使用聊天功能仍需登录 PinK。

## 配置

默认查找当前系统的 PinK 用户数据目录，同步已登记的 Profile 并遵循其继承设置。
可在 Magpie 的插件选项中指定目录和 Profile；调整范围前先断开：

```json
{
  "userDataDir": "/path/to/PinK",
  "profileIds": ["default"]
}
```

`userDataDir` 应包含 `User` 子目录；省略 `profileIds` 表示全部 Profile。
同一系统用户仅由一个 Magpie 配置管理此连接。

状态和恢复记录保存在 `~/.config/magpie-pink`。遇到手动修改冲突时，
插件保留用户更改，可查看状态文件或使用 Node.js / Bun 执行：

```sh
node /path/to/plugin/dist/cli.mjs status
node /path/to/plugin/dist/cli.mjs restore
```

## 开发

源码构建需要 Node.js 22+：

```sh
npm ci
npm run check
npm pack
```

`npm run test:magpie` 使用官方程序进行隔离集成检查，需设置 `MAGPIE_BIN` 和 `MAGPIE_BUN`。

## 许可证

[MIT](LICENSE)。打包依赖的许可声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
