# 腾讯轻量 + 1Panel 部署指南（dsh-cost-cloud）

本文是按 **腾讯云轻量应用服务器 + 1Panel 社区版（Docker 环境）** 写的实操步骤。
整体思路：**容器只监听 `127.0.0.1:8787`，公网入口交给 1Panel 自带的 OpenResty 反向代理 + Let's Encrypt 证书** ——
不需要额外跑 Caddy，也不要在面板/云防火墙里放行 8787。

---

## 0. 先做这三件事（重要）

1. **改掉服务器 SSH 密码**（如果你在聊天/工单里贴过口令）：
   ```bash
   passwd                      # 交互式改密码
   ```
   更好的是转成密钥登录：1Panel →「主机 → SSH 管理」可配置公钥与「禁止密码登录」。
   同时到腾讯云控制台的「登录日志」确认没有陌生 IP。
2. **确认 Docker 已装好**：1Panel →「应用商店 → 已安装」里应有 Docker；或在终端执行 `docker --version`。
   若没有：1Panel →「应用商店」搜索 Docker 安装。
3. **确认你的账户能免 sudo 用 docker**（脚本里会用到）：
   ```bash
   sudo usermod -aG docker ubuntu && newgrp docker     # 或重新登录一次
   docker ps      # 不报权限错误即可
   ```

---

## 1. 把代码放到服务器

任选其一。

**仓库地址**：`https://github.com/Angelyeye/dsh-cost-cloud`（公开仓库，服务器克隆不需要凭据）

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone https://github.com/Angelyeye/dsh-cost-cloud.git
sudo chown -R $USER:$USER /opt/dsh-cost-cloud
cd /opt/dsh-cost-cloud
ls -1          # 应看到 src web docs scripts Dockerfile docker-compose*.yml
```

`.env` **不在仓库里**（已 gitignore），密钥只存在于服务器上 —— 所以 `git pull` 升级永远不会覆盖你的密钥。

### 以后升级（一条命令）

```bash
cd /opt/dsh-cost-cloud
git pull
docker compose -f docker-compose.yml -f docker-compose.1panel.yml up -d --build
```

数据库迁移在容器启动时自动执行；迁移前会把旧库复制到卷内 `data/backups/`（保留最近 7 份）。
想锁定版本可以 `git checkout <tag>` 再重建。

### 备选：不用 git 的压缩包方式

```bash
cd /opt
curl -L https://github.com/Angelyeye/dsh-cost-cloud/archive/refs/heads/main.tar.gz | tar xz
mv dsh-cost-cloud-main dsh-cost-cloud && cd dsh-cost-cloud
```
（缺点：没有版本历史，升级要重新下载；不推荐长期使用。）

### 若你日后改成私有仓库

```bash
# 服务器上生成专用只读密钥
ssh-keygen -t ed25519 -f ~/.ssh/id_git -N '' -C dshc-server
cat ~/.ssh/id_git.pub
# 把上面这行加到 GitHub 仓库 → Settings → Deploy keys（勾选只读，不要勾写权限）
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_git" git clone git@github.com:Angelyeye/dsh-cost-cloud.git
```

---

## 2. 一键部署

克隆完成后，在服务器上执行：

```bash
cd /opt/dsh-cost-cloud
sudo bash scripts/deploy-1panel.sh /opt/dsh-cost-cloud 8787
```

脚本会：检查 docker → 生成 `.env`（随机 `SESSION_SECRET` +
用你输入的口令派生 `ADMIN_PASSWORD_HASH`，文件权限 600）→ 构建并启动（端口只绑回环）→ 自检 `/healthz` → 打印后续步骤。
脚本是幂等的，可重复运行；已有 `.env` 时不会覆盖，所以配合 `git pull` 升级很安全。

---

## 3. 用 1Panel 对外发布（域名 + HTTPS）

1. **DNS**：把 `cost.你的域名.com` 解析到 `81.71.157.148`（A 记录）。
2. **防火墙**：只需放行 80 / 443。
   - 腾讯云轻量「防火墙」里放行 80、443；
   - 1Panel →「主机 → 防火墙」同样放行 80、443。
   - **8787 不要放行**（容器只绑回环，公网访问不到它）。
3. **建站点**：1Panel →「网站 → 创建网站」
   - 类型：**反向代理**
   - 主域名：`cost.你的域名.com`
   - 代理地址：`http://127.0.0.1:8787`
4. **开 HTTPS**：站点详情 →「HTTPS」→ 选择/申请 Let's Encrypt 证书 → 开启强制 HTTPS。
5. 浏览器打开 `https://cost.你的域名.com`，用第 2 步设置的口令登录。

