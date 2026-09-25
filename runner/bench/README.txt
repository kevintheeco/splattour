Interactive GPU workbench used for 월하정 (2026-09-25): one RunPod pod you drive over SSH.
  python runner/bench/launch_bench.py <name> <max_hours> "<gpu ids, comma>"   # bundles pipeline/ + runner/bench/, boots bench_boot.sh
  python runner/bench/rsh.py <pod> '<cmd>'      # ssh (export MSYS_NO_PATHCONV=1 in Git Bash)
  python runner/bench/push.py <pod> <remote_dir> <files...>
On the pod: bash bg.sh <log> <cmd...> runs detached (never `pkill -f` a pattern that is in your own ssh command line).
  prep.py -> sfm_bench.py <v> OPENCV global seq -> pack.sh <model> (dataset.tar + database/model archive to R2)
  fetch_train.sh <variant> 60000 5000000 8 [use_bilateral_grid] -> upply.sh <variant>;  arm.sh <seconds> = hard self-removal.
Pods do not write the cloud ledger: record spend by hand (secrets/cloud_ledger.jsonl) and check bal.py.
