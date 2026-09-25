# 화질 비교 기록

같은 데이터(Deep Blending *Playroom*, 1264×832 사진 218장 → COLMAP 카메라 복원 → 잘못 등록된 카메라 13대 제거 → 200장)로 학습 방식만 바꿔 비교한다. 시험용 사진은 **8장마다 1장**(이름순, 25장)이며 학습에 쓰지 않는다.

## 1. 결과

| 조건 | 학습 | 가우시안 수 | 시간·비용 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | 웹 파일 |
|---|---|---|---|---|---|---|---|
| A. 노트북 | Brush 0.3, 30k, 최대 1024px, 상한 150만 | 102만 | 2시간 · 0원 | 26.04 | 0.863 | – | 25.8 MB |
| **B. 클라우드** | gsplat 1.5.3 MCMC, 30k, 원본 해상도, 상한 400만, anti-aliased | 400만 | 15분 학습(+설치 14분) · **$0.34** | **27.90** | **0.893** | **0.207** | 105.6 MB (휴대폰용 SH1 약 73 MB) |
| **D. 클라우드 200만** (현재 기본값) | B와 같고 상한 200만 | 200만 | 17분(설치 3분) · **$0.22** | **27.98** | 0.891 | 0.212 | **51.9 MB** (휴대폰용 36.9 MB) |
| E. 클라우드 빠른 확인 | D와 같고 15k 단계 | 200만 | **8분 20초(설치 25초, 부품 캐시)** · **$0.12** | 27.81 | 0.890 | 0.235 | 48.4 MB |
| C. B + bilateral grid | 위와 같음 + 사진별 밝기 보정 | 400만 | $0.35 | 20.53 | 0.850 | 0.258 | 103.5 MB |

- A·B·C의 PSNR/SSIM은 각 학습 도구가 **같은 시험 사진**으로 잰 값이다.
- 뷰어에서 정확한 시험 시점으로 다시 찍어 잰 값(`eval_views` + `eval-render.mjs`): A **24.84 dB / 0.857**, C **20.56 dB / 0.824** (B는 다음에 잴 예정).
  뷰어 렌더는 SPZ 압축과 웹 렌더러(Spark)를 거치므로 학습 도구 값보다 1~1.5 dB 낮게 나온다. 같은 조건끼리 비교해야 한다.

## 1-1. 기준선 대조: Deep Blending *Dr Johnson* (263장, 1332×876)

| 방법 | PSNR ↑ | SSIM ↑ | LPIPS ↓ | 비고 |
|---|---|---|---|---|
| 3DGS 원 논문 (Kerbl et al., 2023) | ≈29.1 | ≈0.90 | ≈0.24 | 논문 보고치 (Deep Blending 평균 29.41 / 0.903 / 0.243) |
| **우리 파이프라인 (클라우드 gsplat MCMC 200만, 30k)** | **29.39** | **0.910** | **0.185** | 16분, $0.20, 웹 44 MB |

→ 우리 파이프라인이 **원 논문 3DGS와 같거나 조금 나은 수준**이다. 장면: `scenes/drjohnson-hq`.

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

## 5. 2026-09-24 밤: 웹 게시용 Dr Johnson 확정 (뷰어에서 직접 잰 값)

같은 33개 시점(COLMAP 이름순 8장마다 1장)을 **실제 웹 뷰어**(SPZ 압축 + Spark)로 찍어 원본 사진과 비교했다. `data/eval/drj/`.

| 모델 | 학습에 쓴 사진 | 점 개수 · 웹 파일 | 이 33장에서 PSNR / SSIM | 학습에 안 쓴 33장이 섞였나 |
|---|---|---|---|---|
| 이전 게시본 `drjohnson-hq` (gsplat MCMC) | 230장 (33장 제외) | 200만 · 44 MB | 28.13 / 0.883 | 아니오 (정직한 신규 시점 값) |
| 원 논문 공개 모델 (INRIA 3DGS) | 263장 전부 | 318만 · 70 MB | 30.89 / 0.911 | 예 (학습 시점 30.68과 차이 없음 → 시험 사진을 봤음) |
| **새 게시본 `drjohnson` (gsplat MCMC, 전체 사진)** | 263장 전부 | 200만 · 44 MB | **30.41 / 0.909** | 예 |

