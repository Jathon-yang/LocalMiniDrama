#!/usr/bin/env bash
# 一键启动开发环境：后端 (backend-node:5679) + 前端 (frontweb:3013)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend-node"
FRONTEND_DIR="$ROOT/frontweb"

command -v node >/dev/null 2>&1 || { echo "错误: 未找到 node，请先安装 Node.js (>=18)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "错误: 未找到 npm"; exit 1; }

for dir in "$BACKEND_DIR" "$FRONTEND_DIR"; do
  if [ ! -d "$dir/node_modules" ]; then
    echo "==> 首次运行，正在安装依赖: $(basename "$dir")"
    (cd "$dir" && npm install)
  fi
done

# 释放被占用端口
free_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "==> 端口 $port 被占用，正在结束进程: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}
free_port 5679

pids=()
cleanup() {
  echo ""
  echo "==> 正在停止服务..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

echo "==> 启动后端 (http://127.0.0.1:5679)"
(cd "$BACKEND_DIR" && npm run dev) &
pids+=($!)

echo "==> 启动前端 (http://127.0.0.1:3013)"
(cd "$FRONTEND_DIR" && npm run dev) &
pids+=($!)

echo ""
echo "开发服务已启动，按 Ctrl+C 停止全部服务"
wait
