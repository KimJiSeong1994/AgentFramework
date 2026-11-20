# 로컬 서빙 엔진: Ollama → SGLang → MLX 서버 (2026-11-20)

otter의 `local` 엔진은 기본으로 Ollama CLI(`ollama run`)를 쓴다. `local_model.server: "sglang"`이면 같은 엔진이 루프백의 SGLang 서버(OpenAI 호환 `/v1/chat/completions`, 스트리밍)로 추론한다. Ollama 경로는 그대로 남아 있어 설정 한 줄로 되돌릴 수 있다.

## 현재 구성: otter MLX 서버 (`local_model.server: "mlx"`)

SGLang의 Metal 백엔드는 Qwen3.8 같은 하이브리드 모델의 접두 캐시를 지원하지 않아, otter가 매 호출 보내는 약 1.7k의 동일한 앞부분을 매번 다시 처리했다(호출당 약 15초). `scripts/mlx-server.py`는 `mlx_lm` 위의 얇은 OpenAI 호환 서버로, 256토큰 절대 위치 경계마다 모델 상태를 저장해 두고 가장 긴 일치 지점부터 이어 계산한다.

- **답은 캐시에 의존하지 않는다**: 프리필을 항상 절대 위치 기준 256토큰 단위로 끊고 탐욕(argmax) 디코딩을 하므로, 저장 상태에서 이어 계산해도 처음부터 계산한 것과 같은 연산을 한다. `--no-prefix-cache`로 같은 답을 캐시 없이 낼 수 있다.
- **검증**: ① otter 실제 채팅 프롬프트에 넣은 고정 과제 12개에서 SGLang·MLX(캐시 없음)·MLX(캐시)의 답 36개가 글자까지 동일(성공 10/12, 실패 2개도 동일). ② otter 실사용 세션의 실제 요청 7건을 캐시 서버에서 기록해 캐시 없는 서버로 재전송, 7/7 동일. ③ SGLang→MLX 엔진 교체로 긴 대화에서 띄어쓰기 수준의 표현 차이가 1건 관찰됨(엔진 수치 차이; 캐시와 무관).
- **속도**: 고정 과제 223초 → 56초(두 번째부터 과제당 17~18초 → 3~4초). otter 세션(읽기·수정·테스트) 181초 → 55초.
- **한계**: 한 번에 요청 하나(1인 사용), 저장 상태 메모리 상한 8GB(`MLX_PREFIX_CACHE_GB`), 탐욕 디코딩 고정.
- **도구 호출(OpenAI `tools`, 2026-11-20 추가)**: 도구 목록은 모델 자체 채팅 템플릿으로 넣고, 모델이 내는 `<tool_call><function=…><parameter=…>` 출력을 `tool_calls`(`finish_reason: "tool_calls"`)로 돌려준다. 인자 값은 도구 JSON 스키마의 타입으로 맞춘다(문자열은 그대로). 이전 턴의 `tool_calls`(인자 JSON 문자열)와 `tool` 결과도 템플릿으로 되먹인다. `tool_choice: "none"`은 도구를 숨기고, `"required"`나 특정 함수 지정은 강제하지 않는다(제약 디코딩 없음). 형식이 깨진 호출은 버리지 않고 본문 텍스트로 돌려준다. 도구가 없는 요청(otter)은 경로가 그대로라 답이 바뀌지 않는다. 확인 결과: 기록해 둔 otter 실제 요청 7건을 다시 보내 7/7 동일, OpenCode `opencode run`이 Read→Edit 도구로 버그 수정 완료(118초).
- **운영**: `scripts/mlx-server.sh start|stop|status|logs|install-agent` (launchd `com.otter.mlx`, 127.0.0.1:30000). 되돌리기: `"server": "sglang"`과 `scripts/sglang-server.sh install-agent`(SGLang 설치는 남아 있다).

## (이전) SGLang 구성

| 항목 | 값 |
|---|---|
| 서버 | SGLang (소스 설치, MLX 백엔드 `SGLANG_USE_MLX=1`) — `~/.local/share/sglang/{sglang,venv}` |
| 모델 | `mlx-community/Qwen3.8-27B-4bit` (Apache-2.0, MLX 4비트) |
| 서빙 이름 | `qwen3.8-27b` |
| 주소 | `http://127.0.0.1:30000` (루프백만; otter는 다른 호스트를 거부) |
| 기동 | `scripts/sglang-server.sh start` 또는 로그인 시 자동(`install-agent`, `~/Library/LaunchAgents/com.otter.sglang.plist`) |
| 로그 | `~/.local/state/otter/sglang.log` |

## Ollama 정리 (2026-11-20)

