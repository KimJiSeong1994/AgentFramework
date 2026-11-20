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

## 경계

- 프롬프트는 루프백 밖으로 나가지 않는다(엔드포인트 검증). 도구 호출을 요청하지 않으며, 서버가 `tool_calls`를 보내면 네이티브 도구 활동으로 거부한다.
- 응답 길이·기한·취소·사용량(`prompt_tokens`·`completion_tokens`·캐시 토큰)·실패 등급은 CLI 전송과 같은 계약을 따른다. 서버의 오류 문구는 저장하지 않는다.
- SGLang MLX 백엔드는 2026년 기준 초기 단계다(문서상 제약 미기재, 서드파티 보고로는 탐욕 샘플링·접두 캐시 미지원). 품질·속도는 `/usage`와 실제 사용으로 확인한다.
