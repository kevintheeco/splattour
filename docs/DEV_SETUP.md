# 개발 환경 빠른 시작

## 1. 뷰어만 돌리기 (키 필요 없음)
```bash
cd viewer
npm install
cp .env.example .env.local
npm run dev
```
- 월하정 3DGS: `http://localhost:5190/?scene=wolhajeong360-hq&from=cloud`
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

## 4. push 하면 자동 배포 (자기 Vercel 계정)
Vercel 무료판은 비공개 저장소에서 계정 주인의 커밋만 배포한다. 그래서 각자 자기 Vercel 계정에 이 저장소를 가져온다.
1. vercel.com 에 GitHub로 로그인 → Add New → Project → `kevintheeco/splattour` Import
2. 설정은 건드리지 말고 Deploy (빌드 방법은 루트 `vercel.json` 에 있음)
3. 이후 master 에 push 하면 자기 주소(`*.vercel.app`)에 자동 배포, 다른 브랜치는 미리보기 주소

- git 빌드는 뷰어 화면만 올린다. 장면은 `media.3dgstour.com` 에서 읽고, 업로드·실험 기록 API는 없다(키 필요).
- 실사이트 3dgstour.com 은 여기에 해당 없음: `vercel.json` 의 ignoreCommand 가 그 프로젝트의 git 배포를 건너뛴다.
  실사이트 배포는 지금처럼 `bash web-api/build.sh` → `web-deploy/` 에서 수동.
