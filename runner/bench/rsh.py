import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "pipeline"))
from splattour.cloud import RunPod, Ssh, SECRETS
pod = sys.argv[1]; cmd = sys.argv[2]
p = RunPod().pod(pod)
ip, ports = p.get("publicIp"), p.get("portMappings") or {}
port = ports.get("22") or ports.get(22)
print("#", p.get("desiredStatus"), (p.get("machine") or {}).get("gpuDisplayName"), p.get("costPerHr"), ip, port, flush=True)
s = Ssh(ip, int(port), SECRETS / "splattour_ed25519")
print(s.run(cmd, check=False, timeout=120))