Ollama 모델은 모두 지웠고(Qwen3.6·gemma4 26B/31B·Qwen3-VL·Qwen2.5-VL·Llama 3.2·gpt-oss) Ollama 앱·CLI·`~/.ollama`·launchd 항목(`com.ollama.ollama`, `com.local-coding-agent.ollama-env`)과 `OLLAMA_*` launchd 환경 변수도 제거했다. 로컬 서빙은 SGLang 하나이며 모델은 Qwen3.8-27B뿐이다(`scripts/sglang-models.tsv`). OpenCode는 `sglang` 프로바이더만 남겼고 `model`·`small_model` 모두 `sglang/qwen3.8-27b`다. doctor D07은 Ollama가 없으면 건너뛰고, D08은 `sglang/*` 모델이 서버의 `/v1/models`에 있는지 본다.

다른 모델을 쓰려면 MLX 빌드를 레지스트리에 한 줄 추가하고 `scripts/sglang-server.sh switch <이름>`을 실행한다(서버 하나에 모델 하나, 다른 포트는 `SGLANG_PORT`).

## 설치 (재현용)

```sh
D=~/.local/share/sglang; mkdir -p $D && cd $D
git clone --depth 1 https://github.com/sgl-project/sglang.git && cd sglang
uv venv -p 3.12 $D/venv && source $D/venv/bin/activate
rm -f python/pyproject.toml && mv python/pyproject_other.toml python/pyproject.toml
SGLANG_BUILD_RUST_EXTS=none uv pip install -e "python[all_mps]"   # Rust 확장 없이(MLX 경로에 불필요)
hf download mlx-community/Qwen3.8-27B-4bit
scripts/sglang-server.sh install-agent
```

## otter 설정 (`~/.config/otter/otter.jsonc`)

```jsonc
"local_model": { "server": "sglang", "endpoint": "http://127.0.0.1:30000" }
```

- `otter chat --engine local --model qwen3.8-27b`, 또는 채팅에서 `/model local qwen3.8-27b`. 모델 목록은 서버의 `/v1/models`에서 온다.
- `/local status`는 서버 주소와 서빙 중인 모델을 보여 준다. `keepalive`·`unload`는 Ollama 전용이며 SGLang은 서버가 떠 있는 동안 모델을 유지한다.
- `/local think on`은 Qwen3 계열 채팅 템플릿의 `enable_thinking`으로 전달된다. 추론 블록(`reasoning_content`)은 버리고 답만 받는다.
- 기본 `model_api` 대상 `local`도 SGLang의 OpenAI 엔드포인트를 따른다.
- 되돌리기: `"server": "ollama"`(또는 키 삭제).

## 검증 (2026-11-20, M4 Pro 64GB)

| 항목 | 결과 |
|---|---|
| 서버 기동 | 약 10초(가중치는 MLX가 지연 로딩), KV 풀 65,536토큰 |
| 단순 응답(사고 off) | 약 1.1초, 출력 10토큰 |
| 단순 응답(사고 on) | 약 4.9초, 추론 블록은 `reasoning_content`로 분리돼 답에 섞이지 않음 |
| otter 읽기 전용 턴(`read` 1회 + 답) | 약 37초: 호출당 입력 약 1,900토큰에 17~19초(프리필이 병목) |

Qwen3.8은 선형 어텐션 48층 + 전체 어텐션 16층의 하이브리드(`Qwen3_5ForConditionalGeneration`)다. 현재 SGLang `main`의 Metal 백엔드에서 띄우려면 `--mamba-radix-cache-strategy no_buffer --disable-overlap-schedule --disable-radix-cache`가 필요하며, `scripts/sglang-server.sh`가 모델 설정을 보고 자동으로 붙인다. 접두 캐시가 꺼져 매 호출이 전체 프롬프트를 다시 프리필하므로 긴 대화일수록 느려진다. SGLang이 MLX 하이브리드 접두 캐시를 고치면(`MlxAuxiliaryStateComponent.host_only_checkpoint` 오류) `--disable-radix-cache`를 빼는 것이 첫 개선 지점이다.

## 경계

- 프롬프트는 루프백 밖으로 나가지 않는다(엔드포인트 검증). 도구 호출을 요청하지 않으며, 서버가 `tool_calls`를 보내면 네이티브 도구 활동으로 거부한다.
- 응답 길이·기한·취소·사용량(`prompt_tokens`·`completion_tokens`·캐시 토큰)·실패 등급은 CLI 전송과 같은 계약을 따른다. 서버의 오류 문구는 저장하지 않는다.
- SGLang MLX 백엔드는 2026년 기준 초기 단계다(문서상 제약 미기재, 서드파티 보고로는 탐욕 샘플링·접두 캐시 미지원). 품질·속도는 `/usage`와 실제 사용으로 확인한다.