- 원 논문 공개 모델의 30.89는 시험 사진까지 학습한 값이라 `drjohnson-hq`의 28.13과 직접 비교할 수 없다. 같은 조건(전체 사진)으로 다시 학습한 우리 모델은 0.5 dB 차이까지 따라갔고, 가장 나쁜 시점은 오히려 낫다(25.38 vs 24.31).
- 남은 차이는 샹들리에처럼 **가는 물체**에서 보인다(`data/eval/drj/compare-full.png`). 점 개수(318만 vs 200만) 차이로 보인다. 400만 점은 웹 한도(Vercel 100MB) 때문에 싣지 못한다.
- 게시본은 전체 사진으로 학습하고, 논문에 적을 화질 수치는 사진을 빼고 학습한 `drjohnson-hq` 값(학습 도구 29.39 dB, 뷰어 28.13 dB)을 쓴다. `python -m splattour.retrain <job> <scene> <title> 2000000 30000 0` (마지막 0 = 전체 사진).
- 비행 중 화면(촬영하지 않은 위치) 17구간: 떠다니는 얼룩·구멍 없음(`docs/checks/drjohnson/*-flight.png`). 노트북 34 fps.

## 6. 2026-09-25: 우리 SfM(사진 위치 맞추기) 검증 — 웹 업로드 경로의 화질

웹으로 올린 사진은 데이터셋이 준 카메라 위치가 없으니 우리 파이프라인이 직접 SfM을 한다. 처음 실험에서 150장 넘는 사진을 파일 순서로만 비교(sequential)해 카메라가 뒤섞였다(집 크기 대비 위치 오차 중앙값 45%, PSNR 10.8). 사진 묶음은 유사 장면 매칭(vocab tree)으로 바꿨다.

| SfM | 등록 | 기준 포즈 대비 위치 오차(중앙값 / 95%) | 30k 학습 PSNR / SSIM / LPIPS (test_every 8) |
|---|---|---|---|
| 데이터셋 제공 COLMAP | 263 | 기준 | 29.39 / 0.910 / 0.185 |
| 우리 SfM, sequential (옛 방식) | 232 | 45% / 86% | 10.8 (15k) — 실패 |
| **우리 SfM, vocab tree (현재)** | 258/259 | **0.13% / 0.27%** | **29.91 / 0.909 / 0.179** |

→ 웹 업로드 경로가 데이터셋 기준과 **같거나 조금 낫다**(시험 사진 집합이 258장 기준이라 완전히 같은 조건은 아님). 노트북 CPU 매칭 24분 → 클라우드 서버에서는 pycolmap-cuda12(GPU)로 수행.

## 7. 2026-09-25: 큰 집(Zip-NeRF Alameda, 1734장)에서 배운 것

| 실험 | 설정 | 학습 도구 PSNR | 뷰어 PSNR(같은 10시점) | 메모 |
|---|---|---|---|---|
| 첫 시도 | MCMC 400만, 40k, reg 0.01 | 13.2 | – | 점 73%가 매 라운드 죽고 재배치 → 붕괴 |
| E3 | 400만, 원본 | OOM | – | 거대 가우시안으로 GPU 메모리 초과 |
| G2 | 300만 + 사진별 외관(app_opt), reg 0.01 | 10.9 | – | 외관 보정도 붕괴는 못 막음 |
| **R2** | **200만, 30k, reg 0.001** | **21.3** | **17.97** | 붕괴 해결(재배치 ~5%) |
| R1/R3 | 절반 크기, reg 0.001/0.0005 | 22.1/22.2 | 15.1(R1) | 절반 크기는 뷰어에서 더 흐림 |
| final | 300만, 60k, reg 0.001 | 15.3 | – | 점이 많으면 다시 과반이 죽음 |
| R4 | R2 + app_opt | 19.9 | 18.16 | 학습은 잘 맞지만 시점 의존 색 손실 |
| R5 | default(ADC) 전략, 48GB | 18.9 | 17.67 | 점 100만에서 성장 멈춤 |

- 원인: gsplat MCMC의 opacity/scale 정규화(0.01)는 모든 가우시안에 매 스텝 걸리는데, 사진이 많고 공간이 넓으면 각 가우시안이 보이는 사진이 적어 정규화가 이긴다. → 사진 수에 반비례해 자동 조정(`cloud.mcmc_reg_flags`, 0.01·300/n).
- 한계: 이 장면은 모든 설정에서 뷰어 기준 약 18 dB, 벽·가까운 물체가 번진다. 3DGS 계열 논문의 Zip-NeRF 보고치(대략 20~22 dB, 절반 해상도)와 비슷한 수준. 시연용 "실사급"은 촬영 단계(노출 고정·가까운 거리 반복 촬영)가 결정한다.
- 공개 목록에는 올리지 않음. 링크로만: `/tour.html?scene=alameda&from=cloud`.

