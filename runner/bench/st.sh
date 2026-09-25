#!/bin/bash
for f in /workspace/*.log; do n=$(basename $f .log); [ $n = boot ] || [ $n = gsplat_setup ] && continue; echo "== $n: $(grep -v '^I2026' $f | grep -vi -e openblas -e 'rebuild your' -e 'environment variable' -e 'application may' | tail -1 | cut -c1-200)"; echo "   $(tail -1 $f | cut -c1-180)"; done
cat /workspace/sfm/*/summary.json 2>/dev/null | python3 -c "import sys;print(sys.stdin.read()[:3000])"
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader; uptime
