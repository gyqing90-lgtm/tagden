#!/bin/bash
# 物种标注工坊 · macOS 启动器
# 由 build-mac.js 原样打进 zip。程序是同目录 app/main.js，node 是官方原版运行时。
# 双击本文件即可；参数会原样传给程序，例如： ./start.command --port 8080

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
cd "$HERE" || exit 1

NODE="$HERE/node"
MAIN="$HERE/app/main.js"

if [ ! -f "$NODE" ] || [ ! -f "$MAIN" ]; then
  echo "启动失败：node 或 app/main.js 不在「$HERE」里。"
  echo "请确认 zip 已完整解压，且 start.command / node / app 三层还在一起。"
  echo
  echo "按回车键关闭窗口…"
  read -r _
  exit 1
fi

# 从网络下载的 zip 会被系统打上隔离标记，可能拦住包内这个未签名的 node。
# 只清本包里这两个文件，失败也不影响启动。
xattr -d com.apple.quarantine "$NODE" 2>/dev/null || true
xattr -d com.apple.quarantine "$MAIN" 2>/dev/null || true
chmod +x "$NODE" 2>/dev/null || true

PORT=7801
_prev=""
for _a in "$@"; do
  [ "$_prev" = "--port" ] && PORT="$_a"
  case "$_a" in --port=*) PORT="${_a#--port=}" ;; esac
  _prev="$_a"
done

echo "物种标注工坊启动中…  浏览器会自动打开 http://127.0.0.1:${PORT}"
echo "关掉这个终端窗口（或按 Ctrl+C）即停止服务。"
echo

exec "$NODE" "$MAIN" "$@"