## 8. 2026-09-25: 월하정 (주희 촬영 영상 872프레임, 1920×960) — 장면 `wolhajeong`

촬영본은 앞마당을 여러 바퀴 돌며 대문 통로(어두움)를 9번 드나드는 영상이다. 실내(사랑방·안채·부엌)는 이 영상에 없다(창문 너머로만 보임).

| 단계 | 설정 | 결과 |
|---|---|---|
| SfM | SIFT(GPU) 1920px, 어두운 프레임은 SfM 사본만 감마+CLAHE, 한 카메라 OPENCV, sequential(overlap 30, quadratic) + loop detection(2프레임마다, 60장), GLOMAP global mapper | **모델 1개, 872/872 등록, 재투영 0.654px**, 점 29만. 초점 532px → 가로 화각 122°, 왜곡 계수 ≈ 0(직선 투영 영상이라 fisheye 불필요) |
| 정리 | 앞뒤 프레임 궤적과 0.6(SfM 단위) 넘게 어긋난 카메라 + 대문 앞 686~704 제거 | 784장 사용. 어긋난 88장은 전부 어두운 대문 통로(590번은 72 km 밖) |
| 학습 A (게시) | gsplat MCMC 500만, 60k(steps_scaler 2), 원본 해상도, reg 0.0038, 보정 없음 | **PSNR 29.67 / SSIM 0.896 / LPIPS 0.110** (8장마다 1장 시험, 98장), H100 33분 |
| 학습 B | A + bilateral grid(사진별 노출 보정) | 26.85 / 0.832 / 0.123 (노출 맞춤 후 28.78) — A보다 나쁨 |

- 참고: 같은 방식의 Dr Johnson 점수용 모델 29.39 / 0.910 / 0.185. 월하정이 PSNR·LPIPS는 더 좋고 SSIM은 조금 낮다(어두운 통로의 압축 노이즈).
- 첫 학습은 72 km 밖 카메라가 섞인 채 시작해 손실 0.42에서 멈춤 → 카메라 정리 후 0.05. **SfM 뒤 궤적 연속성 검사는 필수.**
- 웹: scene.spz 131 MB(500만), 휴대폰 scene.mobile.spz 28 MB(150만, SH1), 휴대폰 LoD 93조각 308 MB(R2 스트리밍). 노트북(Intel Arc) 27 fps.
- 비용: RunPod 충전분에서 $14.77(L40S SfM 2.1시간 + H100 학습 2대 + 대기 중 버린 H100 2대 37분). 그 전의 첫 시도(H100 SfM 3대, 자동 경로 4090)는 잔액 소진으로 모두 강제 종료.

### 나중에 실내 촬영을 같은 좌표계에 붙이는 법
R2 `cloud/max/20260925-f0b277376aab/sfm-A/sfm_keep.tgz`(노트북 `data/jobs/wolhajeong/sfmA_sfm_keep.tgz`)에 SfM 데이터베이스(`database.db`, 872장 특징·매칭)와 왜곡 모델(`sparse_distorted`, 1920×960 SfM 사본 이름 `.jpg`)이 있다.
1. 새 프레임도 같은 방식(prep.py: 어두우면 감마+CLAHE, JPEG)으로 SfM 사본을 만들어 같은 폴더에 넣는다.
2. `feature_extractor`(같은 DB, 새 영상이 다른 카메라면 새 camera) → 새 프레임끼리 sequential+loop, 새↔옛 프레임은 vocab tree 매칭.
3. `image_registrator`(또는 pycolmap incremental_mapping(input_path=sparse_distorted))로 기존 모델에 등록 → `bundle_adjuster`. 기존 카메라는 고정하면 world 좌표가 그대로 유지된다.
4. 그 뒤 runner/bench 절차(make_dataset → 궤적 검사 → 학습)를 같은 설정으로. tour.json의 splatTransform은 그대로 써야 capture_path.json·360 핫스팟과 맞는다.

