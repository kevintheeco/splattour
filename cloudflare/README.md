# pochak.kr 배포 (Cloudflare)

2026-11-18부터 공개 사이트는 Vercel이 아니라 Cloudflare Worker `pochak`(계정 tinydots Inc.)에서 돈다.

| 주소 | 하는 일 |
| --- | --- |
| `https://pochak.kr` | 사이트. `viewer/dist` 정적 파일 + 업로드 API(`worker.js`) |
| `https://media.pochak.kr` | 장면 파일. R2 버킷 `hanok360`의 공개 주소 |
| `https://3dgstour.com`, `www.3dgstour.com`, `www.pochak.kr` | `https://pochak.kr` 같은 경로로 301 (Cloudflare Redirect Rule) |
| `https://media.3dgstour.com` | 옛 링크용으로 계속 살려 둔 같은 R2 버킷 주소 |

## 배포

```bash
npx wrangler@4 login        # 처음 한 번, tinydots Inc. 계정
bash cloudflare/deploy.sh   # 빌드 + 배포
```

`deploy.sh`는 Vercel 때와 같은 모양으로 만든다: 홈이 `/`, 투어가 `/tour.html`, `/scenes/*`는 `media.pochak.kr`로 307.

## 업로드 API

`worker.js`는 Vercel 함수 `web-api/api/web/[action].js`를 그대로 옮긴 것이다(`/api/web/config|upload|sign|complete|finish`). 브라우저는 서명된 주소로 R2에 바로 올리고, Worker는 비밀번호 확인과 서명, `inbox/<id>/manifest.json` 쓰기만 한다.

비밀값은 `npx wrangler@4 secret put <이름>`으로 넣는다(저장소에 넣지 않음):

- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: `hanok360` 버킷 전용 토큰(이름 `pochak-kr-upload-api`)
- `UPLOAD_PASSWORD`: 업로드 화면 비밀번호
- (선택) `RUNPOD_API_KEY`, `RUNNER_BUNDLE`, `RUNNER_VOCAB`, `RUNNER_PUBLIC_KEY`, `BUDGET_USD`: 넣으면 업로드마다 클라우드 GPU 서버를 켠다(돈이 든다). 지금은 넣지 않았다.

## 주의

2026-11-18 이전 실사이트(3dgstour.com)는 이 저장소 master보다 새 코드로 빌드돼 있었다. 그래서 첫 이전은 실사이트 파일을 그대로 옮겨 배포했다. 최신 viewer 코드가 master에 들어오기 전에 `deploy.sh`를 돌리면 사이트가 옛 판으로 돌아간다.
