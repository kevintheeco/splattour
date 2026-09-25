#!/usr/bin/env bash
# AI super-resolution retrain of wolhajeong on one RunPod GPU, fully autonomous:
#   fetch dataset -> 2x SR of the 784 training frames -> gsplat MCMC (same recipe) -> eval vs ORIGINAL frames
#   -> side-by-side renders -> everything to R2 cloud/max/<job>/ai-x2/ -> pod removes itself.
# Env: R2_*, BENCH_JOB, MAX_HOURS, SR_MODEL (file name), SR_URL, optional SR_DN (denoise mix, x4v3 only), CAP.
set -u
cd /workspace
exec > >(tee -a /workspace/job.log) 2>&1
echo "[ai] $(date -u) pod=${RUNPOD_POD_ID:-?} gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader)"
( sleep $(( ${MAX_HOURS:-5} * 3600 )); runpodctl remove pod "${RUNPOD_POD_ID:-}" ) >/dev/null 2>&1 &
S=/workspace/st/aisr
export PYTHONUNBUFFERED=1
die() { python $S/r2io.py status "{\"phase\":\"FAILED $1\"}"; python $S/r2io.py logs; runpodctl remove pod "$RUNPOD_POD_ID"; exit 1; }
python -m pip install -q boto3 spandrel opencv-python-headless >/dev/null 2>&1
python $S/r2io.py status '{"phase":"boot"}'
( while true; do sleep 180; python $S/r2io.py logs >/dev/null 2>&1; done ) &
python $S/r2io.py fetch || die fetch
mkdir -p /workspace/ds1 && tar xf /workspace/dataset.tar -C /workspace/ds1 images && rm -f /workspace/dataset.tar
mkdir -p /workspace/ds1/sparse && mv /workspace/sparse_clean /workspace/ds1/sparse/0
# gsplat (same SETUP as pipeline/splattour/cloud.py) in the background while SR runs
python -c "import sys; sys.path.insert(0,'/workspace/st/pipeline'); from splattour.cloud import SETUP; open('/workspace/setup.sh','w').write(SETUP)"
mkdir -p /workspace/wheels && cp $S/wheels/*.whl /workspace/wheels/ 2>/dev/null
( bash -lc "bash /workspace/setup.sh" > /workspace/setup.log 2>&1; echo $? > /workspace/SETUP_RC ) &
python $S/r2io.py status '{"phase":"sr"}'
python $S/sr_all.py /workspace/ds1 /workspace/ds2 /workspace/models || die sr
while [ ! -f /workspace/SETUP_RC ]; do sleep 10; done
[ "$(cat /workspace/SETUP_RC)" = 0 ] || { tail -30 /workspace/setup.log; die setup; }
python $S/r2io.py status '{"phase":"eval-current"}'
python $S/eval_ai.py current > /workspace/eval_current.log 2>&1; echo "[ai] eval-current exit $?"; tail -5 /workspace/eval_current.log
cp /workspace/eval_current.log /workspace/eval.log; python $S/r2io.py logs
python $S/r2io.py status '{"phase":"train"}'
cd /workspace/gsplat/examples
H=$(python simple_trainer.py mcmc --help)
f() { local hy="--${1//_/-}"; if echo "$H" | grep -q -- "$hy"; then echo "$hy"; else echo "--$1"; fi; }
# identical to the published model's command (cloud/max/<job>/mcmc5m-60k-off/result.json) except data/result dirs
python simple_trainer.py mcmc $(f data_dir) /workspace/ds2 $(f data_factor) 1 $(f result_dir) /workspace/result \
  $(f no_normalize_world_space) $(f antialiased) $(f strategy.cap_max) ${CAP:-5000000} $(f max_steps) 30000 $(f eval_steps) 30000 \
  $(f save_steps) 30000 $(f save_ply) $(f ply_steps) 30000 $(f test_every) 8 $(f disable_viewer) $(f steps_scaler) 2 \
  $(f opacity_reg) 0.00344 $(f scale_reg) 0.00344 > /workspace/train.log 2>&1
echo "[ai] train exit $? $(date -u)"
cd /workspace
python $S/r2io.py status '{"phase":"eval"}'
python $S/eval_ai.py > /workspace/eval.log 2>&1; echo "[ai] eval exit $?"; tail -30 /workspace/eval.log
python $S/r2io.py final
echo "[ai] done $(date -u)"
python $S/r2io.py logs
runpodctl remove pod "$RUNPOD_POD_ID"
