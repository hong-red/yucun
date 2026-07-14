#!/bin/bash
# 渔村智慧助手 — 宝塔一键部署脚本
set -e

echo "=========================================="
echo "🐟 渔村智慧助手 — 宝塔一键部署"
echo "=========================================="

# 1. 安装 Node.js
echo ""
echo "📦 正在安装 Node.js 18..."
curl -sL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs git

# 2. 安装 PM2
echo ""
echo "🚀 正在安装 PM2..."
npm install -g pm2

# 3. 下载项目
echo ""
echo "⬇️  正在下载项目..."
cd /www/wwwroot
rm -rf yucun
git clone https://github.com/hong-red/yucun.git

# 4. 安装依赖并启动
echo ""
echo "⚙️  正在安装依赖并启动服务..."
cd yucun
npm install
pm2 start server.js --name "渔村助手"
pm2 save

# 5. 防火墙放行
echo ""
echo "🔓 正在放行 8383 端口..."
firewall-cmd --zone=public --add-port=8383/tcp --permanent 2>/dev/null || true
firewall-cmd --reload 2>/dev/null || true

echo ""
echo "=========================================="
echo "✅ 部署完成！"
echo ""
echo "📍 服务地址: http://81.70.191.44:8383"
echo ""
echo "⚠️  请在宝塔面板中操作："
echo "   1. 网站 → 添加站点 → 域名填 81.70.191.44"
echo "   2. 根目录选 /www/wwwroot/yucun/public"
echo "   3. PHP 版本选 [纯静态]"
echo "   4. 设置 → 反向代理 → 添加："
echo "      目标 URL: http://127.0.0.1:8383"
echo "=========================================="
