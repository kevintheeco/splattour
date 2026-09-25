import sys, subprocess
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "pipeline"))
from splattour.cloud import RunPod, Ssh, SECRETS
pod, remote_dir = sys.argv[1], sys.argv[2]
p = RunPod().pod(pod); port = (p.get("portMappings") or {}).get("22")
s = Ssh(p["publicIp"], int(port), SECRETS / "splattour_ed25519")
for f in sys.argv[3:]:
    data = open(f, "rb").read()
    r = subprocess.run(s.base + [f"mkdir -p {remote_dir} && cat > {remote_dir}/{f.replace(chr(92),'/').rsplit('/',1)[-1]}"], input=data, capture_output=True)
    print(f, r.returncode, r.stderr[-200:])
