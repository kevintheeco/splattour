#!/bin/bash
# bg.sh <logname> <cmd...>: run detached with the bench environment
cd /workspace/st/bench
. /workspace/env.sh
export OMP_NUM_THREADS=16 OPENBLAS_NUM_THREADS=1
setsid nohup "${@:2}" > /workspace/$1.log 2>&1 < /dev/null &
echo started $1
