import sys, json, time
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "pipeline"))
from splattour.inbox import BUCKET, client, keys
s3 = client(keys())
def get(k, raw=False):
    try:
        b = s3.get_object(Bucket=BUCKET, Key=k)["Body"].read()
        return b if raw else json.loads(b)
    except Exception as e:
        return None
def ls(prefix):
    out=[]
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        out += page.get("Contents", [])
    return out
if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "log":
        b = get(f"cloud/logs/{sys.argv[2]}.log", raw=True) or b""
        n = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
        sys.stdout.buffer.write(b[-n:]); print()
    elif cmd == "ls":
        for o in ls(sys.argv[2]): print(o["Key"], o["Size"], o["LastModified"])
    elif cmd == "get":
        sys.stdout.buffer.write(get(sys.argv[2], raw=True) or b"NONE")
