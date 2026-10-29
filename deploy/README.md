# VibeMobile 发布包速查

这个目录在解压后的发布包里。完整说明见 [`docs/pm2-release.md`](../docs/pm2-release.md)。

前提：Node ≥ 20、npm、PM2；Linux 还要 `python3`、`make`、`g++`（`node-pty` 需要现场编译）。用实际运行 PM2 的用户先执行一次 `codex login`（用 Claude 的话再执行一次 `claude`）。

## Hub

```bash
# 解压到长期保留的目录，安装根 = 解压目录
node deploy/install.mjs --role=hub --port=3000 \
  --workspace=/srv/projects --pin=123456

# 由 Hub 自己提供 HTTPS/WSS
node deploy/install.mjs --role=hub --port=3000 \
  --workspace=/srv/projects --pin=123456 --tls
```

Windows 把路径写成 `D:\vibemobile`、`--workspace=D:\code`。不传 `--pin` 时首次启动自动生成并打印。

安装完成后：

```bash
pm2 logs <pm2-name>
pm2 restart <pm2-name> --update-env
```

`<pm2-name>` 默认 `vibemobile`。配置在 `vibemobile.env`（0600），状态在 `data/`。

## 添加 runner

```bash
node scripts/create-runner.mjs --id=runner-b --name=机器B
# 保存输出的 VIBEMOBILE_RUNNER_TOKEN，重启 Hub
```

在 runner 机器上：

```bash
node deploy/install.mjs --role=runner \
  --workspace=/srv/projects \
  --hub-url=wss://hub.lan:3000 \
  --runner-id=runner-b \
  --runner-token-file=/root/runner-b.token \
  --hub-ca=/path/to/ca.pem
```

`ws://` 用于明文局域网；`wss://` 用于 TLS。runner 不需要开放入站端口。

## 升级

把更新包解压到安装根**之外**：

```bash
node /tmp/vbm-update/deploy/update.mjs --target=/opt/vibemobile
```

完整的替换、健康检查、自动回滚和保留策略见文档。`data/`、`certs/`、`vibemobile.env` 不会被升级修改。

## 只准备不启动

```bash
node deploy/install.mjs ... --no-start
node deploy/update.mjs --target=... --no-start
node deploy/update.mjs --target=... --dry-run
```