## 9. 2026-09-26: 월하정 AI 후보정본 (`wolhajeong-ai`, 링크 전용)

원인 가설: 입력 해상도가 낮다(1916×957, 가로 122° → 약 16 px/도, H.264 압축, 어두운 통로). 그래서 입력 프레임만 AI로 2배 복원하고, 나머지(SfM 포즈, 784장, 학습 설정)는 게시본과 똑같이 두었다.

- **파일럿(노트북 CPU, 10개 크롭)**: Real-ESRGAN x2plus / SPAN 2x multijpg / SwinIR-M x2 GAN / realesr-general-x4v3(dn 0.5) / 4x-UltraSharp / 4xNomos8kSC. UltraSharp·Nomos는 콘크리트에 가짜 물결 무늬와 살창 겹선, SwinIR은 가장자리 긁힘, SPAN은 변화 거의 없음 → **x2plus 채택**. 다만 x2plus는 자갈 같은 면을 어둡게 만들어(평균 79.5→73.7) **저주파 톤 보정**(원본과 SR을 1배로 줄인 것의 차이를 σ 3px로 흐려 다시 더함)을 붙였다. 인접 프레임 두 쌍에서 결과가 일관됨. `docs/checks/wolhajeong-ai/pilot/`
- **클라우드(RTX 6000 Ada 1대, $0.84/h, 1.94시간, 약 $1.63)**: `runner/aisr/launch.py` → `job.sh`가 혼자 끝까지 돌고 스스로 삭제. 784장 SR 7분, 학습 1시간 43분(3832×1914, 5M, 60k, antialiased, reg 0.00344, 게시본과 같은 명령), 평가·업로드. 결과 R2 `cloud/max/20260925-f0b277376aab/ai-x2/`(scene.ply, 모든 SR 프레임 sr_images.tar, 평가 이미지).
- 카메라는 SfM을 다시 하지 않고 PINHOLE 내부값만 ×2(fx, fy, cx, cy, 폭, 높이). SR 프레임을 1배로 줄이면 원본과 평균 34.5 dB(최저 27.6).

| 같은 98장 시험 사진, **원본 프레임** 대비 (1916×957 렌더) | PSNR | SSIM | LPIPS |
|---|---|---|---|
| 게시본 `wolhajeong` (같은 평가 코드로 재측정, 게시 기록 29.67/0.896/0.110과 일치) | **29.66** | **0.896** | **0.110** |
| AI 후보정본 `wolhajeong-ai` | 28.96 | 0.887 | 0.133 |
| (참고) AI본을 자기 입력인 SR 프레임 2배 해상도로 잰 학습 도구 값 | 27.14 | 0.852 | 0.190 |

- 숫자는 원본 대비 모두 조금 나쁘다. 눈으로 보면 **선(살창, 서까래, 창틀, 기와 테두리)은 확실히 또렷**해지고(특히 2배 확대), **평평한 면의 잔 질감(회벽의 울퉁불퉁함, 자갈)은 매끈해진다**. SR 모델이 압축 노이즈와 함께 실제 미세 질감도 지운 것이 원본 대비 LPIPS가 나빠진 주된 이유로 보인다. 소나무 잎은 둘 다 흐리다(바람으로 움직여 다시점이 안 맞음).
- 비교 이미지: `docs/checks/wolhajeong-ai/compare-n*.jpg`(투어 시점 11곳), `compare-off*.jpg`(촬영 경로 밖 5곳), 위=실제 크기, 아래=가운데 2배 확대, 왼쪽=게시본, 오른쪽=AI본. `heldout-*.jpg`는 학습에 안 쓴 원본 프레임과 나란히.
- 웹: scene.spz 133 MB, 휴대폰 28 MB(150만, SH1), LoD 94조각 312 MB. `scenes/index.json`에는 넣지 않았다. 링크로만: `/tour.html?scene=wolhajeong-ai&from=cloud`. 사진은 게시본 것을 R2에서 복사.
- 재현: `python runner/aisr/launch.py 6` → R2 `ai-x2/status.json`이 done이 될 때까지 대기 → scene.ply 받기 → `export_web` + 휴대폰 spz 150만 → `python -m splattour.lod build wolhajeong-ai` → `node viewer/scripts/bake-lod-aux.mjs wolhajeong-ai` → `python runner/aisr/publish.py wolhajeong-ai wolhajeong`.
