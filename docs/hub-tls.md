# Hub 与 runner 的 WS / WSS 配置

三种模式共用同一套 runner ID + token 认证。Hub 原生 TLS 默认关闭；runner 根据 `VIBEMOBILE_HUB_URL` 的 `ws://` 或 `wss://` 自动选择传输方式。

| 部署方式 | Hub 原生 TLS | 浏览器地址 | runner 连接 |
| --- | --- | --- | --- |
| 局域网明文 | `off` | `http://机器A:5900` | `ws://机器A:5900` |
| 局域网程序直接加载证书 | `on` | `https://机器A:5900` | `wss://机器A:5900`，配置私有 CA |
| 公网 Nginx 提供证书 | `off` | `https://vibe.example.com` | `wss://vibe.example.com`，受信任证书无需 CA 配置 |

## 1. 局域网不使用 TLS

Hub：

```powershell
$env:VIBEMOBILE_HUB_TLS = 'off'
$env:PORT = '5900'
$env:VIBEMOBILE_PUBLIC_ORIGIN = 'http://192.168.1.10:5900'
$env:VIBEMOBILE_SECURE_COOKIE = '0'
npm run start:hub
```

另一台机器上的 runner：

```powershell
$env:VIBEMOBILE_HUB_URL = 'ws://192.168.1.10:5900'
$env:VIBEMOBILE_RUNNER_ID = 'runner-b'
$env:VIBEMOBILE_RUNNER_TOKEN = '<该 runner 的 token>'
npm run start:runner
```

## 2. 局域网由 Hub 直接提供 TLS

准备 PEM 格式的 Hub 证书、私钥和签发 CA 的公钥证书。服务器证书文件可包含完整证书链。自签名服务器证书也可直接用作信任锚。

Hub：

```powershell
$env:PORT = '5900'
$env:VIBEMOBILE_HUB_TLS = 'on'
$env:VIBEMOBILE_HUB_TLS_CERT_FILE = 'D:\certs\hub-cert.pem'
$env:VIBEMOBILE_HUB_TLS_KEY_FILE = 'D:\certs\hub-key.pem'
$env:VIBEMOBILE_HUB_CA_FILE = 'D:\certs\ca.pem'
$env:VIBEMOBILE_PUBLIC_ORIGIN = 'https://192.168.1.10:5900'
npm run start:hub
```

程序直接提供 HTTPS 和 WSS，无需 Nginx，也无需第二个监听端口。启用原生 TLS 后自动为登录 Cookie 设置 Secure。关闭原生 TLS 则恢复 HTTP/WS；通过重启进程切换，证书更新也需要重启。

runner：

```powershell
$env:VIBEMOBILE_HUB_URL = 'wss://192.168.1.10:5900'
$env:VIBEMOBILE_HUB_CA_FILE = 'D:\certs\ca.pem'
$env:VIBEMOBILE_RUNNER_ID = 'runner-b'
$env:VIBEMOBILE_RUNNER_TOKEN = '<该 runner 的 token>'
npm run start:runner
```

显式指定 CA 后，该连接只使用此文件中的信任锚，不附加公共 CA 列表。始终校验证书链、有效期及地址，不提供跳过证书验证的开关。CA 文件只需分发公钥证书；CA 私钥不放到 runner。

证书 SAN 必须包含 runner 实际连接的 IP 或域名。默认 runner 连接 `wss://127.0.0.1:<PORT>`，因此证书还应包含 `IP:127.0.0.1`。若证书仅包含 `hub.lan`，可在 Hub 上设置 `VIBEMOBILE_DEFAULT_RUNNER_HUB_URL=wss://hub.lan:5900`，确保此域名能从 Hub 本机解析并访问。

默认 runner 自动继承 Hub 的 CA 文件配置；未指定 CA 时，尝试使用 Hub 证书文件作为信任锚，适用于自签名证书。使用私有 CA 签发的证书时应明确提供 CA 文件。

浏览器访问 HTTPS 时，也需要在浏览器所在设备信任私有 CA；runner 的 CA 配置不会改变浏览器的信任设置。

## Hub 与默认 runner 的原生 TLS

