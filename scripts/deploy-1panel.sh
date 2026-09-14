#!/usr/bin/env bash
# ============================================================
# dsh-cost-cloud 一键部署脚本（Ubuntu + 1Panel 环境）
#
#   sudo bash deploy-1panel.sh [安装目录] [对外端口]
#
# 例：
#   sudo bash deploy-1panel.sh /opt/dsh-cost-cloud 8787
#
# 脚本做的事（幂等，可重复运行）：
#   1. 检查 docker / docker compose
#   2. 把当前目录（含 src/ web/ docs/）复制到安装目录
#   3. 生成 .env：SESSION_SECRET 随机、ADMIN_PASSWORD_HASH 由你输入的口令派生
#   4. docker compose 构建并启动（端口只绑 127.0.0.1）
#   5. 自检 /healthz 并打印后续步骤
#
# 之后再用 1Panel「网站 → 反向代理」把 127.0.0.1:8787 暴露到域名 + HTTPS。
# ============================================================
set -euo pipefail

TARGET="${1:-/opt/dsh-cost-cloud}"
PORT="${2:-8787}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

say "1/6 检查依赖"
command -v docker >/dev/null 2>&1 || die "未找到 docker。1Panel 用户请先在面板「应用商店」安装 Docker（或按官方文档装）。"
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "未找到 docker compose。请先安装 compose 插件。"
fi
echo "docker compose: $($DC version --short 2>/dev/null || echo ok)"

say "2/6 复制文件到 $TARGET"
mkdir -p "$TARGET"
for item in src web docs scripts package.json Dockerfile docker-compose.yml docker-compose.1panel.yml .dockerignore README.md Caddyfile.example; do
  [ -e "$SRC/$item" ] && cp -r "$SRC/$item" "$TARGET/"
done
cd "$TARGET"
echo "已就位：$(ls -1 | tr '\n' ' ')"

say "3/6 生成 .env"
if [ -f .env ] && grep -q '^SESSION_SECRET=.\+' .env; then
  echo ".env 已存在且含 SESSION_SECRET，跳过生成（如需重置请自行删除）"
else
  printf '设置管理员口令（输入时不回显）：'
  read -rs ADMIN_PW; echo
  [ -n "$ADMIN_PW" ] || die "口令不能为空"
  [ ${#ADMIN_PW} -ge 8 ] || die "口令至少 8 位"
  SECRET="$(docker run --rm node:24-alpine node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  # 用容器里的 node 生成 scrypt 哈希（与 src/auth.js 的 verifyPassword 格式一致）
  HASH="$(docker run --rm -e PW="$ADMIN_PW" node:24-alpine node -e "
    const { scryptSync, randomBytes } = require('node:crypto');
    const salt = randomBytes(16);
    const dk = scryptSync(process.env.PW, salt, 32, { N: 16384, r: 8, p: 1 });
    console.log(['scrypt', 16384, 8, 1, salt.toString('base64'), dk.toString('base64')].join('\$'));
  ")"
  case "$HASH" in
    scrypt\$*) ;;
    *) die "口令哈希生成失败（检查 docker 是否可运行 node 镜像）" ;;
  esac
  cat > .env <<EOF
# 由 deploy-1panel.sh 生成 $(date -Iseconds)
SESSION_SECRET=$SECRET
ADMIN_PASSWORD_HASH=$HASH

# 设备共享引导令牌：留空 → 启动后在云端看板「设置」页点一下生成（更省事）
DSH_SYNC_TOKEN=

# 1Panel 反代在本机，服务端口只绑回环
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=/data
TRUST_PROXY=1
EOF
  chmod 600 .env
  echo ".env 已生成（权限 600）"
fi

say "4/6 构建并启动（首次构建约 1-2 分钟）"
$DC -f docker-compose.yml -f docker-compose.1panel.yml up -d --build

say "5/6 自检"
sleep 4
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "健康检查通过：http://127.0.0.1:$PORT/healthz"
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health" | head -c 300; echo
else
  echo "健康检查未通过，最近日志："
  $DC logs --tail 40 dsh-cost-cloud || true
  die "请把上面的日志发给我，或检查端口占用：ss -ltnp | grep $PORT"
fi

say "6/6 完成"
cat <<EOF
容器已在跑，端口仅绑定 127.0.0.1:$PORT。

下一步（二选一）：
  A. 先用 SSH 隧道在本地临时访问（最安全，不暴露公网）：
     在你自己的电脑上执行：
       ssh -N -L 8787:127.0.0.1:$PORT ubuntu@<服务器IP>
     然后浏览器打开 http://127.0.0.1:8787 ，用刚才设置的口令登录。

  B. 正式对外（推荐，走 1Panel）：
     1Panel → 网站 → 创建网站 → 反向代理
       域名：cost.example.com（DNS 解析到本机）
       代理地址：http://127.0.0.1:$PORT
       开启 HTTPS 证书
     （记得在腾讯云轻量防火墙 + 1Panel 防火墙放行 80/443，8787 不需要放行）

登录后到「设置」页点「生成共享引导令牌」，把它填进每台电脑的
「设置 → 插件 → 插件配置 → 花费统计」卡片里，然后点「测试连接」→「立即同步」。

常用运维：
  查看日志： cd $TARGET && $DC logs -f dsh-cost-cloud
  重启：     cd $TARGET && $DC restart
  升级：     替换 $TARGET 下代码后 $DC -f docker-compose.yml -f docker-compose.1panel.yml up -d --build
  备份：     docker run --rm -v dsh_data:/data -v "\$PWD:/backup" alpine tar czf /backup/dsh-cost-backup-\$(date +%F).tar.gz -C /data .
EOF
