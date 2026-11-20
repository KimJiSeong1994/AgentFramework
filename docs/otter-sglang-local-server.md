# 로컬 서빙 엔진: Ollama → SGLang (2026-11-20)

otter의 `local` 엔진은 기본으로 Ollama CLI(`ollama run`)를 쓴다. `local_model.server: "sglang"`이면 같은 엔진이 루프백의 SGLang 서버(OpenAI 호환 `/v1/chat/completions`, 스트리밍)로 추론한다. Ollama 경로는 그대로 남아 있어 설정 한 줄로 되돌릴 수 있다.

## 구성

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
