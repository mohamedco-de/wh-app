#!/data/data/com.termux/files/usr/bin/bash
# تشغيل البوت داخل tmux عشان يظل شغال
cd "$(dirname "$0")"
termux-wake-lock 2>/dev/null || true
exec tmux new-session -A -s bot "node index.js; echo 'البوت وقف. اضغط Enter'; read"