把 Hub 作为 Windows 服务 / systemd 单元托管时，可以启用原生 TLS。下面以 Windows
服务为例，入口为 `https://vibemobile.lan:3000`；启用后原来的 `http://` 地址不再
应答（TLS 是在同一个端口上替换 HTTP/WS，不是旁边另开一个）。

证书由 `scripts/generate-hub-certs.mjs` 生成到 `certs/`。该目录已在 `.gitignore` 中，**私钥和 CA 私钥都不会入库**：

```bash
npm run gen:hub-certs
# 换了网段/机器，或者要额外的主机名：
node scripts/generate-hub-certs.mjs --san=192.168.1.20 --san=hub.lan --force
```

| 文件 | 用途 |
| --- | --- |
| `certs/ca.pem` | 私有 CA 公钥；Hub 与默认 runner 的信任锚 |
| `certs/ca.crt` | 同一 CA 的 DER 编码，给手机安装 |
| `certs/hub-cert.pem` | 服务器证书 + 完整链；SAN 含主机名、回环和生成时所有非回环 IP |
| `certs/hub-key.pem` | 服务器私钥，不要分发 |
| `certs/ca-key.pem` | CA 私钥，只留在 Hub 机器；不放到 runner |

服务的 NSSM 环境（`HKLM\SYSTEM\CurrentControlSet\Services\VibeMobile\Parameters` 的 `AppEnvironmentExtra`）：

```
VIBEMOBILE_HUB_TLS=on
VIBEMOBILE_HUB_TLS_CERT_FILE=<repo-root>\certs\hub-cert.pem
VIBEMOBILE_HUB_TLS_KEY_FILE=<repo-root>\certs\hub-key.pem
VIBEMOBILE_HUB_CA_FILE=<repo-root>\certs\ca.pem
VIBEMOBILE_PUBLIC_ORIGIN=https://vibemobile.lan:3000,https://127.0.0.1:3000,https://localhost:3000,https://[::1]:3000,https://192.0.2.10:3000
```

`PUBLIC_ORIGIN` 是**逗号分隔的允许列表**，浏览器实际发来的 `Origin` 必须逐字节命中其中一项。回环和局域网主机名是不同的 origin，所以都要列出来；只写一个的话，从其他地址打开页面能加载（顶层导航没有 Origin 头），但登录 POST 和 WS 会得到 403 `origin_not_allowed`。

**每一项的主机名必须小写、结尾不能有斜杠。** `hubApp.ts` 用字符串比较 `new URL(origin).origin`，而 URL 规范会把主机名小写化 —— 写成 `https://VIBEMOBILE.LAN:3000` 会在启动时抛 `PUBLIC_ORIGIN entries must be lowercase origins without trailing slashes`。真实 Origin 头也总是小写。

删掉这个变量则按 `https://<Host 头>` 反推，任何地址都能进，但也失去对 DNS 重绑定的保护。

**`http://` 不再可用是预期行为**：原生 TLS 是在同一个端口上替换 HTTP/WS，不是在旁边再开一个；要同时保留明文入口只能前面加反代或另起进程。

只改环境变量或换证书都需要重启进程（`dist` 已含 TLS 时无需重建）：

```powershell
Stop-Service VibeMobile -Force
# 更新 AppEnvironmentExtra ...
Start-Service VibeMobile
```

默认 runner 自动继承 Hub 的 CA 配置并连接 `wss://127.0.0.1:3000`，不需要单独设置。

手机信任私有 CA（只需一次）：

- iOS：把 `certs/ca.crt` 传到手机，安装描述文件，再到「设置 → 通用 → 关于本机 → 证书信任设置」为该 CA 打开完全信任。
- Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，选择 `ca.crt`。Chrome 信任用户安装的 CA；部分第三方 WebView 不信任。
- 不装 CA 时浏览器会报证书错误，不要用「继续访问」绕过 —— WS 和 fetch 仍然会失败。

验证时注意 **Windows 自带的 curl 是 Schannel 构建**：它忽略 `--cacert`，还会因为没有吊销信息报 `schannel: the revocation status is unknown`。用 Node 或 openssl：

