#!/usr/bin/env python3
"""Compare Mindmap metadata extraction across local LLM providers.

The benchmark intentionally keeps embeddings out of the comparison. It samples
vault notes, runs the same summary/tag/concept prompt against each provider,
and writes a JSON report with latency and output-shape compliance.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import request


ROOT = Path(__file__).resolve().parents[1]
PYTHON_RUNTIME = ROOT / "python" / "mindmap.py"


def load_mindmap_module():
    spec = importlib.util.spec_from_file_location("mindmap_mod", PYTHON_RUNTIME)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load Mindmap runtime: {PYTHON_RUNTIME}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def stable_note_sample(notes, sample_size: int):
    if sample_size <= 0 or sample_size >= len(notes):
        return notes
    ordered = sorted(notes, key=lambda note: (note.path.as_posix(), note.title.lower()))
    step = len(ordered) / sample_size
    out = []
    used = set()
    for index in range(sample_size):
        note_index = min(len(ordered) - 1, int(round(index * step)))
        while note_index in used and note_index < len(ordered) - 1:
            note_index += 1
        used.add(note_index)
        out.append(ordered[note_index])
    return out


def build_metadata_messages(text: str, tag_limit: int, concept_limit: int) -> List[Dict[str, str]]:
    system = (
        "You label personal reflection notes. Return only JSON. "
        "Use concise, grounded language."
    )
    user = (
        "Extract metadata from the note.\n"
        "Return exactly one JSON object with this shape: "
        "{\"summary\":\"...\",\"tags\":[\"tag-one\"],\"concepts\":[\"core noun phrase\"]}.\n"
        f"The tags array must contain 3-{tag_limit} kebab-case strings. "
        f"The concepts array must contain 3-{concept_limit} core noun phrase strings.\n"
        "Rules:\n"
        "- Tags must be short, broad themes derived from the note (avoid overly specific phrases).\n"
        "- Tags must be lowercase kebab-case, no single letters, 1-3 words.\n"
        "- Concepts should be the core ideas only (no fluff).\n\n"
        "Note:\n" + text.strip()
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def parse_json_content(content: str, provider_name: str, model: str) -> Dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(content[start : end + 1])
        raise RuntimeError(f"{provider_name} {model} response did not contain valid JSON")


def openai_compatible_extract(
    base_url: str,
    api_key: str,
    model: str,
    text: str,
    tag_limit: int,
    concept_limit: int,
    timeout: int,
    max_tokens: int,
) -> Dict[str, Any]:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": build_metadata_messages(text, tag_limit, concept_limit),
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "chat_template_kwargs": {"enable_thinking": False},
        "stream": False,
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    req = request.Request(url, data=data, headers=headers)
    with request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError(f"{model} response did not include choices")
    message = choices[0].get("message", {})
    content = message.get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(f"{model} response did not include message content")
    return parse_json_content(content, "openai-compatible", model)


def compliance(result: Dict[str, Any], tag_limit: int, concept_limit: int) -> Dict[str, Any]:
    tags = result.get("tags")
    concepts = result.get("concepts")
    summary = result.get("summary")
    tag_count = len(tags) if isinstance(tags, list) else -1
    concept_count = len(concepts) if isinstance(concepts, list) else -1
    return {
        "summary_present": isinstance(summary, str) and bool(summary.strip()),
        "tags_list": isinstance(tags, list),
        "concepts_list": isinstance(concepts, list),
        "tag_count_ok": 3 <= tag_count <= tag_limit,
        "concept_count_ok": 3 <= concept_count <= concept_limit,
        "tag_count": tag_count,
        "concept_count": concept_count,
    }


def summarize(rows: List[Dict[str, Any]], provider_name: str) -> Dict[str, Any]:
    provider_rows = [row for row in rows if row["provider"] == provider_name]
    successes = [row for row in provider_rows if row.get("ok")]
    errors = [row for row in provider_rows if not row.get("ok")]
    times = [row["seconds"] for row in successes]
    checks = [row["checks"] for row in successes]
    return {
        "provider": provider_name,
        "notes_tested": len(provider_rows),
        "successes": len(successes),
        "errors": len(errors),
        "avg_seconds": round(statistics.mean(times), 2) if times else None,
        "median_seconds": round(statistics.median(times), 2) if times else None,
        "summary_present_rate": round(sum(check["summary_present"] for check in checks) / len(checks), 3) if checks else None,
        "tags_list_rate": round(sum(check["tags_list"] for check in checks) / len(checks), 3) if checks else None,
        "concepts_list_rate": round(sum(check["concepts_list"] for check in checks) / len(checks), 3) if checks else None,
        "tag_count_ok_rate": round(sum(check["tag_count_ok"] for check in checks) / len(checks), 3) if checks else None,
        "concept_count_ok_rate": round(sum(check["concept_count_ok"] for check in checks) / len(checks), 3) if checks else None,
    }


def write_report(output_path: Path, report: Dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def default_output_path() -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return ROOT / "benchmark-reports" / f"provider-comparison-{stamp}.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark Mindmap extraction providers")
    parser.add_argument("--config", required=True, help="Mindmap config path")
    parser.add_argument("--sample-size", type=int, default=12)
    parser.add_argument("--min-words", type=int, default=80)
    parser.add_argument("--max-words", type=int, default=900)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--omlx-max-tokens", type=int, default=512)
    parser.add_argument("--ollama-base-url", default=None)
    parser.add_argument("--ollama-model", default=None)
    parser.add_argument("--omlx-base-url", default="http://localhost:8000/v1")
    parser.add_argument("--omlx-model", default="Qwen3.5-9B-MLX-4bit")
    parser.add_argument("--omlx-api-key-env", default="OMLX_API_KEY")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    mod = load_mindmap_module()
    config_path = Path(args.config).expanduser().resolve()
    config = mod.load_json(config_path)
    if not config:
        raise RuntimeError(f"Config not found or empty: {config_path}")

    vault_root = Path(config.get("vault_root", "."))
    if not vault_root.is_absolute():
        vault_root = (config_path.parent / vault_root).resolve()

    notes_paths = config.get("notes_paths_all") or config.get("notes_paths") or []
    heading = config.get("mindmap_heading", "## Mindmap")
    notes = mod.list_notes(vault_root, notes_paths, args.min_words, heading)
    sample = stable_note_sample(notes, args.sample_size)
    if not sample:
        raise RuntimeError("No notes found for benchmark sample")

    tag_limit = int(config["tag_limit"])
    concept_limit = int(config["concept_limit"])
    ollama_base_url = args.ollama_base_url or config["ollama_base_url"]
    ollama_model = args.ollama_model or config["llm_model"]
    omlx_api_key = os.environ.get(args.omlx_api_key_env, "")
    if not omlx_api_key:
        raise RuntimeError(f"Missing OMLX API key. Set {args.omlx_api_key_env}.")

    providers = [
        {
            "name": f"ollama:{ollama_model}",
            "kind": "ollama",
            "model": ollama_model,
        },
        {
            "name": f"omlx:{args.omlx_model}",
            "kind": "openai-compatible",
            "model": args.omlx_model,
        },
    ]
    output_path = Path(args.output).expanduser().resolve() if args.output else default_output_path()

    rows: List[Dict[str, Any]] = []
    total = len(sample) * len(providers)
    completed = 0
    for provider in providers:
        for note in sample:
            body = " ".join(note.body.split()[: args.max_words])
            started = time.time()
            row: Dict[str, Any] = {
                "provider": provider["name"],
                "model": provider["model"],
                "note": note.relpath,
                "word_count": len(body.split()),
            }
            try:
                if provider["kind"] == "ollama":
                    result = mod.llm_extract(
                        ollama_base_url,
                        provider["model"],
                        body,
                        tag_limit,
                        concept_limit,
                        [],
                        True,
                        timeout=args.timeout,
                    )
                else:
                    result = openai_compatible_extract(
                        args.omlx_base_url,
                        omlx_api_key,
                        provider["model"],
                        body,
                        tag_limit,
                        concept_limit,
                        timeout=args.timeout,
                        max_tokens=args.omlx_max_tokens,
                    )
                row.update(
                    {
                        "ok": True,
                        "seconds": round(time.time() - started, 2),
                        "checks": compliance(result, tag_limit, concept_limit),
                        "summary": result.get("summary"),
                        "tags": result.get("tags"),
                        "concepts": result.get("concepts"),
                    }
                )
            except Exception as exc:
                row.update(
                    {
                        "ok": False,
                        "seconds": round(time.time() - started, 2),
                        "error": str(exc),
                    }
                )
            rows.append(row)
            completed += 1
            report = {
                "config_path": str(config_path),
                "vault_root": str(vault_root),
                "sample_size": len(sample),
                "notes": [note.relpath for note in sample],
                "providers": providers,
                "summary": [summarize(rows, provider["name"]) for provider in providers],
                "rows": rows,
            }
            write_report(output_path, report)
            print(json.dumps({"progress": f"{completed}/{total}", "provider": provider["name"], "note": note.relpath}, ensure_ascii=True), flush=True)

    print(json.dumps({"output": str(output_path), "summary": report["summary"]}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
