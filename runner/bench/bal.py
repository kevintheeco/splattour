import sys, requests
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "pipeline"))
from splattour.cloud import api_key
r = requests.post('https://api.runpod.io/graphql', headers={'Authorization': 'Bearer ' + api_key()}, json={'query': 'query { myself { clientBalance currentSpendPerHr } }'}, timeout=30)
print(r.json()['data']['myself'])