```powershell
node -e "const https=require('node:https'),fs=require('node:fs');https.get({host:'vibemobile.lan',port:3000,path:'/api/hub',ca:fs.readFileSync('certs/ca.pem')},r=>{console.log(r.statusCode);r.pipe(process.stdout)}).on('error',e=>{console.error(e);process.exit(1)})"
```

```bash
openssl s_client -connect 127.0.0.1:3000 -CAfile certs/ca.pem -verify_ip 127.0.0.1
openssl s_client -connect 127.0.0.1:3000 -CAfile certs/ca.pem -verify_hostname vibemobile.lan
```

`-verify_hostname` 不检查 IP SAN，验 IP 要用 `-verify_ip`。

Hub 模式的健康判据在认证代理之后：先 `POST /api/auth/login` 拿 cookie，再 `GET /r/local/api/health`，确认 `build` 与 `buildOnDisk` 相等。

服务器证书默认有效期 825 天，CA 为 10 年。到期或换网段前重跑生成脚本并重启服务。

## 3. 公网由 Nginx 提供 TLS

Hub 保持 HTTP/WS，Nginx 负责 HTTPS/WSS，runner 连接 Nginx 的域名。

Hub：

```powershell
$env:VIBEMOBILE_HUB_TLS = 'off'
$env:VIBEMOBILE_PUBLIC_ORIGIN = 'https://vibe.example.com'
$env:VIBEMOBILE_SECURE_COOKIE = '1'
npm run start:hub
```

runner：

```powershell
$env:VIBEMOBILE_HUB_URL = 'wss://vibe.example.com'
Remove-Item Env:VIBEMOBILE_HUB_CA_FILE -ErrorAction SilentlyContinue
$env:VIBEMOBILE_RUNNER_ID = 'runner-b'
$env:VIBEMOBILE_RUNNER_TOKEN = '<该 runner 的 token>'
npm run start:runner
```

Nginx 使用正常受信任的证书时，runner 不需要保存或配置该证书。若 Nginx 使用私有 CA，仍通过 `VIBEMOBILE_HUB_CA_FILE` 指定 CA。

Nginx 现有 HTTPS server 中增加代理配置，覆盖 `/runner/connect`、`/r/.../ws` 和普通 HTTP：

```nginx
location / {
    proxy_pass http://127.0.0.1:5900;
    proxy_http_version 1.1;
    # $http_host 保留非默认端口；直接用 $host 会丢掉 :3443 这类端口。
    proxy_set_header Host $http_host;
    # 必须覆盖。Hub 开启 TRUST_PROXY 后取 X-Forwarded-For 的最左值，
    # $proxy_add_x_forwarded_for 会让客户端伪造的地址留在最左边，
    # 登录限流随之失效。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

完整的生产配置（登录限流、安全响应头、大文件上限）见
[nginx.example.conf](nginx.example.conf)。

若代理到已部署的 3000 Hub，替换 `proxy_pass` 的端口即可。默认 runner 在此模式仍通过本机 WS 连接 Hub，无需绕行公网 Nginx。

## Docker 配置与校验

- 原生 TLS：Hub Compose 设 `VIBEMOBILE_HUB_TLS=on`，开启示例证书目录只读挂载，将 `HUB_TLS_CERT_FILE`、`HUB_TLS_KEY_FILE`、`HUB_CA_FILE` 设置为容器内路径；`VIBEMOBILE_PUBLIC_ORIGIN` 使用 HTTPS。
- 独立 runner：开启 CA 文件只读挂载，设 `RUNNER_HUB_CA_FILE=/app/certs/ca.pem`。公网受信任证书场景不配置此变量。
- 局域网直接连接 Hub 容器时设 `HUB_BIND=0.0.0.0`；默认宿主机端口为 5900。
- `VIBEMOBILE_HUB_TLS=on` 缺少证书/私钥、文件不可读、密钥不匹配时启动失败，不会自动退回明文连接。
- runner 加载错误 CA 或遇到证书不匹配时，日志输出 `connection_error:<错误码>` 并重连；不会打印 token。
