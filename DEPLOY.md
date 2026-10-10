# FormatDesk 部署清单（Ubuntu 22.04 / 24.04 · 轻量服务器）

> 目标：把本机这套「零依赖 Node 22 + FFmpeg + LibreOffice」原样搬到云服务器。
> 代码零改动（引擎探测已支持 Linux PATH；监听地址/密钥全走环境变量）。

## 第 0 步 · 立刻去做（和部署并行）
- 买域名（.com/.cn 均可，几行钱/年）→ 实名认证（1–3 天）
- 云控制台提交 **ICP 备案**（需要这台服务器 + 已实名域名，审核 1–2 周）
- 备案期间不耽误：先用 `http://服务器IP:8787` 自测，全部弄好等备案号下来再切域名

## 第 1 步 · 装系统 + 放行端口（云控制台操作）
1. 轻量服务器控制台 → 重装系统 → 选 **Ubuntu 24.04 LTS**（纯净系统镜像，别选宝塔等应用镜像）
2. 防火墙/安全组放行：`22/tcp`（SSH）、`80/tcp`、`443/tcp`；自测阶段临时放行 `8787/tcp`，上线后关掉

## 第 2 步 · SSH 登录装环境（整段复制执行）
```bash
ssh root@你的服务器IP

apt update && apt -y upgrade
apt install -y curl xz-utils

# Node 22（走 npmmirror，国内秒下）
cd /tmp && curl -fLO https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-linux-x64.tar.xz
tar -xJf node-v22.14.0-linux-x64.tar.xz -C /opt
ln -sf /opt/node-v22.14.0-linux-x64/bin/node /usr/local/bin/node
node -v   # 应显示 v22.14.0

# 转换引擎 + 中文字体（字体决定中文文档转 PDF 的效果，必装）
apt install -y ffmpeg
apt install -y --no-install-recommends \
  libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
  libreoffice-l10n-zh-cn fonts-noto-cjk fonts-noto-cjk-extra
fc-cache -f

ffmpeg -version | head -1 && soffice --version
```

## 第 3 步 · 上传项目（在你本机 Git Bash 执行）
```bash
cd "D:/86198/Documents/转换格式"
ssh root@你的服务器IP "mkdir -p /opt/formatdesk"
scp -r index.html fonts server root@你的服务器IP:/opt/formatdesk/
# 不需要传：tools/（Windows 引擎二进制）、server/data/（运行时数据）
```

## 第 4 步 · systemd 常驻服务（服务器上执行）
```bash
# 生成随机密钥并记下（改 secret 会使已签发的下载链接失效，属正常）
SECRET=$(openssl rand -hex 32); echo "FD_SECRET=$SECRET"

mkdir -p /opt/formatdesk/server/data

cat > /etc/systemd/system/formatdesk.service <<'EOF'
[Unit]
Description=FormatDesk converter
After=network.target

[Service]
WorkingDirectory=/opt/formatdesk/server
Environment=FD_HOST=127.0.0.1
Environment=FD_PORT=8787
Environment=FD_DATA=/opt/formatdesk/server/data
Environment=FD_SECRET=换成上面生成的SECRET
ExecStart=/usr/local/bin/node index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now formatdesk
systemctl status formatdesk --no-pager
curl -s http://127.0.0.1:8787/api/health
# 期望：{"ok":true,"engines":{"ffmpeg":true,"ffprobe":true,"libreoffice":true,...}}
```
> 注意把 `FD_SECRET=换成上面生成的SECRET` 替换成真实值再 daemon-reload。
> 若服务器是 2G 内存：改 index.js 前在 systemd 里加 `Environment=NODE_OPTIONS=--max-old-space-size=512`，并把 config 的 doc 并发降为 1（跟我说一声我来改）。

## 第 5 步 · Nginx 反向代理 + HTTPS（备案下来、域名解析之后）
```bash
apt install -y nginx certbot python3-certbot-nginx

cat > /etc/nginx/sites-available/formatdesk <<'EOF'
server {
    listen 80;
    server_name 你的域名.com;

    client_max_body_size 120m;      # 关键：默认 1M 会卡死大文件上传

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;   # SSE 长连接不被掐断
        proxy_buffering off;        # 进度实时推送
    }
}
EOF
ln -sf /etc/nginx/sites-available/formatdesk /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# 证书（域名解析生效、备案通过后）
certbot --nginx -d 你的域名.com
```
Nginx 起来后，回云控制台把 `8787` 的放行**关掉**，只留 80/443。

## 第 6 步 · 上线验收（全部通过才算上线完成）
- [ ] `curl https://你的域名/api/health` → engines ffmpeg/libreoffice 均 true
- [ ] 浏览器打开首页 → 拖一个真 mp4 转 MP3 → 能下载能播放
- [ ] 拖一个 docx 转 PDF → 中文不乱码（验证 fonts-noto-cjk 生效）
- [ ] 等 60 分钟 → `du -sh /opt/formatdesk/server/data` 回落（TTL 清理在工作）
- [ ] 服务器上跑一遍测试：`cd /opt/formatdesk/server && node --test test/*.test.js` → 52/52
- [ ] `free -h` 看内存水位、`df -h` 看磁盘，高峰期无压力

## 日常运维备忘
- 看日志：`journalctl -u formatdesk -f`
- 重启服务：`systemctl restart formatdesk`
- 更新代码：本机 scp 覆盖 → `systemctl restart formatdesk`
- 数据全在 `/opt/formatdesk/server/data`，重启不丢，60 分钟自动清
