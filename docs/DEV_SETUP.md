# 개발 환경 빠른 시작

## 1. 뷰어만 돌리기 (키 필요 없음)
```bash
cd viewer
npm install
cp .env.example .env.local
npm run dev
```
- 월하정 3DGS: `http://localhost:5173/?scene=wolhajeong360-hq&from=cloud`
- 사랑방: `?scene=wolhajeong360-sarang&from=cloud`
- 장면 파일은 git에 없음(용량). `https://media.3dgstour.com/scenes/<장면>/` 에 공개로 있음
  - `tour.json`, `scene.spz`(데스크톱), `scene.mobile.spz`(폰), `lod/`(폰 스트리밍)
  - 로컬에 두고 싶으면 위 파일들을 받아 `scenes/<장면>/` 에 넣고 `?from=cloud` 없이 열기
- 장면 목록: `https://media.3dgstour.com/jobs/index.json`

## 2. 업로드·클라우드 학습 API
`web-api/.env.example` 참고. 비밀 값(R2 키·업로드 비번·RunPod 키)은 대표에게 따로 받는다.
R2 키는 hanok360 버킷 전용이라 다른 버킷엔 접근 안 됨.

## 3. 학습 파이프라인 (python)
`pipeline/` 참고. 클라우드 학습은 `secrets/runpod.txt`(RunPod 키 한 줄), `secrets/r2.txt`·`secrets/r2-web.txt` 필요.
한 달 한도는 `secrets/cloud_budget.txt`(기본 $30). 비용 큰 작업(>$20)은 대표에게 먼저 묻기.
