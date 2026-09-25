#!/bin/bash
ID=$(tr '\0' '\n' < /proc/1/environ | grep ^RUNPOD_POD_ID= | cut -d= -f2)
pkill -f "sleep 8400" 2>/dev/null
setsid nohup bash -c "sleep $1; runpodctl remove pod $ID" > /dev/null 2>&1 < /dev/null &
echo armed $ID $1
