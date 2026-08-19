#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Docker Compose up"
docker compose up --build -d

echo "==> Health"
sleep 3
curl -sf http://127.0.0.1:8000/api/health || curl -sf http://127.0.0.1/api/health

echo
echo "Frontend: http://SERVER_IP/"
echo "API:      http://SERVER_IP:8000/docs"
echo
echo "Публичная ссылка (Cloudflare Tunnel):"
echo "  cloudflared tunnel --url http://localhost:80"
echo "Запасной вариант:"
echo "  ngrok http 80"