> 想先不暴露公网？用 SSH 隧道即可（在**你自己的电脑**上执行）：
> ```powershell
> ssh -N -L 8787:127.0.0.1:8787 ubuntu@81.71.157.148
> ```
> 然后浏览器打开 `http://127.0.0.1:8787`。这条路径不需要域名和证书。

---

## 4. 生成共享引导令牌并接入各电脑

1. 看板 → **设置** → 「共享引导令牌」→ 点生成（会自动写回服务器上的 `.env`，重启后仍有效）。
2. 在每台电脑的 DSH 里：**设置 → 插件 → 插件配置 → 花费统计**
   | 字段 | 填什么 |
   | --- | --- |
   | 设备名 | 该机器在看板上的名字，如「办公台式机」 |
   | 服务地址 | `https://cost.你的域名.com` |
   | 共享令牌 | 上一步生成的 `dshc_...` |
   | 同步间隔 | 默认 60 秒即可 |
3. 点「测试连接」→「立即同步」。回到 **设置 → 花费统计**，顶部三态开关可用。

---

## 5. 验收清单

```bash
# 容器状态
docker compose -f docker-compose.yml -f docker-compose.1panel.yml ps

# 健康检查（本机）
curl -s http://127.0.0.1:8787/healthz
curl -s http://127.0.0.1:8787/api/v1/health | head -c 300

# 确认公网没有直接暴露 8787（应超时/拒绝）
#   在你自己电脑上：Test-NetConnection 81.71.157.148 -Port 8787
```

看板里应能看到：设备数、按 Agent 分布、**设备 × Agent 矩阵**（行合计 = 列合计 = 总计）。

---

## 6. 日常运维

```bash
cd /opt/dsh-cost-cloud
DC="docker compose -f docker-compose.yml -f docker-compose.1panel.yml"

$DC logs -f dsh-cost-cloud          # 看日志
$DC restart                         # 重启
$DC down                            # 停止（数据卷保留）
$DC up -d --build                   # 代码更新后重建

# 备份（把数据卷打包到当前目录）
docker run --rm -v dsh_data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/dsh-cost-backup-$(date +%F).tar.gz -C /data .

# 恢复
docker run --rm -v dsh_data:/data -v "$PWD:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/dsh-cost-backup-YYYY-MM-DD.tar.gz -C /data'
```

**升级流程**：在服务器上 `git pull`（或重新 scp 覆盖）→ `$DC up -d --build`。
数据库迁移在启动时自动执行，且迁移前会把旧库备份到 `data/backups/`（卷内，保留最近 7 份）。

---

## 7. 1Panel 使用小贴士

- **容器编排**：1Panel「容器 → 编排」可以直接导入 `docker-compose.yml`；本指南同时提供了
  `docker-compose.1panel.yml` 覆盖文件（把端口改成只绑回环）。面板里创建编排时把两个文件都放进去，
  或在「编辑」里把 `ports` 改成 `- "127.0.0.1:8787:8787"`。
- **查看数据卷**：1Panel →「容器 → 存储卷」里能看到 `dsh_data`，可下载/备份。
- **不想用命令行**：面板里也能完成「构建镜像 → 创建容器」，需要设置的环境变量就是 `.env.example`
  里那几项（`SESSION_SECRET`、`ADMIN_PASSWORD_HASH` 必填，否则服务会拒绝启动——这是刻意的 fail-closed）。
- **反向代理 502**：先 `curl -s http://127.0.0.1:8787/healthz` 确认容器在跑，再检查 1Panel 代理地址是否写成了
  `http://127.0.0.1:8787`（不要写 `localhost` 之外的主机名，也不要带路径）。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动即退出，日志说缺 `SESSION_SECRET` / `ADMIN_PASSWORD_HASH` | 预期行为（fail-closed）。补进 `.env` 后 `$DC up -d` |
| 忘记管理员口令 | `cd /opt/dsh-cost-cloud && node -e "..."` 不方便时，直接用容器生成新哈希：<br>`docker run --rm -e PW='新口令' node:24-alpine node -e "const{scryptSync,randomBytes}=require('node:crypto');const s=randomBytes(16);const d=scryptSync(process.env.PW,s,32,{N:16384,r:8,p:1});console.log(['scrypt',16384,8,1,s.toString('base64'),d.toString('base64')].join('\$'))"`<br>写回 `.env` 的 `ADMIN_PASSWORD_HASH` 后重启 |
| 插件提示「令牌无效」 | 看板里重新生成共享令牌并更新插件配置；旧令牌不会自动失效，可在「设备」页清空对应设备数据 |
| 上报返回 429 | 触发了服务端限流（默认 120 次/分钟/设备），插件会自动退避重试，无需处理 |
| 磁盘占用 | 100 万条明细量级约数百 MB；可到「设备」页清理不需要的设备数据 |
