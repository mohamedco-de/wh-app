#!/data/data/com.termux/files/usr/bin/bash
# تثبيت البوت على تيرمكس بأمر واحد
set -e
cd "$(dirname "$0")"

echo "📦 تثبيت الحزم..."
pkg update -y && pkg upgrade -y
pkg install -y nodejs git python ffmpeg tmux
pip install -U yt-dlp
npm install

if [ ! -f .env ]; then
  read -rp "🔑 مفتاح loader.to (اختياري، Enter للتخطي): " KEY
  read -rp "🔑 مفتاح remove.bg (Enter للتخطي): " RBG
  read -rp "🔑 مفتاح Gemini (Enter للتخطي): " GEM
  printf "LOADER_API_KEY=%s\nREMOVEBG_API_KEY=%s\nGEMINI_API_KEY=%s\n" "$KEY" "$RBG" "$GEM" > .env
fi

# اختصار: اكتب bot لتشغيل البوت
if ! grep -q "alias bot=" ~/.bashrc 2>/dev/null; then
  echo "alias bot='bash $(pwd)/start.sh'" >> ~/.bashrc
fi

echo
echo "✅ تم التثبيت. شغّل البوت بـ:  bash start.sh   (أو اكتب bot بعد ما تعيد فتح تيرمكس)"
