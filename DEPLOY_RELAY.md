# SuperCrzy 自建 Relay 服务器部署指南

## 你的配置
- 域名：`supercrzy.com`（AI 资讯网站）
- Relay 子域名：`agent.supercrzy.com`（新建）
- 服务器：美国云服务器（一台共存）

## 第一步：域名解析

在域名 DNS 管理后台添加一条 A 记录：
```
类型: A
主机: agent
值:   [你的服务器IP]
TTL:  600
```
效果：`agent.supercrzy.com` → 服务器 IP（和主站同 IP 即可）

## 第二步：安装 Node.js + nginx

```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git
```

## 第三步：部署中继服务

```bash
git clone https://github.com/SuperCrzy/deepseek-agent.git /opt/supercrzy
cd /opt/supercrzy/packages/server
npm install ws

sudo tee /etc/systemd/system/supercrzy-relay.service << EOF
[Unit]
Description=SuperCrzy Relay Server
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=/opt/supercrzy/packages/server
ExecStart=/usr/bin/npx tsx src/services/relay-server.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable supercrzy-relay
sudo systemctl start supercrzy-relay
```

## 第四步：Nginx + HTTPS

```bash
sudo tee /etc/nginx/sites-available/supercrzy-relay << 'EOF'
server {
    listen 80;
    server_name agent.supercrzy.com;

    location /agent {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/supercrzy-relay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS
sudo certbot --nginx -d agent.supercrzy.com -m your@email.com --agree-tos
```

## 第五步：PC Agent 配置

```bash
export SUPERCRZY_RELAY=wss://agent.supercrzy.com/agent
npm start
```

启动后微信收到的文件链接：
```
https://agent.supercrzy.com/a1b2c3d4/api/preview/index.html
```
永久有效，HTTPS，无警告页。
