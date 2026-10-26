#!/usr/bin/env python3
"""Bounded JSON bridge to the pinned, local-only Graphify AST and query APIs."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import defaultdict, deque
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_QUERY_BYTES = 2_048
MAX_QUERY_TEXT_CHARS = 1_000_000
MAX_SOURCE_FILES = 20_000
MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_GRAPH_BYTES = 64 * 1024 * 1024
MAX_GRAPH_NODES = 250_000
MAX_GRAPH_EDGES = 750_000
MAX_QUERY_NODES = 256
MAX_QUERY_EDGES = 512
MAX_RUNTIME_HIT_BYTES = 8 * 1024
MAX_SYMBOL_CHARS = 1_024
MAX_NODE_ID_CHARS = 8_192
MAX_PATH_CHARS = 4_096
MAX_LOCATION_CHARS = 128
ALLOWED_SUFFIXES = frozenset({".py", ".ts", ".tsx"})
_LINE_NUMBER = re.compile(r"^L(\d+)")


class BridgeError(ValueError):
    """An expected, safe-to-return protocol or input error."""


class _DiscardProgress:
    """Discard Graphify's stdout progress without filesystem access."""

    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        return None


def _object_without_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BridgeError("duplicate JSON key")
        result[key] = value
    return result


def _read_request() -> dict[str, Any]:
    payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(payload) > MAX_REQUEST_BYTES:
        raise BridgeError("request exceeds size limit")
    if payload.endswith(b"\r\n"):
        payload = payload[:-2]
    elif payload.endswith(b"\n"):
        payload = payload[:-1]
    if not payload or b"\n" in payload or b"\r" in payload:
        raise BridgeError("expected one JSON object line")
    try:
        request = json.loads(
            payload.decode("utf-8"), object_pairs_hook=_object_without_duplicate_keys
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BridgeError("request is not valid UTF-8 JSON") from None
    if not isinstance(request, dict):
        raise BridgeError("request must be a JSON object")
    return request


def _absolute_text(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_PATH_CHARS:
        raise BridgeError("invalid host path")
    path = Path(value)
    if not path.is_absolute():
        raise BridgeError("host paths must be absolute")
    return value


def _snapshot_root(value: Any) -> Path:
    raw = _absolute_text(value)
    path = Path(raw)
    if path.is_symlink():
        raise BridgeError("snapshot path must not be a symlink")
    try:
        root = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise BridgeError("snapshot directory is unavailable") from None
    if not root.is_dir():
        raise BridgeError("snapshot path must be a directory")
    return root


def _artifact_path(value: Any, root: Path | None, *, must_exist: bool) -> Path:
    raw = _absolute_text(value)
    requested = Path(raw)
    if requested.suffix != ".json" or requested.name in {"", ".", ".."}:
        raise BridgeError("artifact path must name a .json file")
    if requested.is_symlink():
        raise BridgeError("artifact path must not be a symlink")
    try:
        parent = requested.parent.resolve(strict=True)
    except (OSError, RuntimeError):
        raise BridgeError("artifact directory is unavailable") from None
    if not parent.is_dir():
        raise BridgeError("artifact parent must be a directory")
    artifact = parent / requested.name
    if root is not None and (artifact == root or root in artifact.parents):
        raise BridgeError("artifact must be outside the read-only snapshot")
    if artifact.exists():
        if artifact.is_symlink() or not artifact.is_file():
            raise BridgeError("artifact path must be a regular file")
    elif must_exist:
        raise BridgeError("artifact file is unavailable")
    return artifact


def _output_directory(value: Any, root: Path) -> Path:
    raw = _absolute_text(value)
    requested = Path(raw)
    if requested.is_symlink():
        raise BridgeError("output directory must not be a symlink")
    try:
        output = requested.resolve(strict=True)
    except (OSError, RuntimeError):
        raise BridgeError("output directory is unavailable") from None
    if not output.is_dir():
        raise BridgeError("output path must be a directory")
    if output == root or root in output.parents or output in root.parents:
        raise BridgeError("input and output directories must be disjoint")
    artifact = output / "graph.json"
    if artifact.is_symlink() or (artifact.exists() and not artifact.is_file()):
        raise BridgeError("graph artifact path must be a regular file")
    return output


def _safe_relative_path(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str) or len(value) > MAX_PATH_CHARS:
        raise BridgeError("graph contains invalid source path metadata")
    posix = PurePosixPath(value.replace("\\", "/"))
    windows = PureWindowsPath(value)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise BridgeError("graph contains an absolute source path")
    if not posix.parts or any(part in {".", ".."} for part in posix.parts):
        raise BridgeError("graph contains an escaping source path")
    return posix.as_posix()


def _validate_graph_document(document: Any) -> tuple[int, int]:
    if not isinstance(document, dict):
        raise BridgeError("Graphify produced an invalid graph")
    nodes = document.get("nodes")
    links = document.get("links", document.get("edges"))
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise BridgeError("Graphify produced an invalid graph")
    if document.get("directed") is not True:
        raise BridgeError("Graphify output did not preserve edge directions")
    if len(nodes) > MAX_GRAPH_NODES or len(links) > MAX_GRAPH_EDGES:
        raise BridgeError("graph exceeds size limits")
    for collection in (nodes, links):
        for item in collection:
            if not isinstance(item, dict):
                raise BridgeError("Graphify produced invalid graph metadata")
            for field in ("source_file", "definition_file"):
                if field in item:
                    _safe_relative_path(item[field])
            for field in ("source_location",):
                value = item.get(field)
                if value is not None and (
                    not isinstance(value, str) or len(value) > MAX_LOCATION_CHARS
                ):
                    raise BridgeError("graph source location exceeds size limit")
            label = item.get("label")
            relation = item.get("relation")
            if isinstance(label, str) and len(label) > MAX_SYMBOL_CHARS:
                raise BridgeError("graph symbol exceeds size limit")
            if isinstance(relation, str) and len(relation) > 128:
                raise BridgeError("graph relation exceeds size limit")
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or len(node_id) > MAX_NODE_ID_CHARS:
            raise BridgeError("graph node id exceeds size limit")
    return len(nodes), len(links)


def _source_files(root: Path) -> list[Path]:
    from graphify.extract import collect_files

    candidates = collect_files(root, follow_symlinks=False, root=root)
    selected: list[Path] = []
    total_bytes = 0
    for path in candidates:
        if path.suffix.lower() not in ALLOWED_SUFFIXES or path.is_symlink():
            continue
        try:
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(root) or not resolved.is_file():
                continue
            size = resolved.stat().st_size
        except (OSError, RuntimeError):
            continue
        if size > MAX_SOURCE_FILE_BYTES:
            raise BridgeError("source file exceeds size limit")
        total_bytes += size
        if total_bytes > MAX_SOURCE_BYTES:
            raise BridgeError("source snapshot exceeds size limit")
        selected.append(resolved)
        if len(selected) > MAX_SOURCE_FILES:
            raise BridgeError("source snapshot contains too many supported files")
    return selected


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _build(request: dict[str, Any]) -> dict[str, Any]:
    if set(request) != {"action", "inputDirectory", "outputDirectory"}:
        raise BridgeError("build request has unexpected or missing fields")
    root = _snapshot_root(request["inputDirectory"])
    output = _output_directory(request["outputDirectory"], root)
    artifact = output / "graph.json"
    paths = _source_files(root)

    # The pinned extract facade eagerly imports its AST extractor modules; the
    # explicit paths below still constrain actual parsing to the allowlist.
    from graphify.rcfile import activate_language_overrides

    if set(activate_language_overrides(root)).intersection(ALLOWED_SUFFIXES):
        raise BridgeError("snapshot remaps an allowed source language")
    from graphify.build import build
    from graphify.export import to_json
    from graphify.extract import extract

    with tempfile.TemporaryDirectory(
        prefix=".graphify-adapter-", dir=output
    ) as staging_dir:
        with tempfile.TemporaryDirectory(prefix="cache-", dir=staging_dir) as cache_dir:
            staged_graph = Path(staging_dir) / "graph.json"
            with contextlib.redirect_stdout(_DiscardProgress()):
                extraction = extract(
                    paths,
                    cache_root=Path(cache_dir),
                    root=root,
                    parallel=False,
                )
                if not isinstance(extraction, dict):
                    raise BridgeError("Graphify returned an invalid extraction")
                nodes = extraction.get("nodes")
                edges = extraction.get("edges")
                if not isinstance(nodes, list) or not isinstance(edges, list):
                    raise BridgeError("Graphify returned an invalid extraction")
                if len(nodes) > MAX_GRAPH_NODES or len(edges) > MAX_GRAPH_EDGES:
                    raise BridgeError("extraction exceeds graph limits")
                graph = build(
                    [extraction],
                    directed=True,
                    dedup=False,
                    root=root,
                )
                if graph.number_of_nodes() > MAX_GRAPH_NODES:
                    raise BridgeError("graph exceeds node limit")
                if graph.number_of_edges() > MAX_GRAPH_EDGES:
                    raise BridgeError("graph exceeds edge limit")
                written = to_json(
                    graph,
                    {},
                    str(staged_graph),
                    force=True,
                    built_at_commit="",
                    original_links=extraction.get("edges", []),
                )
                if not written or not staged_graph.is_file():
                    raise BridgeError("Graphify could not write the graph artifact")
                if staged_graph.stat().st_size > MAX_GRAPH_BYTES:
                    raise BridgeError("graph artifact exceeds size limit")
                try:
                    document = json.loads(staged_graph.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    raise BridgeError("Graphify produced an unreadable graph artifact") from None
                node_count, edge_count = _validate_graph_document(document)
                digest = _sha256(staged_graph)
                os.replace(staged_graph, artifact)

    return {
        "ok": True,
        "action": "build",
        "artifact_path": str(artifact),
        "artifact_sha256": digest,
        "node_count": node_count,
        "edge_count": edge_count,
        "source_file_count": len(paths),
    }


def _line_number(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    match = _LINE_NUMBER.match(value)
    if not match:
        return None
    line = int(match.group(1))
    return line if 1 <= line <= 2_147_483_647 else None


def _display(value: Any) -> str:
    from graphify.security import sanitize_label

    return sanitize_label(str(value))


def _query_node_hits(graph: Any, rendered: str) -> tuple[list[dict[str, Any]], bool]:
    node_index: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for node_id, data in graph.nodes(data=True):
        label = data.get("label", node_id)
        source_path = _safe_relative_path(data.get("source_file"))
        if source_path is None:
            continue
        if len(str(label)) > MAX_SYMBOL_CHARS:
            raise BridgeError("graph symbol exceeds size limit")
        if len(str(node_id)) > MAX_NODE_ID_CHARS:
            raise BridgeError("graph node id exceeds size limit")
        location = data.get("source_location")
        location_text = "" if location is None else str(location)
        if len(location_text) > MAX_LOCATION_CHARS:
            raise BridgeError("graph source location exceeds size limit")
        node_index[(_display(label), _display(source_path), _display(location_text))].append(
            {
                "id": str(node_id),
                "symbol": _display(label),
                "path": source_path,
                "location": location_text or None,
                "line": _line_number(location_text),
            }
        )

    hits: list[dict[str, Any]] = []
    seen: set[str] = set()
    truncated = False
    for line in rendered.splitlines():
        if not line.startswith("NODE "):
            continue
        prefix, marker, metadata = line[5:].rpartition(" [src=")
        if not marker:
            continue
        source_path, location_marker, tail = metadata.rpartition(" loc=")
        if not location_marker:
            continue
        location, community_marker, _community = tail.partition(" community=")
        if not community_marker:
            continue
        candidates = node_index.get((prefix, source_path, location), ())
        for hit in candidates:
            if hit["id"] in seen:
                continue
            if len(hits) >= MAX_QUERY_NODES:
                truncated = True
                return hits, truncated
            seen.add(hit["id"])
            hits.append(hit)
    return hits, truncated


def _query_edge_hits(graph: Any, rendered: str) -> tuple[list[dict[str, Any]], bool]:
    edge_index: dict[tuple[str, str, str, str, str], deque[dict[str, Any]]] = defaultdict(deque)
    for source_id, target_id, data in graph.edges(data=True):
        source_data = graph.nodes[source_id]
        target_data = graph.nodes[target_id]
        source_path = _safe_relative_path(data.get("source_file"))
        location = data.get("source_location")
        relation = data.get("relation")
        if source_path is None or not isinstance(location, str) or not relation:
            continue
        source_symbol = source_data.get("label", source_id)
        target_symbol = target_data.get("label", target_id)
        if max(len(str(source_symbol)), len(str(target_symbol))) > MAX_SYMBOL_CHARS:
            raise BridgeError("graph symbol exceeds size limit")
        if len(str(relation)) > 128:
            raise BridgeError("graph relation exceeds size limit")
        if len(location) > MAX_LOCATION_CHARS:
            raise BridgeError("graph source location exceeds size limit")
        key = (
            _display(source_symbol),
            _display(relation),
            _display(target_symbol),
            _display(source_path),
            _display(location),
        )
        edge_index[key].append(
            {
                "source_symbol": _display(source_symbol),
                "target_symbol": _display(target_symbol),
                "source_id": str(source_id),
                "target_id": str(target_id),
                "relation": _display(relation),
                "path": source_path,
                "location": location,
                "line": _line_number(location),
            }
        )

    hits: list[dict[str, Any]] = []
    truncated = False
    for line in rendered.splitlines():
        if not line.startswith("EDGE "):
            continue
        edge_text, at_marker, at_value = line[5:].rpartition(" at=")
        if not at_marker:
            continue
        source_path, colon, location = at_value.rpartition(":")
        if not colon or not location:
            continue
        endpoints, direction_marker, target_symbol = edge_text.partition("]--> ")
        if not direction_marker:
            continue
        relation_metadata = endpoints.rpartition(" [")[0]
        source_symbol, relation_marker, relation = relation_metadata.partition(" --")
        if not relation_marker:
            continue
        key = (
            source_symbol,
            relation,
            target_symbol,
            _display(source_path),
            _display(location),
        )
        candidates = edge_index.get(key)
        if not candidates:
            continue
        if len(hits) >= MAX_QUERY_EDGES:
            truncated = True
            return hits, truncated
        hits.append(candidates.popleft())
    return hits, truncated


def _runtime_hits(
    node_hits: list[dict[str, Any]],
    edge_hits: list[dict[str, Any]],
    limit: int,
) -> tuple[list[dict[str, Any]], bool]:
    relations_by_node: dict[str, list[str]] = defaultdict(list)
    truncated = False
    for edge in edge_hits:
        relation = edge["relation"]
        for node_id in (edge["source_id"], edge["target_id"]):
            relations = relations_by_node[node_id]
            if relation not in relations:
                if len(relations) == 20:
                    truncated = True
                else:
                    relations.append(relation)

    candidates: list[dict[str, Any]] = []
    seen: set[tuple[str, int | None, str]] = set()
    for node in node_hits:
        line = node["line"]
        identity = (node["path"], line, node["symbol"])
        if identity in seen:
            continue
        hit: dict[str, Any] = {"path": node["path"], "symbol": node["symbol"]}
        if line is not None:
            hit["line"] = line
        relations = relations_by_node.get(node["id"], [])
        if relations:
            hit["relations"] = relations
        candidates.append(hit)
        seen.add(identity)

    if len(candidates) > limit:
        truncated = True
    hits = candidates[:limit]
    while hits and len(
        json.dumps(hits, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ) > MAX_RUNTIME_HIT_BYTES:
        hits.pop()
        truncated = True
    return hits, truncated


def _query(request: dict[str, Any]) -> dict[str, Any]:
    if set(request) != {"action", "graphPath", "query", "limit"}:
        raise BridgeError("query request has unexpected or missing fields")
    artifact = _artifact_path(request["graphPath"], None, must_exist=True)
    question = request["query"]
    limit = request["limit"]
    if not isinstance(question, str) or not question.strip():
        raise BridgeError("query must be a non-empty string")
    if type(limit) is not int or limit < 1 or limit > 10:
        raise BridgeError("query limit must be between 1 and 10")
    if len(question.encode("utf-8")) > MAX_QUERY_BYTES:
        raise BridgeError("query exceeds size limit")
    if "\x00" in question:
        raise BridgeError("query contains an invalid control character")
    try:
        if artifact.stat().st_size > MAX_GRAPH_BYTES:
            raise BridgeError("graph artifact exceeds size limit")
    except OSError:
        raise BridgeError("artifact file is unavailable") from None

    # serve's module import may attempt optional jieba import, but these direct
    # helpers do not create MCP servers or enter the query-logging dispatcher.
    from graphify.serve import _query_graph_text, _read_graph

    with contextlib.redirect_stdout(_DiscardProgress()):
        graph = _read_graph(str(artifact))
        # _read_graph may load the optional display-only overlay from a sidecar.
        graph.graph["_learning_overlay"] = {}
        if graph.number_of_nodes() > MAX_GRAPH_NODES or graph.number_of_edges() > MAX_GRAPH_EDGES:
            raise BridgeError("graph exceeds size limits")
        for node_id, data in graph.nodes(data=True):
            if len(str(node_id)) > MAX_NODE_ID_CHARS:
                raise BridgeError("graph node id exceeds size limit")
            for field in ("source_file", "definition_file"):
                if field in data:
                    _safe_relative_path(data[field])
            location = data.get("source_location")
            if location is not None and (
                not isinstance(location, str) or len(location) > MAX_LOCATION_CHARS
            ):
                raise BridgeError("graph source location exceeds size limit")
            label = data.get("label")
            if label is not None and (
                not isinstance(label, str) or len(label) > MAX_SYMBOL_CHARS
            ):
                raise BridgeError("graph symbol exceeds size limit")
        for _source_id, _target_id, data in graph.edges(data=True):
            for field in ("source_file", "definition_file"):
                if field in data:
                    _safe_relative_path(data[field])
            for field in ("source_location",):
                value = data.get(field)
                if value is not None and (
                    not isinstance(value, str) or len(value) > MAX_LOCATION_CHARS
                ):
                    raise BridgeError("graph source location exceeds size limit")
            relation = data.get("relation")
            if relation is not None and (
                not isinstance(relation, str) or len(relation) > 128
            ):
                raise BridgeError("graph relation exceeds size limit")
        rendered = _query_graph_text(
            graph, question, mode="bfs", depth=3, token_budget=2_000, graph_path=None
        )
    if len(rendered) > MAX_QUERY_TEXT_CHARS:
        raise BridgeError("query rendering exceeds size limit")
    node_hits, node_truncated = _query_node_hits(graph, rendered)
    edge_hits, edge_truncated = _query_edge_hits(graph, rendered)
    hits, result_truncated = _runtime_hits(node_hits, edge_hits, limit)
    return {
        "ok": True,
        "hits": hits,
        "truncated": (
            node_truncated
            or edge_truncated
            or result_truncated
            or "[!] TRUNCATED:" in rendered
        ),
    }


def _dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "build":
        return _build(request)
    if action == "query":
        return _query(request)
    raise BridgeError("action must be build or query")


def _write_response(response: dict[str, Any]) -> bool:
    try:
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        payload = encoded.encode("utf-8")
    except (TypeError, UnicodeEncodeError):
        response = {"ok": False, "error": "response could not be encoded"}
        payload = json.dumps(response, separators=(",", ":")).encode("ascii")
        success = False
    else:
        success = True
    if len(payload) > MAX_RESPONSE_BYTES:
        response = {"ok": False, "error": "response exceeds size limit"}
        payload = json.dumps(response, separators=(",", ":")).encode("ascii")
        success = False
    sys.stdout.buffer.write(payload + b"\n")
    sys.stdout.buffer.flush()
    return success


def main() -> int:
    try:
        request = _read_request()
        with contextlib.redirect_stdout(sys.stderr):
            response = _dispatch(request)
        return 0 if _write_response(response) else 1
    except BridgeError as exc:
        _write_response({"ok": False, "error": str(exc)})
        return 1
    except Exception:
        _write_response({"ok": False, "error": "bridge operation failed"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
