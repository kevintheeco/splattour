# 화질 비교 기록

같은 데이터(Deep Blending *Playroom*, 1264×832 사진 218장 → COLMAP 카메라 복원 → 잘못 등록된 카메라 13대 제거 → 200장)로 학습 방식만 바꿔 비교한다. 시험용 사진은 **8장마다 1장**(이름순, 25장)이며 학습에 쓰지 않는다.

## 1. 결과

| 조건 | 학습 | 가우시안 수 | 시간·비용 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | 웹 파일 |
|---|---|---|---|---|---|---|---|
| A. 노트북 | Brush 0.3, 30k, 최대 1024px, 상한 150만 | 102만 | 2시간 · 0원 | 26.04 | 0.863 | – | 25.8 MB |
| **B. 클라우드** | gsplat 1.5.3 MCMC, 30k, 원본 해상도, 상한 400만, anti-aliased | 400만 | 15분 학습(+설치 14분) · **$0.34** | **27.90** | **0.893** | **0.207** | 105.6 MB (휴대폰용 SH1 약 73 MB) |
| **D. 클라우드 200만** (현재 기본값) | B와 같고 상한 200만 | 200만 | 17분(설치 3분) · **$0.22** | **27.98** | 0.891 | 0.212 | **51.9 MB** (휴대폰용 36.9 MB) |
| C. B + bilateral grid | 위와 같음 + 사진별 밝기 보정 | 400만 | $0.35 | 20.53 | 0.850 | 0.258 | 103.5 MB |

- A·B·C의 PSNR/SSIM은 각 학습 도구가 **같은 시험 사진**으로 잰 값이다.
- 뷰어에서 정확한 시험 시점으로 다시 찍어 잰 값(`eval_views` + `eval-render.mjs`): A **24.84 dB / 0.857**, C **20.56 dB / 0.824** (B는 다음에 잴 예정).
  뷰어 렌더는 SPZ 압축과 웹 렌더러(Spark)를 거치므로 학습 도구 값보다 1~1.5 dB 낮게 나온다. 같은 조건끼리 비교해야 한다.

## 2. 관찰

0. **가우시안 200만 개(D)면 충분하다.** 400만 개(B)와 PSNR·SSIM이 같은데 웹 파일은 절반이다(로딩·휴대폰 메모리 절반). → 클라우드 학습 기본 상한을 200만으로 바꿨다.

1. **B는 A보다 선명하고 위치도 더 정확하다.** 특징점 기준 사진과의 어긋남 중앙값: B 계열 1.08 px, A 1.96 px (`docs/checks/compare-playroom.png`, 유모차 바퀴·알파벳 퍼즐 테두리).
2. **bilateral grid(C)는 역효과였다.** 사진마다 다른 밝기와 비네팅을 격자가 흡수하면서 3D 모델의 *기본 색*이 사진과 어긋났다. 오차 지도를 보면 사물 경계가 아니라 **화면 전체의 부드러운 밝기 얼룩**이다. 전역 색 보정 후에도 A보다 4 dB 낮았다. → 파이프라인 기본값에서 뺐다. 촬영 단계의 **노출 고정**(`docs/CAPTURE_GUIDE.md` 3장)으로 대신한다.
3. **입력 해상도가 상한이다.** 원본 사진이 100만 화소라 확대하면 B도 흐리다. 실사 수준의 확대는 1,200만~2,400만 화소 촬영이 필요하다(주희 촬영본).

## 3. 학습 파이프라인에서 고친 것 (재현성)

| 문제 | 증상 | 해결 |
|---|---|---|
| GLOMAP이 카메라 일부를 수십 km 밖에 등록 | gsplat scene scale 폭발 → 가우시안 전멸 → MCMC 재배치 CUDA 오류 | SfM 직후 `clean_model`: 이웃 카메라와 동떨어진 카메라를 COLMAP `image_deleter`로 삭제 |
| 먼 GPU 서버로의 ssh 한 줄 업로드 | 0.1~0.3 MB/s | 8줄 병렬 tar\|ssh → 5.9~9.6 MB/s |
| gsplat 예제 의존성 빌드 | fused-ssim이 torch를 못 찾음 | `pip --no-build-isolation` |
| 진행 감시 `pgrep -f` | 자기 자신에 걸려 죽은 학습을 "실행 중"으로 판단 | `pgrep -f '[s]imple_trainer.py'` |

## 4. 다시 재는 법

```bash
# 시험 시점 뽑기 → 뷰어에서 렌더 → 점수 → 비교 이미지
python -m splattour.eval_views views <scene> data/jobs/playroom/sfm/dense/sparse/0 --out views.json
node viewer/scripts/eval-render.mjs <scene> views.json renders/<scene>
python -m splattour.compare_sheet data/jobs/playroom/sfm/dense/images out.png A=renders/a B=renders/b
```
