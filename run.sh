#!/bin/bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    ./venv/bin/pip install --upgrade pip
    ./venv/bin/pip install -r backend/requirements.txt
fi

echo "======================================================="
echo "🎧 PDF Audio Reader — Starting Server"
echo "======================================================="
echo "• Local URL:  http://localhost:8000"
echo "• Mobile URL: http://$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'YOUR_LOCAL_IP'):8000"
echo "======================================================="

./venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
