# otter 소개 모션 영상 (v2)

`datamarket.bigvalue.ai` 소개 영상 스타일(짧은 무음 루프, 다크 네이비 배경, 흰 헤드라인 + 포인트 컬러, UI 목업 슬라이드 인)로 만든 otter 소개 영상.
출력물은 `../otter-intro-motion.mp4` (1920×1080, 30fps, 36초, 무음, 루프 재생 전제).

## 구성

| 시간 | 장면 | 카피 |
|---|---|---|
| 0–5.8s | 훅: 로고 + 입력창 타이핑 | 실행할수록 **쌓이는** 코딩 에이전트 |
| 5.8–13.2s | ① 대화 → 실행 이력 → knowledge/ 위키 → 다음 대화로 루프 | 대화는 사라져도 **실행 이력**은 다음 작업의 컨텍스트가 돼요 |
| 13.2–19.6s | ② Ollama·Codex·Claude 합류 + `/model combo astra-fable` 역할표 | 어떤 엔진을 써도 기록은 **하나**로 쌓여요 |
| 19.6–25.6s | ③ 의도 라우팅 칩 + `Skills used:` 태그 | 알아서 돕되, **멋대로 하지 않아요** |
| 25.6–31s | 수정 승인 diff + `/plan → /approve → 작업 트리` + Apply/Keep/Discard | 모든 실행은 **사람이 승인**해요 |
| 31–36s | 아웃트로: 로고, 설치 한 줄, GitHub · MIT | |

화면 속 문구(라우팅 선택지, `Skills used:`, Apply/Keep/Discard, 콤보 프리셋)는 `framework/src` 실제 문자열 기준. 과장 표현 금지 목록은 `../highlights.md` 8절 참고.

## 렌더

```sh
cd artifacts/otter-intro-video/motion
python3 render.py preview /tmp/prev 3.8 9.8 14.6   # 특정 초의 스틸 (QA)
python3 render.py video ../otter-intro-motion.mp4 30  # 전체 렌더 (약 4~5분)
```

- `index.html`: 모든 모션이 일시정지된 Web Animations로 정의되고 `window.seek(t)`로 임의 시각을 그린다. 브라우저에서 열어 콘솔에서 `seek(12)` 식으로 확인 가능.
- `render.py`: Playwright(Chromium)로 프레임을 찍어 ffmpeg 파이프로 바로 인코딩(libx264 crf 17, yuv420p).
- 폰트: Pretendard Variable(jsdelivr) + JetBrains Mono(Google Fonts). 오프라인이면 Apple SD Gothic Neo / Menlo로 대체된다.
- 장면 타이밍은 `index.html` 하단 스크립트의 `t0`, `t1` 값만 바꾸면 된다. `window.DURATION`이 총 길이.
