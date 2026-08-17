#!/usr/bin/env python3
"""Local knowledge maintenance for Obsidian notes using Ollama + ChromaDB.

Default scope comes from config.json. Designed to be safe: no note changes unless --apply.
"""

import argparse
import atexit
import hashlib
import json
import math
import os
import re
import socket
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
import difflib
from io import StringIO
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Callable
from urllib import request
from urllib.error import HTTPError
from urllib.parse import urlparse

try:
    from ruamel.yaml import YAML
    YAML_IMPORT_ERROR = None
except ModuleNotFoundError as exc:
    YAML = None
    YAML_IMPORT_ERROR = exc

DEPENDENCY_INSTALL_COMMAND = "python3 -m pip install -r .obsidian/plugins/mindmap-ai/python/requirements.txt"


@dataclass
class Note:
    path: Path
    relpath: str
    title: str
    body: str


@dataclass
class RuntimePaths:
    config_path: Path
    vault_root: Path
    db_path: Path
    state_path: Path
    log_path: Path
    preview_path: Path


@dataclass
class RuntimeContext:
    config: Dict
    paths: RuntimePaths
    embed_settings: Dict
    llm_settings: Dict
    embed_model: str
    llm_model: str
    mindmap_heading: str
    write_mindmap_section: bool
    related_strategy: str
    related_candidate_limit: int
    related_overreach: int
    related_creative: int
    related_creative_min: float
    related_creative_max: float
    ollama_embed_timeout: int
    ollama_llm_timeout: int
    ollama_retries: int
    ollama_backoff: float


def diagnostic_line(level: str, code: str, message: str, guidance: Optional[str] = None, context: Optional[Dict] = None) -> str:
    parts = [f"[{level}][{code}] {message}"]
    if guidance:
        parts.append(f"Guidance: {guidance}")
    if context:
        context_parts = [f"{key}={value}" for key, value in context.items()]
        if context_parts:
            parts.append("Context: " + ", ".join(context_parts))
    return " ".join(parts)


def emit_stderr(level: str, code: str, message: str, guidance: Optional[str] = None, context: Optional[Dict] = None):
    print(diagnostic_line(level, code, message, guidance=guidance, context=context), file=sys.stderr, flush=True)


def dependency_install_guidance() -> str:
    return f"Install dependencies with `{DEPENDENCY_INSTALL_COMMAND}`."


def build_runtime_issue(
    level: str,
    code: str,
    message: str,
    guidance: Optional[str] = None,
    context: Optional[Dict] = None,
) -> Dict:
    issue = {"level": level, "code": code, "message": message}
    if guidance:
        issue["guidance"] = guidance
    if context:
        issue["context"] = context
    return issue


def is_within_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_vault_markdown_write_target(vault_root: Path, raw_target: str) -> Tuple[Optional[Path], Optional[Dict]]:
    target_text = str(raw_target).strip()
    if not target_text:
        return None, build_runtime_issue(
            "error",
            "WRITE_TARGET_EMPTY",
            "Write target path is empty.",
            guidance="Use a vault-relative markdown path such as Notes/Example.md.",
        )

    vault_abs = vault_root.resolve()
    candidate = Path(target_text)
    if not candidate.is_absolute() and ".." in candidate.parts:
        return None, build_runtime_issue(
            "error",
            "WRITE_TARGET_TRAVERSAL",
            "Write target path traversal is not allowed.",
            guidance="Remove '..' from the path and use a direct vault-relative markdown path.",
            context={"path": target_text},
        )

    target = candidate if candidate.is_absolute() else vault_abs / candidate
    resolved_target = target.resolve(strict=False)
    if not is_within_root(resolved_target, vault_abs):
        return None, build_runtime_issue(
            "error",
            "WRITE_TARGET_OUTSIDE_VAULT",
            "Write target resolves outside the configured vault root.",
            guidance="Use a path inside the vault_root directory.",
            context={"path": target_text, "vault_root": str(vault_abs)},
        )

    if resolved_target.suffix.lower() != ".md":
        return None, build_runtime_issue(
            "error",
            "WRITE_TARGET_NOT_MARKDOWN",
            "Write target must be a markdown file (*.md).",
            guidance="Update the target path to a .md note file.",
            context={"path": target_text},
        )

    return resolved_target, None


def validate_preview_entry(entry: Dict, vault_root: Path, entry_index: int) -> Tuple[Optional[Path], Optional[Dict]]:
    context = {"entry_index": entry_index}
    if not isinstance(entry, dict):
        return None, build_runtime_issue(
            "warn",
            "PREVIEW_ENTRY_INVALID",
            "Skipping preview entry because it is not a JSON object.",
            guidance="Ensure each preview.jsonl row is a JSON object with a 'path' field.",
            context=context,
        )

    raw_path = entry.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None, build_runtime_issue(
            "warn",
            "PREVIEW_PATH_MISSING",
            "Skipping preview entry because 'path' is missing.",
            guidance="Regenerate preview rows so each item includes a non-empty 'path'.",
            context=context,
        )

    target, issue = resolve_vault_markdown_write_target(vault_root, raw_path)
    if issue:
        issue_context = dict(issue.get("context", {}))
        issue_context.update(context)
        return None, build_runtime_issue(
            "warn",
            issue["code"],
            f"Skipping preview entry: {issue['message']}",
            guidance=issue.get("guidance"),
            context=issue_context,
        )

    if not target.exists():
        return None, build_runtime_issue(
            "warn",
            "PREVIEW_TARGET_MISSING",
            f"Skipping preview entry because note does not exist: {raw_path}",
            guidance="Rebuild preview output or remove stale rows before applying preview.",
            context={"path": raw_path, **context},
        )

    if not target.is_file():
        return None, build_runtime_issue(
            "warn",
            "PREVIEW_TARGET_NOT_FILE",
            f"Skipping preview entry because target is not a file: {raw_path}",
            guidance="Point preview path rows to markdown files, not directories.",
            context={"path": raw_path, **context},
        )

    return target, None


def build_preflight_check(
    code: str,
    label: str,
    status: str,
    message: str,
    guidance: Optional[str] = None,
    context: Optional[Dict] = None,
) -> Dict:
    payload = {
        "code": code,
        "label": label,
        "status": status,
        "message": message,
    }
    if guidance:
        payload["guidance"] = guidance
    if context:
        payload["context"] = context
    return payload


def load_json(path: Path, default=None):
    if not path.exists():
        return default if default is not None else {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def make_yaml_round_trip() -> YAML:
    if YAML is None:
        raise ModuleNotFoundError("ruamel.yaml is required to update frontmatter.") from YAML_IMPORT_ERROR
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.width = 4096
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def make_yaml_safe() -> YAML:
    if YAML is None:
        raise ModuleNotFoundError("ruamel.yaml is required to parse frontmatter.") from YAML_IMPORT_ERROR
    return YAML(typ="safe")


def split_frontmatter(text: str) -> Tuple[Optional[str], str]:
    if not text.startswith("---"):
        return None, text

    lines = text.splitlines(keepends=True)
    if len(lines) < 2:
        return None, text

    offset = len(lines[0])
    for line in lines[1:]:
        if line.strip() == "---":
            frontmatter = text[len(lines[0]) : offset]
            body = text[offset + len(line) :]
            return frontmatter, body
        offset += len(line)

    return None, text


def to_plain_data(value):
    if isinstance(value, dict):
        return {str(key): to_plain_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [to_plain_data(item) for item in value]
    return value


def parse_frontmatter(text: str) -> Tuple[Dict, str]:
    frontmatter, body = split_frontmatter(text)
    if frontmatter is None:
        return {}, text

    yaml = make_yaml_safe()
    data = yaml.load(frontmatter) or {}
    if not isinstance(data, dict):
        return {}, body
    return to_plain_data(data), body


def dump_frontmatter(data) -> str:
    yaml = make_yaml_round_trip()
    buffer = StringIO()
    yaml.dump(data, buffer)
    return buffer.getvalue()


def strip_related_section(text: str, heading: str) -> str:
    lines = text.splitlines()

    # Remove any legacy marker lines containing mindmap markers
    lines = [l for l in lines if "mindmap:start" not in l.lower() and "mindmap:end" not in l.lower()]

    # Remove legacy headings (can appear multiple times)
    heading_line = heading.strip().lower()
    legacy_headings = {heading_line, "## related", "## mindmap"}
    i = 0
    cleaned = []
    while i < len(lines):
        if lines[i].strip().lower() in legacy_headings:
            i += 1
            while i < len(lines) and not lines[i].startswith("#"):
                i += 1
            continue
        cleaned.append(lines[i])
        i += 1
    lines = cleaned

    # Remove any callout blocks titled Mindmap/Related (can appear multiple times)
    i = 0
    cleaned = []
    while i < len(lines):
        line = lines[i].strip()
        if re.match(r"^>\s*\[!.*\]-\s*(mindmap|related)\s*$", line, re.I):
            i += 1
            while i < len(lines) and lines[i].startswith(">"):
                i += 1
            continue
        cleaned.append(lines[i])
        i += 1

    return "\n".join(cleaned).strip() + "\n"


def normalize_tags(tags: List[str]) -> List[str]:
    out = []
    for tag in tags:
        tag = tag.strip().lower()
        tag = re.sub(r"[^a-z0-9\s-]", "", tag)
        tag = re.sub(r"\s+", "-", tag)
        tag = re.sub(r"-+", "-", tag).strip("-")
        if tag and tag not in out:
            out.append(tag)
    return out


def normalize_list_field(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        parts = re.split(r"[\\n,;]+", value)
        return [p.strip() for p in parts if p.strip()]
    return []


def normalize_concepts(concepts: List[str], limit: int, max_words: int, case_mode: str) -> List[str]:
    seen = set()
    out = []
    for c in concepts:
        c = c.strip()
        if not c:
            continue
        if max_words and len(c.split()) > max_words:
            continue
        if case_mode == "lower":
            c = c.lower()
        elif case_mode == "title":
            c = c.title()
        key = c.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
        if limit and len(out) >= limit:
            break
    return out


def filter_and_map_tags(tags: List[str], controlled: List[str], allow_free: bool, min_len: int, max_words: int) -> List[str]:
    controlled_norm = normalize_tags(controlled)
    controlled_set = set(controlled_norm)

    out = []
    for tag in tags:
        if min_len and len(tag) < min_len:
            continue
        if max_words:
            words = tag.split("-")
            if len(words) > max_words:
                continue
        if not controlled_set:
            if tag not in out:
                out.append(tag)
            continue
        if tag in controlled_set:
            if tag not in out:
                out.append(tag)
            continue
        # Attempt to map to closest controlled tag
        match = difflib.get_close_matches(tag, controlled_norm, n=1, cutoff=0.75)
        if match:
            mapped = match[0]
            if mapped not in out:
                out.append(mapped)
            continue
        if allow_free and tag not in out:
            out.append(tag)
    return out


def load_tag_aliases(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    aliases = {}
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, list):
                for alias in value:
                    aliases[alias] = key
            elif isinstance(value, str):
                aliases[key] = value
    return {k: v for k, v in aliases.items() if k and v}


def apply_tag_aliases(tags: List[str], aliases: Dict[str, str]) -> List[str]:
    if not aliases:
        return tags
    out = []
    for tag in tags:
        mapped = aliases.get(tag, tag)
        if mapped not in out:
            out.append(mapped)
    return out


def apply_tag_frequency_filter(
    tag_sets: List[List[str]],
    min_freq: int,
    fallback: int,
) -> List[List[str]]:
    if min_freq <= 1:
        return tag_sets
    counts = {}
    for tags in tag_sets:
        for tag in tags:
            counts[tag] = counts.get(tag, 0) + 1

    filtered = []
    for tags in tag_sets:
        kept = [t for t in tags if counts.get(t, 0) >= min_freq]
        if not kept and fallback > 0:
            kept = tags[:fallback]
        filtered.append(kept)
    return filtered


def chunk_text(text: str, target_tokens: int, overlap_tokens: int) -> List[str]:
    words = text.split()
    if not words:
        return []
    target_words = max(50, int(target_tokens * 0.75))
    overlap_words = max(10, int(overlap_tokens * 0.75))
    chunks = []
    start = 0
    while start < len(words):
        end = min(len(words), start + target_words)
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        if end == len(words):
            break
        start = max(0, end - overlap_words)
    return chunks


def ollama_request(
    base_url: str,
    endpoint: str,
    payload: dict,
    timeout: int = 120,
    retries: int = 1,
    backoff_seconds: float = 2.0,
    log_fn: Optional[Callable[[str], None]] = None,
) -> dict:
    url = base_url.rstrip("/") + endpoint
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=data, headers={"Content-Type": "application/json"})
    model = payload.get("model", "unknown")

    last_err = None
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_err = exc
            if log_fn:
                log_fn(
                    diagnostic_line(
                        "warn",
                        "OLLAMA_REQUEST_FAILED",
                        f"Ollama request failed on attempt {attempt}/{attempts}: {exc}",
                        context={"endpoint": endpoint, "model": model, "base_url": base_url},
                    )
                )
            if attempt < attempts:
                time.sleep(backoff_seconds * attempt)

    raise RuntimeError(
        diagnostic_line(
            "error",
            "OLLAMA_REQUEST_FAILED",
            f"Ollama request failed after {attempts} attempts: {last_err}",
            guidance="Check that Ollama is running and that the configured model exists.",
            context={"endpoint": endpoint, "model": model, "base_url": base_url},
        )
    )


def provider_request(
    provider_label: str,
    url: str,
    payload: dict,
    timeout: int = 120,
    retries: int = 1,
    backoff_seconds: float = 2.0,
    log_fn: Optional[Callable[[str], None]] = None,
    headers: Optional[Dict[str, str]] = None,
    guidance: Optional[str] = None,
) -> dict:
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=data, headers=request_headers)
    model = payload.get("model", "unknown")

    last_err = None
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_err = exc
            if log_fn:
                log_fn(
                    diagnostic_line(
                        "warn",
                        "PROVIDER_REQUEST_FAILED",
                        f"{provider_label} request failed on attempt {attempt}/{attempts}: {exc}",
                        context={"provider": provider_label, "model": model, "url": url},
                    )
                )
            if attempt < attempts:
                time.sleep(backoff_seconds * attempt)

    raise RuntimeError(
        diagnostic_line(
            "error",
            "PROVIDER_REQUEST_FAILED",
            f"{provider_label} request failed after {attempts} attempts: {last_err}",
            guidance=guidance or "Check that the provider server is running and that the configured model exists.",
            context={"provider": provider_label, "model": model, "url": url},
        )
    )


def embed_texts(
    base_url: str,
    model: str,
    texts: List[str],
    timeout: int = 120,
    retries: int = 1,
    backoff_seconds: float = 2.0,
    log_fn: Optional[Callable[[str], None]] = None,
) -> List[List[float]]:
    if not texts:
        return []
    resp = ollama_request(
        base_url,
        "/api/embed",
        {"model": model, "input": texts},
        timeout=timeout,
        retries=retries,
        backoff_seconds=backoff_seconds,
        log_fn=log_fn,
    )
    if "embeddings" in resp:
        return resp["embeddings"]
    if "embedding" in resp:
        return [resp["embedding"]]
    raise RuntimeError("Unexpected embed response")


def build_metadata_messages(
    text: str,
    tag_limit: int,
    concept_limit: int,
    controlled_tags: List[str],
    allow_free_tags: bool,
) -> List[Dict[str, str]]:
    system = (
        "You label personal reflection notes. Return exactly one JSON object, not an array. "
        "Use concise, grounded language."
    )
    tag_rule = "Tags must be short, broad themes derived from the note (avoid overly specific phrases)."
    if controlled_tags:
        tag_rule += " Use only tags from this list:\n" + ", ".join(controlled_tags)
        if not allow_free_tags:
            tag_rule += "\nReturn only tags from the list."
    user = (
        "Extract metadata from the note.\n"
        "Return a single JSON object shaped like "
        "{\"summary\":\"...\",\"tags\":[\"tag-one\"],\"concepts\":[\"concept one\"]}.\n"
        f"Required keys: summary (1-2 sentences), tags (3-{tag_limit} kebab-case), "
        f"concepts (3-{concept_limit} core noun phrases).\n"
        "Rules:\n"
        f"- {tag_rule}\n"
        "- Tags must be lowercase kebab-case, no single letters, 1-3 words.\n"
        "- Concepts should be the core ideas only (no fluff).\n\n"
        "Note:\n" + text.strip()
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def parse_llm_metadata_json(content: str, model: str, provider: str) -> Dict:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1 and end > start:
            parsed = json.loads(content[start : end + 1])
        else:
            raise RuntimeError(
                diagnostic_line(
                    "error",
                    "LLM_INVALID_RESPONSE",
                    "LLM response did not contain valid JSON.",
                    guidance="Retry the run or switch to a model that follows JSON output more reliably.",
                    context={"model": model, "provider": provider},
                )
            )
    if isinstance(parsed, dict):
        return parsed
    raise RuntimeError(
        diagnostic_line(
            "error",
            "LLM_INVALID_RESPONSE",
            "LLM response JSON was not an object.",
            guidance="Retry the run or switch to a model that follows object-shaped JSON output more reliably.",
            context={"model": model, "provider": provider, "response_type": type(parsed).__name__},
        )
    )


def build_openai_compatible_chat_payload(
    model: str,
    messages: List[Dict[str, str]],
    max_tokens: int,
    chat_template_kwargs: Optional[Dict] = None,
) -> Dict:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        "stream": False,
    }
    if chat_template_kwargs:
        payload["chat_template_kwargs"] = chat_template_kwargs
    return payload


def parse_openai_compatible_chat_response(resp: Dict) -> str:
    choices = resp.get("choices", [])
    if not choices:
        return ""
    message = choices[0].get("message", {})
    content = message.get("content", "")
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("text"):
                parts.append(str(item["text"]))
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return str(content)


def normalize_provider_name(provider: str) -> str:
    return provider.strip().lower().replace("-", "_")


def resolve_llm_api_key(config: Dict) -> str:
    env_name = str(config.get("llm_api_key_env", "")).strip()
    if env_name:
        return os.environ.get(env_name, "")
    return str(config.get("llm_api_key", "")).strip()


def get_embed_settings(config: Dict) -> Dict[str, str]:
    provider = normalize_provider_name(str(config.get("embed_provider", "ollama")))
    base_url = str(config.get("embed_base_url", config.get("ollama_base_url", ""))).strip()
    model = str(config.get("embed_model", "")).strip()
    return {"provider": provider, "base_url": base_url, "model": model}


def get_llm_settings(config: Dict) -> Dict:
    provider = normalize_provider_name(str(config.get("llm_provider", "ollama")))
    base_url = str(config.get("llm_base_url", config.get("ollama_base_url", ""))).strip()
    model = str(config.get("llm_model", "")).strip()
    max_tokens = int(config.get("llm_max_tokens", 1024))
    chat_template_kwargs = config.get("llm_chat_template_kwargs", {})
    if not isinstance(chat_template_kwargs, dict):
        chat_template_kwargs = {}
    return {
        "provider": provider,
        "base_url": base_url,
        "model": model,
        "api_key": resolve_llm_api_key(config),
        "api_key_env": str(config.get("llm_api_key_env", "")).strip(),
        "max_tokens": max_tokens,
        "chat_template_kwargs": chat_template_kwargs,
    }


def llm_extract(
    base_url: str,
    model: str,
    text: str,
    tag_limit: int,
    concept_limit: int,
    controlled_tags: List[str],
    allow_free_tags: bool,
    timeout: int = 120,
    retries: int = 1,
    backoff_seconds: float = 2.0,
    log_fn: Optional[Callable[[str], None]] = None,
    provider: str = "ollama",
    api_key: str = "",
    max_tokens: int = 1024,
    chat_template_kwargs: Optional[Dict] = None,
) -> Dict:
    messages = build_metadata_messages(text, tag_limit, concept_limit, controlled_tags, allow_free_tags)
    provider = normalize_provider_name(provider)

    if provider == "ollama":
        payload = {
            "model": model,
            "messages": messages,
            "format": "json",
            "stream": False,
        }
        resp = ollama_request(
            base_url,
            "/api/chat",
            payload,
            timeout=timeout,
            retries=retries,
            backoff_seconds=backoff_seconds,
            log_fn=log_fn,
        )
        return parse_llm_metadata_json(resp.get("message", {}).get("content", ""), model, provider)

    if provider == "openai_compatible":
        payload = build_openai_compatible_chat_payload(
            model,
            messages,
            max_tokens=max_tokens,
            chat_template_kwargs=chat_template_kwargs,
        )
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        resp = provider_request(
            "OpenAI-compatible LLM",
            base_url.rstrip("/") + "/chat/completions",
            payload,
            timeout=timeout,
            retries=retries,
            backoff_seconds=backoff_seconds,
            log_fn=log_fn,
            headers=headers,
            guidance="Check that the OpenAI-compatible server is running and accepts the configured model/API key.",
        )
        return parse_llm_metadata_json(parse_openai_compatible_chat_response(resp), model, provider)

    raise ValueError(f"Unsupported llm_provider: {provider}")


def list_notes(vault_root: Path, notes_paths: List[str], min_words: int, related_heading: str) -> List[Note]:
    notes = []
    for notes_path in notes_paths:
        base = vault_root / notes_path
        if not base.exists():
            continue
        for path in base.rglob("*.md"):
            relpath = path.relative_to(vault_root).as_posix()
            title = path.stem
            text = path.read_text(encoding="utf-8", errors="ignore")
            fm, body = parse_frontmatter(text)
            body = strip_related_section(body, related_heading)
            if len(body.split()) < min_words:
                continue
            notes.append(Note(path=path, relpath=relpath, title=title, body=body))
    return notes


def file_signature(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def average_vectors(vectors: List[List[float]]) -> List[float]:
    if not vectors:
        return []
    length = len(vectors[0])
    avg = [0.0] * length
    for vec in vectors:
        for i, val in enumerate(vec):
            avg[i] += val
    return [v / len(vectors) for v in avg]


def related_from_chunks(chunks_col, note_path: str, candidate_limit: int, min_score: float) -> List[Tuple[str, float]]:
    data = chunks_col.get(where={"path": note_path}, include=["embeddings", "metadatas"])
    embeddings = data.get("embeddings")
    if embeddings is None:
        embeddings = []
    elif hasattr(embeddings, "size") and embeddings.size == 0:
        embeddings = []
    elif hasattr(embeddings, "size"):
        embeddings = list(embeddings)
    elif isinstance(embeddings, list) and len(embeddings) == 0:
        embeddings = []
    if not embeddings:
        return []

    scores = {}
    for emb in embeddings:
        res = chunks_col.query(
            query_embeddings=[emb],
            n_results=candidate_limit,
            include=["metadatas", "distances"],
        )
        metas = res.get("metadatas", [[]])[0]
        dists = res.get("distances", [[]])[0] if res.get("distances") else [None] * len(metas)
        for meta, dist in zip(metas, dists):
            path = meta.get("path")
            if not path or path == note_path:
                continue
            score = 1 - dist if dist is not None else 0.0
            if min_score and score < min_score:
                continue
            if path not in scores or score > scores[path]:
                scores[path] = score

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return ranked


def top_level_folder(path: str) -> str:
    parts = path.split("/", 1)
    return parts[0] if parts else ""


def select_mindmap_links(
    candidates: List[Tuple[str, float]],
    self_path: str,
    related_limit: int,
    overreach_count: int,
    creative_count: int,
    creative_min: float,
    creative_max: float,
) -> List[Tuple[str, str]]:
    if related_limit <= 0:
        return []

    self_domain = top_level_folder(self_path)
    picked: List[Tuple[str, str]] = []
    picked_set = set()

    # Filter out self
    candidates = [(p, s) for p, s in candidates if p != self_path]

    # Core selection: highest similarity overall
    core_count = max(0, related_limit - overreach_count - creative_count)
    for path, _score in candidates:
        if path in picked_set:
            continue
        picked.append((path, "core"))
        picked_set.add(path)
        if len(picked) >= core_count:
            break

    # Overreach: force cross-domain links
    if overreach_count > 0:
        for path, _score in candidates:
            if path in picked_set:
                continue
            if top_level_folder(path) == self_domain:
                continue
            picked.append((path, "overreach"))
            picked_set.add(path)
            if len(picked) >= core_count + overreach_count:
                break

    # Creative: mid-similarity band
    if creative_count > 0:
        for path, score in candidates:
            if path in picked_set:
                continue
            if creative_min <= score <= creative_max:
                picked.append((path, "creative"))
                picked_set.add(path)
            if len(picked) >= core_count + overreach_count + creative_count:
                break

    # Fill remaining slots with best available
    for path, _score in candidates:
        if len(picked) >= related_limit:
            break
        if path in picked_set:
            continue
        picked.append((path, "fill"))
        picked_set.add(path)

    return picked[:related_limit]


def update_frontmatter(text: str, updates: Dict, preferred_order: List[str]) -> str:
    frontmatter, body = split_frontmatter(text)
    yaml = make_yaml_round_trip()
    data = yaml.load(frontmatter) if frontmatter is not None else None
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("Frontmatter must be a YAML mapping.")

    for key in preferred_order:
        if key in updates and key not in data:
            data[key] = updates[key]
    for key, value in updates.items():
        data[key] = value

    fm_text = dump_frontmatter(data)
    if frontmatter is None:
        return f"---\n{fm_text}---\n{body}"
    return f"---\n{fm_text}---{body if body.startswith(chr(10)) else chr(10) + body}"

def strip_trailing_dividers(text: str) -> str:
    lines = text.splitlines()
    # Remove trailing blank lines
    while lines and not lines[-1].strip():
        lines.pop()
    # Remove trailing horizontal rules and any blank lines around them
    while lines and lines[-1].strip() == "---":
        lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
    return "\n".join(lines)


def update_related_section(text: str, heading: str, links: List) -> str:
    clean = strip_related_section(text, heading)
    if not links:
        return clean
    clean = strip_trailing_dividers(clean)
    block = ["> [!mindmap]- Mindmap"]
    for link in links:
        if isinstance(link, (list, tuple)) and link:
            path = link[0]
            kind = link[1] if len(link) > 1 else "core"
        elif isinstance(link, dict):
            path = link.get("path")
            kind = link.get("kind", "core")
        else:
            path = link
            kind = "core"
        if not path:
            continue
        label = Path(path).stem
        css_class = f"mindmap-link is-{kind}"
        block.append(f'> - <span class="{css_class}">[[{path}|{label}]]</span>')

    clean = clean.rstrip() + "\n\n---\n\n"
    return clean + "\n".join(block) + "\n"


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def resolve_config_path(raw_config_path: Optional[str]) -> Path:
    if raw_config_path:
        return Path(raw_config_path).resolve()

    cwd_candidate = Path.cwd() / "config.json"
    script_candidate = Path(__file__).resolve().parent / "config.json"
    if cwd_candidate.exists():
        return cwd_candidate.resolve()
    return script_candidate


def load_config_with_diagnostics(config_path: Path) -> Tuple[Optional[Dict], Optional[Dict]]:
    if not config_path.exists():
        return None, build_preflight_check(
            "CONFIG_MISSING",
            "Config file",
            "error",
            f"Config file not found: {config_path}",
            guidance="Create config.json from config.template.json or point --config to a valid file.",
            context={"config_path": str(config_path)},
        )
    try:
        config = load_json(config_path)
    except json.JSONDecodeError as exc:
        return None, build_preflight_check(
            "CONFIG_INVALID",
            "Config file",
            "error",
            f"Config file contains invalid JSON: {exc}",
            guidance="Fix the JSON syntax in the config file and re-run preflight.",
            context={"config_path": str(config_path)},
        )

    if not isinstance(config, dict) or not config:
        return None, build_preflight_check(
            "CONFIG_EMPTY",
            "Config file",
            "error",
            f"Config file is empty or not a JSON object: {config_path}",
            guidance="Populate the config file with the required runtime settings.",
            context={"config_path": str(config_path)},
        )

    return config, build_preflight_check(
        "CONFIG_OK",
        "Config file",
        "ok",
        f"Loaded config: {config_path}",
        context={"config_path": str(config_path)},
    )


def fetch_ollama_models(base_url: str, timeout: int) -> List[str]:
    url = base_url.rstrip("/") + "/api/tags"
    req = request.Request(url, method="GET")
    with request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    models = []
    for item in payload.get("models", []):
        if isinstance(item, dict) and item.get("name"):
            models.append(str(item["name"]))
    return models


def classify_provider_error(exc: Exception) -> Dict[str, str]:
    """Return a stable, actionable category for a provider probe failure."""
    if isinstance(exc, HTTPError):
        if exc.code in {401, 403}:
            return {
                "category": "auth_failed",
                "code": "PROVIDER_AUTH_FAILED",
                "message": f"Provider rejected the request with HTTP {exc.code}.",
                "guidance": "Check the configured API key and its environment variable.",
            }
        if exc.code == 404:
            return {
                "category": "unexpected_service",
                "code": "PROVIDER_UNEXPECTED_SERVICE",
                "message": "The configured port returned HTTP 404 for the provider model endpoint.",
                "guidance": "Check that llm_base_url points to the provider (including its /v1 path), not another service.",
            }
        return {
            "category": "unexpected_service",
            "code": "PROVIDER_UNEXPECTED_SERVICE",
            "message": f"Provider returned unexpected HTTP status {exc.code}.",
            "guidance": "Check the configured provider URL and endpoint compatibility.",
        }

    reason = getattr(exc, "reason", exc)
    reason_text = str(reason).lower()
    if isinstance(reason, (ConnectionRefusedError, ConnectionResetError)) or "connection refused" in reason_text:
        return {
            "category": "connection_refused",
            "code": "PROVIDER_CONNECTION_REFUSED",
            "message": "Connection to the provider was refused.",
            "guidance": "Start the configured provider or check its host and port.",
        }
    if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in reason_text or "timeout" in reason_text:
        return {
            "category": "timeout",
            "code": "PROVIDER_TIMEOUT",
            "message": "The provider did not respond before the preflight timeout.",
            "guidance": "Check provider startup time and increase the configured timeout only if needed.",
        }
    if "401" in reason_text or "403" in reason_text or "unauthorized" in reason_text or "forbidden" in reason_text:
        return {
            "category": "auth_failed",
            "code": "PROVIDER_AUTH_FAILED",
            "message": "Provider authentication failed.",
            "guidance": "Check the configured API key and its environment variable.",
        }
    return {
        "category": "unreachable",
        "code": "PROVIDER_UNREACHABLE",
        "message": f"Provider request failed: {exc}",
        "guidance": "Check that the configured provider is running and its URL is correct.",
    }


def is_provider_request_failure(exc: Exception) -> bool:
    """Identify a provider-wide LLM request failure from the stable diagnostic code."""
    return "[PROVIDER_REQUEST_FAILED]" in str(exc)


def can_mark_note_complete(
    tagging_enabled: bool,
    index_succeeded: bool,
    metadata_succeeded: bool = False,
    write_succeeded: bool = False,
) -> bool:
    """Return whether this run has completed all required work for a note."""
    if not index_succeeded:
        return False
    if not tagging_enabled:
        return True
    return metadata_succeeded and write_succeeded


def provider_failure_check(
    prefix: str,
    label: str,
    base_url: str,
    exc: Exception,
    context: Optional[Dict] = None,
) -> Dict:
    details = classify_provider_error(exc)
    check_context = {"base_url": base_url}
    if context:
        check_context.update(context)
    return build_preflight_check(
        f"{prefix}_{details['category'].upper()}",
        label,
        "error",
        f"{label} at {base_url}: {details['message']}",
        guidance=details["guidance"],
        context=check_context,
    )


def fetch_openai_compatible_models(base_url: str, api_key: str, timeout: int) -> List[str]:
    url = base_url.rstrip("/") + "/models"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = request.Request(url, headers=headers, method="GET")
    with request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    models = []
    for item in payload.get("data", []):
        if isinstance(item, dict) and item.get("id"):
            models.append(str(item["id"]))
    return models


def is_localhost_url(base_url: str) -> bool:
    parsed = urlparse(base_url)
    return parsed.hostname in {"localhost", "127.0.0.1", "::1"}


def openai_compatible_url_port(base_url: str, default: int = 8000) -> int:
    parsed = urlparse(base_url)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port is not None:
        return port
    if parsed.scheme == "https":
        return 443
    if parsed.scheme == "http":
        return 80
    return default


def should_manage_omlx_server(config: Dict, llm_settings: Dict) -> bool:
    raw_setting = config.get("omlx_auto_manage", "auto")
    if raw_setting is False:
        return False
    if llm_settings.get("provider") != "openai_compatible":
        return False

    base_url = str(llm_settings.get("base_url", ""))
    if not is_localhost_url(base_url):
        return False
    if raw_setting is True:
        return True

    model = str(llm_settings.get("model", "")).lower()
    return "mlx" in model or openai_compatible_url_port(base_url) == 8000


def build_omlx_server_command(config: Dict, llm_settings: Dict) -> List[str]:
    configured_command = config.get("omlx_server_command")
    if isinstance(configured_command, list) and all(isinstance(part, str) for part in configured_command):
        return configured_command
    if isinstance(configured_command, str) and configured_command.strip():
        return shlex.split(configured_command)

    base_path = Path(str(config.get("omlx_base_path", "~/.omlx"))).expanduser()
    port = int(config.get("omlx_port", openai_compatible_url_port(str(llm_settings.get("base_url", "")))))
    memory_guard = config.get("omlx_memory_guard_gb")
    if (
        isinstance(memory_guard, bool)
        or not isinstance(memory_guard, (int, float))
        or not math.isfinite(memory_guard)
        or memory_guard <= 0
    ):
        memory_guard = None

    def append_memory_guard(command: List[str]) -> List[str]:
        if memory_guard is not None:
            command.extend(["--memory-guard-gb", str(memory_guard)])
        return command

    configured_python = str(config.get("omlx_python_command", "")).strip()
    app_cli = Path("/Applications/oMLX.app/Contents/MacOS/omlx-cli")
    if app_cli.exists() and not configured_python:
        return append_memory_guard([
            str(app_cli),
            "serve",
            "--base-path",
            str(base_path),
            "--port",
            str(port),
        ])

    app_python = Path("/Applications/oMLX.app/Contents/MacOS/python3")
    if configured_python:
        python_command = configured_python
    elif app_python.exists():
        python_command = str(app_python)
    else:
        python_command = "python3"

    return append_memory_guard([
        python_command,
        "-m",
        "omlx.cli",
        "serve",
        "--base-path",
        str(base_path),
        "--port",
        str(port),
    ])


def probe_openai_compatible_server(base_url: str, api_key: str, timeout: int = 3) -> bool:
    try:
        fetch_openai_compatible_models(base_url, api_key, timeout)
        return True
    except Exception:
        return False


def probe_openai_compatible_server_error(
    base_url: str,
    api_key: str,
    timeout: int = 3,
) -> Optional[Exception]:
    try:
        fetch_openai_compatible_models(base_url, api_key, timeout)
    except Exception as exc:
        return exc
    return None


def is_managed_omlx_start_candidate(exc: Exception) -> bool:
    """Only start oMLX when the endpoint is absent or clearly the wrong service."""
    return classify_provider_error(exc)["category"] in {"connection_refused", "unexpected_service", "timeout", "unreachable"}


def is_bind_conflict_error(text: str) -> bool:
    normalized = text.lower()
    return (
        "address already in use" in normalized
        or "eaddrinuse" in normalized
        or "port" in normalized and ("already" in normalized or "occupied" in normalized or "in use" in normalized)
    )


def start_managed_omlx_server(
    config: Dict,
    llm_settings: Dict,
    log_fn: Callable[[str], None],
) -> Optional[subprocess.Popen]:
    if not should_manage_omlx_server(config, llm_settings):
        return None

    base_url = str(llm_settings.get("base_url", ""))
    api_key = str(llm_settings.get("api_key", ""))
    probe_timeout = int(config.get("omlx_probe_timeout_seconds", 3))
    probe_error = probe_openai_compatible_server_error(base_url, api_key, timeout=probe_timeout)
    if probe_error is None:
        log_fn(f"[omlx] Server already running at {base_url}; leaving it running after this run.")
        return None
    if not is_managed_omlx_start_candidate(probe_error):
        log_fn(f"[omlx] Provider responded but is not usable; leaving it running: {probe_error}")
        return None

    command = build_omlx_server_command(config, llm_settings)
    base_path = Path(str(config.get("omlx_base_path", "~/.omlx"))).expanduser()
    log_dir = base_path / "logs"
    ensure_dir(log_dir)
    log_path = log_dir / "mindmap-omlx-server.log"
    initial_log_size = log_path.stat().st_size if log_path.exists() else 0
    log_handle = log_path.open("ab")
    try:
        try:
            process = subprocess.Popen(
                command,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as exc:
            if getattr(exc, "errno", None) in {48, 98} or is_bind_conflict_error(str(exc)):
                raise RuntimeError(
                    diagnostic_line(
                        "error",
                        "OMLX_PORT_CONFLICT",
                        f"Managed oMLX could not bind its configured port: {exc}",
                        guidance="Choose an unused oMLX port or stop the service that owns it; Mindmap will not terminate unrelated processes.",
                        context={"base_url": base_url, "port": openai_compatible_url_port(base_url)},
                    )
                ) from exc
            raise
    finally:
        log_handle.close()

    log_fn(f"[omlx] Started server for this run: {' '.join(shlex.quote(part) for part in command)}")
    startup_timeout = int(config.get("omlx_startup_timeout_seconds", 45))
    started_at = time.time()
    while time.time() - started_at < startup_timeout:
        if process.poll() is not None:
            log_text = ""
            try:
                with log_path.open("rb") as current_log:
                    current_log.seek(initial_log_size)
                    log_text = current_log.read().decode("utf-8", errors="ignore")
            except OSError:
                pass
            if is_bind_conflict_error(log_text):
                raise RuntimeError(
                    diagnostic_line(
                        "error",
                        "OMLX_PORT_CONFLICT",
                        f"Managed oMLX could not bind port {openai_compatible_url_port(base_url)} because it is already occupied.",
                        guidance="Choose an unused oMLX port or stop the service that owns it; Mindmap will not terminate unrelated processes.",
                        context={"base_url": base_url, "port": openai_compatible_url_port(base_url)},
                    )
                )
            raise RuntimeError(
                diagnostic_line(
                    "error",
                    "OMLX_START_FAILED",
                    f"oMLX server exited before becoming ready with code {process.returncode}.",
                    guidance=f"Check the oMLX server log at {log_path}.",
                    context={"base_url": base_url},
                )
            )
        if probe_openai_compatible_server(base_url, api_key, timeout=probe_timeout):
            log_fn(f"[omlx] Server ready at {base_url}.")
            return process
        time.sleep(1)

    stop_managed_omlx_server(process, log_fn, reason="startup timeout")
    raise RuntimeError(
        diagnostic_line(
            "error",
            "OMLX_START_TIMEOUT",
            f"oMLX server did not become ready within {startup_timeout} seconds.",
            guidance=f"Open oMLX manually or check the server log at {log_path}.",
            context={"base_url": base_url},
        )
    )


def stop_managed_omlx_server(
    process: Optional[subprocess.Popen],
    log_fn: Callable[[str], None],
    reason: str = "run complete",
) -> None:
    if process is None or process.poll() is not None:
        return
    log_fn(f"[omlx] Stopping server started by this run ({reason}).")
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        log_fn("[omlx] Server did not stop after terminate; killing it.")
        process.kill()
        process.wait(timeout=5)


def find_missing_models(required_models: List[str], available_models: List[str]) -> List[str]:
    available = set(available_models)
    available_bases = {model.split(":", 1)[0] for model in available_models}

    missing = []
    for model in required_models:
        if not model:
            continue
        base_name = model.split(":", 1)[0]
        if model in available or base_name in available_bases:
            continue
        missing.append(model)
    return missing


def run_preflight(config_path: Path) -> Dict:
    checks = [
        build_preflight_check(
            "PYTHON_RUNTIME_OK",
            "Python runtime",
            "ok",
            f"Using Python executable: {sys.executable}",
            context={"python_executable": sys.executable},
        )
    ]

    if YAML_IMPORT_ERROR is None:
        checks.append(
            build_preflight_check(
                "DEPENDENCY_RUAMEL_OK",
                "Python dependency",
                "ok",
                "Imported ruamel.yaml successfully.",
            )
        )
    else:
        checks.append(
            build_preflight_check(
                "DEPENDENCY_RUAMEL_MISSING",
                "Python dependency",
                "error",
                f"ruamel.yaml import failed: {YAML_IMPORT_ERROR}",
                guidance=dependency_install_guidance(),
            )
        )

    try:
        import chromadb  # noqa: F401

        checks.append(
            build_preflight_check(
                "DEPENDENCY_CHROMADB_OK",
                "Python dependency",
                "ok",
                "Imported chromadb successfully.",
            )
        )
    except ModuleNotFoundError as exc:
        checks.append(
            build_preflight_check(
                "DEPENDENCY_CHROMADB_MISSING",
                "Python dependency",
                "error",
                f"chromadb import failed: {exc}",
                guidance=dependency_install_guidance(),
            )
        )

    config, config_check = load_config_with_diagnostics(config_path)
    checks.append(config_check)
    if config is None:
        ok = not any(check["status"] == "error" for check in checks)
        return {
            "ok": ok,
            "summary": "Preflight failed: config is missing or invalid.",
            "checks": checks,
            "config_path": str(config_path),
        }

    embed_settings = get_embed_settings(config)
    llm_settings = get_llm_settings(config)
    timeout = int(config.get("ollama_timeout_seconds", 120))

    missing_fields = [
        field
        for field, value in [
            ("embed_base_url", embed_settings["base_url"]),
            ("embed_model", embed_settings["model"]),
            ("llm_base_url", llm_settings["base_url"]),
            ("llm_model", llm_settings["model"]),
        ]
        if not value
    ]
    if llm_settings["api_key_env"] and not llm_settings["api_key"]:
        missing_fields.append(f"environment variable {llm_settings['api_key_env']}")

    if missing_fields:
        checks.append(
            build_preflight_check(
                "CONFIG_FIELDS_MISSING",
                "Config values",
                "error",
                f"Config is missing required values: {', '.join(missing_fields)}",
                guidance="Add the missing provider URLs, model names, or API key environment variable.",
                context={"config_path": str(config_path)},
            )
        )
    elif embed_settings["provider"] != "ollama":
        checks.append(
            build_preflight_check(
                "EMBED_PROVIDER_UNSUPPORTED",
                "Embedding provider",
                "error",
                f"Unsupported embed_provider: {embed_settings['provider']}",
                guidance="Use embed_provider `ollama`; non-Ollama embedding providers are not supported yet.",
                context={"embed_provider": embed_settings["provider"]},
            )
        )
    elif llm_settings["provider"] not in {"ollama", "openai_compatible"}:
        checks.append(
            build_preflight_check(
                "LLM_PROVIDER_UNSUPPORTED",
                "LLM provider",
                "error",
                f"Unsupported llm_provider: {llm_settings['provider']}",
                guidance="Use llm_provider `ollama` or `openai_compatible`.",
                context={"llm_provider": llm_settings["provider"]},
            )
        )
    else:
        try:
            available_models = fetch_ollama_models(embed_settings["base_url"], timeout=timeout)
            checks.append(
                build_preflight_check(
                    "EMBED_PROVIDER_REACHABLE",
                    "Embedding provider",
                    "ok",
                    f"Ollama embedding provider is reachable at {embed_settings['base_url']}.",
                    context={"provider": embed_settings["provider"], "base_url": embed_settings["base_url"]},
                )
            )
            missing_models = find_missing_models([embed_settings["model"]], available_models)
            if missing_models:
                checks.append(
                    build_preflight_check(
                        "EMBED_MODELS_MISSING",
                        "Embedding models",
                        "error",
                        f"Required models are missing: {', '.join(missing_models)}",
                        guidance="Pull the missing models with `ollama pull <model>` and re-run preflight.",
                        context={"available_models": ", ".join(available_models) or "none"},
                    )
                )
            else:
                checks.append(
                    build_preflight_check(
                        "EMBED_MODELS_OK",
                        "Embedding models",
                        "ok",
                        f"Required embedding model is available: {embed_settings['model']}",
                    )
                )
        except Exception as exc:
            checks.append(
                provider_failure_check(
                    "EMBED_PROVIDER",
                    "Embedding provider",
                    embed_settings["base_url"],
                    exc,
                    context={"provider": embed_settings["provider"]},
                )
            )

        managed_omlx_process = None
        try:
            if llm_settings["provider"] == "openai_compatible" and should_manage_omlx_server(config, llm_settings):
                managed_omlx_process = start_managed_omlx_server(
                    config,
                    llm_settings,
                    lambda message: emit_stderr("info", "OMLX", message),
                )
            if llm_settings["provider"] == "ollama":
                available_models = fetch_ollama_models(llm_settings["base_url"], timeout=timeout)
                provider_label = "Ollama LLM provider"
                guidance = "Pull the missing model with `ollama pull <model>` and re-run preflight."
            else:
                available_models = fetch_openai_compatible_models(
                    llm_settings["base_url"],
                    llm_settings["api_key"],
                    timeout=timeout,
                )
                provider_label = "OpenAI-compatible LLM provider"
                guidance = "Update llm_model or confirm the provider exposes the model from /models."
            checks.append(
                build_preflight_check(
                    "LLM_PROVIDER_REACHABLE",
                    "LLM provider",
                    "ok",
                    f"{provider_label} is reachable at {llm_settings['base_url']}.",
                    context={"provider": llm_settings["provider"], "base_url": llm_settings["base_url"]},
                )
            )
            missing_models = find_missing_models([llm_settings["model"]], available_models)
            if missing_models:
                checks.append(
                    build_preflight_check(
                        "LLM_MODELS_MISSING",
                        "LLM models",
                        "error",
                        f"Required models are missing: {', '.join(missing_models)}",
                        guidance=guidance,
                        context={"available_models": ", ".join(available_models) or "none"},
                    )
                )
            else:
                checks.append(
                    build_preflight_check(
                        "LLM_MODELS_OK",
                        "LLM models",
                        "ok",
                        f"Required LLM model is available: {llm_settings['model']}",
                    )
                )
        except Exception as exc:
            error_text = str(exc)
            if "[OMLX_PORT_CONFLICT]" in error_text:
                checks.append(
                    build_preflight_check(
                        "OMLX_PORT_CONFLICT",
                        "Managed oMLX",
                        "error",
                        error_text,
                        guidance="Choose an unused oMLX port or stop the service that owns it; Mindmap will not terminate unrelated processes.",
                        context={"base_url": llm_settings["base_url"]},
                    )
                )
            elif "[OMLX_" in error_text:
                checks.append(
                    build_preflight_check(
                        "OMLX_START_FAILED",
                        "Managed oMLX",
                        "error",
                        error_text,
                        guidance="Check the oMLX server log and configured oMLX command.",
                        context={"base_url": llm_settings["base_url"]},
                    )
                )
            else:
                checks.append(
                    provider_failure_check(
                        "LLM_PROVIDER",
                        "LLM provider",
                        llm_settings["base_url"],
                        exc,
                        context={"provider": llm_settings["provider"]},
                    )
                )
        finally:
            if managed_omlx_process is not None:
                stop_managed_omlx_server(
                    managed_omlx_process,
                    lambda message: emit_stderr("info", "OMLX", message),
                    reason="preflight complete",
                )

    ok = not any(check["status"] == "error" for check in checks)
    if ok:
        summary = "Preflight passed: Python, dependencies, providers, and required models are ready."
    else:
        first_error = next(check for check in checks if check["status"] == "error")
        summary = f"Preflight failed: {first_error['message']}"

    return {
        "ok": ok,
        "summary": summary,
        "checks": checks,
        "config_path": str(config_path),
    }


def load_runtime_context(config_path: Path) -> RuntimeContext:
    config, config_check = load_config_with_diagnostics(config_path)
    if config is None:
        raise RuntimeError(
            diagnostic_line(
                "error",
                config_check["code"],
                config_check["message"],
                guidance=config_check.get("guidance"),
                context=config_check.get("context"),
            )
        )

    vault_root = Path(config.get("vault_root", "."))
    if not vault_root.is_absolute():
        vault_root = (config_path.parent / vault_root).resolve()

    embed_settings = get_embed_settings(config)
    llm_settings = get_llm_settings(config)
    if embed_settings["provider"] != "ollama":
        raise RuntimeError(
            diagnostic_line(
                "error",
                "EMBED_PROVIDER_UNSUPPORTED",
                f"Unsupported embed_provider: {embed_settings['provider']}",
                guidance="Use embed_provider `ollama`; non-Ollama embedding providers are not supported yet.",
                context={"embed_provider": embed_settings["provider"]},
            )
        )
    if llm_settings["provider"] not in {"ollama", "openai_compatible"}:
        raise RuntimeError(
            diagnostic_line(
                "error",
                "LLM_PROVIDER_UNSUPPORTED",
                f"Unsupported llm_provider: {llm_settings['provider']}",
                guidance="Use llm_provider `ollama` or `openai_compatible`.",
                context={"llm_provider": llm_settings["provider"]},
            )
        )

    ollama_timeout = int(config.get("ollama_timeout_seconds", 120))
    paths = RuntimePaths(
        config_path=config_path,
        vault_root=vault_root,
        db_path=vault_root / config["db_path"],
        state_path=vault_root / config["state_path"],
        log_path=vault_root / config["log_path"],
        preview_path=vault_root / config.get("preview_log_path", "Scripts/_Mindmap/_logs/preview.jsonl"),
    )
    return RuntimeContext(
        config=config,
        paths=paths,
        embed_settings=embed_settings,
        llm_settings=llm_settings,
        embed_model=embed_settings["model"],
        llm_model=llm_settings["model"],
        mindmap_heading=config.get("mindmap_heading", config.get("related_heading", "## Mindmap")),
        write_mindmap_section=config.get("write_mindmap_section", config.get("write_related_section", False)),
        related_strategy=config.get("related_strategy", "chunk"),
        related_candidate_limit=config.get("related_candidate_limit", 40),
        related_overreach=config.get("related_overreach", 2),
        related_creative=config.get("related_creative", 2),
        related_creative_min=config.get("related_creative_min", 0.45),
        related_creative_max=config.get("related_creative_max", 0.7),
        ollama_embed_timeout=int(config.get("ollama_embed_timeout_seconds", ollama_timeout)),
        ollama_llm_timeout=int(config.get("ollama_llm_timeout_seconds", ollama_timeout)),
        ollama_retries=int(config.get("ollama_retries", 1)),
        ollama_backoff=float(config.get("ollama_backoff_seconds", 2.0)),
    )


def resolve_notes_paths(config: Dict, scope: str = "default") -> List[str]:
    if scope == "all" and "notes_paths_all" in config:
        return config["notes_paths_all"]
    if scope == "current" and "notes_paths_current" in config:
        return config["notes_paths_current"]
    if "notes_paths" in config:
        return config["notes_paths"]
    return [config["notes_path"]]


def open_collections(db_path: Path, rebuild: bool = False):
    try:
        import chromadb
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            diagnostic_line(
                "error",
                "DEPENDENCY_CHROMADB_MISSING",
                f"chromadb import failed: {exc}",
                guidance=dependency_install_guidance(),
            )
        ) from exc

    try:
        client = chromadb.PersistentClient(path=str(db_path))
    except Exception as exc:
        raise RuntimeError(
            diagnostic_line(
                "error",
                "CHROMADB_INIT_FAILED",
                f"Failed to initialize ChromaDB: {exc}",
                guidance="Check db_path permissions and clear any corrupted local database before retrying.",
                context={"db_path": str(db_path)},
            )
        ) from exc

    chunks_collection = "mindmap_chunks"
    notes_collection = "mindmap_notes"
    if rebuild:
        for collection_name in (chunks_collection, notes_collection):
            try:
                client.delete_collection(collection_name)
            except Exception:
                pass

    chunks = client.get_or_create_collection(name=chunks_collection, metadata={"hnsw:space": "cosine"})
    notes_col = client.get_or_create_collection(name=notes_collection, metadata={"hnsw:space": "cosine"})
    return client, chunks, notes_col


def load_note_by_relpath(vault_root: Path, relpath: str, related_heading: str, min_words: int = 0) -> Note:
    target, issue = resolve_vault_markdown_write_target(vault_root, relpath)
    if issue:
        raise RuntimeError(diagnostic_line(issue["level"], issue["code"], issue["message"], issue.get("guidance"), issue.get("context")))
    if target is None or not target.exists() or not target.is_file():
        raise RuntimeError(
            diagnostic_line(
                "error",
                "NOTE_NOT_FOUND",
                f"Note not found: {relpath}",
                guidance="Use a vault-relative Markdown path that exists.",
                context={"path": relpath},
            )
        )
    text = target.read_text(encoding="utf-8", errors="ignore")
    _fm, body = parse_frontmatter(text)
    body = strip_related_section(body, related_heading)
    if min_words and len(body.split()) < min_words:
        raise RuntimeError(
            diagnostic_line(
                "warn",
                "NOTE_TOO_SHORT",
                f"Note is below the configured minimum word count: {relpath}",
                context={"path": relpath, "min_words": min_words},
            )
        )
    return Note(path=target, relpath=target.relative_to(vault_root).as_posix(), title=target.stem, body=body)


def list_notes_from_relpaths(vault_root: Path, relpaths: List[str], min_words: int, related_heading: str) -> List[Note]:
    notes = []
    for relpath in relpaths:
        try:
            notes.append(load_note_by_relpath(vault_root, relpath, related_heading, min_words=min_words))
        except RuntimeError:
            continue
    return notes


def index_note(note: Note, chunks, notes_col, ctx: RuntimeContext, log_fn: Optional[Callable[[str], None]] = None) -> Dict:
    note_chunks = chunk_text(
        note.body,
        ctx.config["chunk_target_tokens"],
        ctx.config["chunk_overlap_tokens"],
    )
    if not note_chunks:
        return {"path": note.relpath, "indexed": False, "chunks": 0, "reason": "empty"}

    chunks.delete(where={"path": note.relpath})
    notes_col.delete(where={"path": note.relpath})

    embeddings = []
    batch_size = 16
    for i in range(0, len(note_chunks), batch_size):
        batch = note_chunks[i : i + batch_size]
        batch_embeddings = embed_texts(
            ctx.embed_settings["base_url"],
            ctx.embed_model,
            batch,
            timeout=ctx.ollama_embed_timeout,
            retries=ctx.ollama_retries,
            backoff_seconds=ctx.ollama_backoff,
            log_fn=log_fn,
        )
        embeddings.extend(batch_embeddings)

    if not embeddings:
        return {"path": note.relpath, "indexed": False, "chunks": 0, "reason": "no_embeddings"}
    if len(embeddings) != len(note_chunks):
        return {
            "path": note.relpath,
            "indexed": False,
            "chunks": 0,
            "reason": "embedding_count_mismatch",
        }

    ids = []
    metadatas = []
    documents = []
    for i, (chunk, _emb) in enumerate(zip(note_chunks, embeddings, strict=True)):
        ids.append(f"{note.relpath}::chunk::{i}")
        metadatas.append({"path": note.relpath, "chunk": i})
        documents.append(chunk)
    chunks.add(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)

    note_embedding = average_vectors(embeddings)
    notes_col.add(
        ids=[f"{note.relpath}::note"],
        embeddings=[note_embedding],
        metadatas=[{"path": note.relpath, "title": note.title}],
        documents=[note.body[:2000]],
    )
    return {"path": note.relpath, "indexed": True, "chunks": len(note_chunks), "hash": file_signature(note.body)}


def delete_note_from_index(relpath: str, chunks, notes_col, state_files: Dict) -> Dict:
    chunks.delete(where={"path": relpath})
    notes_col.delete(where={"path": relpath})
    state_files.pop(relpath, None)
    return {"path": relpath, "deleted": True}


def note_is_indexed(notes_col, relpath: str) -> bool:
    data = notes_col.get(ids=[f"{relpath}::note"])
    return bool(data.get("ids"))


def query_related_for_note(
    note: Note,
    chunks,
    notes_col,
    ctx: RuntimeContext,
    allowed_paths: set,
    log_fn: Optional[Callable[[str], None]] = None,
) -> List[Dict]:
    if ctx.related_strategy == "chunk":
        candidates = related_from_chunks(
            chunks,
            note.relpath,
            ctx.related_candidate_limit,
            ctx.config.get("related_min_score", 0.0),
        )
        candidates = [(p, s) for p, s in candidates if p in allowed_paths]
    else:
        note_id = f"{note.relpath}::note"
        data = notes_col.get(ids=[note_id], include=["embeddings", "metadatas"])
        embeddings = data.get("embeddings")
        if embeddings is None or (hasattr(embeddings, "size") and embeddings.size == 0) or len(embeddings) == 0:
            embedded = embed_texts(
                ctx.embed_settings["base_url"],
                ctx.embed_model,
                [note.body[:4000]],
                timeout=ctx.ollama_embed_timeout,
                retries=ctx.ollama_retries,
                backoff_seconds=ctx.ollama_backoff,
                log_fn=log_fn,
            )
            note_embedding = embedded[0]
        else:
            note_embedding = embeddings[0]
        results = notes_col.query(
            query_embeddings=[note_embedding],
            n_results=max(10, ctx.config["related_limit"] + 1),
            include=["metadatas", "distances"],
        )
        candidates = []
        metas = results.get("metadatas", [[]])[0]
        dists = results.get("distances", [[]])[0] if results.get("distances") else [None] * len(metas)
        for meta, dist in zip(metas, dists):
            path = meta.get("path")
            if path and path != note.relpath and path in allowed_paths:
                score = 1 - dist if dist is not None else 0.0
                if score >= ctx.config.get("related_min_score", 0.0):
                    candidates.append((path, score))

    score_by_path = {path: score for path, score in candidates}
    selected = select_mindmap_links(
        candidates,
        note.relpath,
        ctx.config["related_limit"],
        ctx.related_overreach,
        ctx.related_creative,
        ctx.related_creative_min,
        ctx.related_creative_max,
    )
    return [
        {
            "path": path,
            "score": score_by_path.get(path, 0.0),
            "kind": kind,
            "title": Path(path).stem,
        }
        for path, kind in selected
    ]


def query_related_for_text(
    query: str,
    chunks,
    notes_col,
    ctx: RuntimeContext,
    allowed_paths: set,
    limit: Optional[int] = None,
    log_fn: Optional[Callable[[str], None]] = None,
) -> List[Dict]:
    query_text = query.strip()
    if not query_text:
        return []

    result_limit = max(1, int(limit or ctx.config.get("related_limit", 8)))
    candidate_limit = max(result_limit * 4, ctx.related_candidate_limit)
    query_embedding = embed_texts(
        ctx.embed_settings["base_url"],
        ctx.embed_model,
        [query_text[:4000]],
        timeout=ctx.ollama_embed_timeout,
        retries=ctx.ollama_retries,
        backoff_seconds=ctx.ollama_backoff,
        log_fn=log_fn,
    )[0]

    results = chunks.query(
        query_embeddings=[query_embedding],
        n_results=candidate_limit,
        include=["metadatas", "distances"],
    )
    scores: Dict[str, float] = {}
    metas = results.get("metadatas", [[]])[0]
    dists = results.get("distances", [[]])[0] if results.get("distances") else [None] * len(metas)
    for meta, dist in zip(metas, dists, strict=True):
        path = meta.get("path") if isinstance(meta, dict) else None
        if not path or path not in allowed_paths:
            continue
        score = 1 - dist if dist is not None else 0.0
        if score < ctx.config.get("related_min_score", 0.0):
            continue
        if path not in scores or score > scores[path]:
            scores[path] = score

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:result_limit]
    return [
        {
            "path": path,
            "score": score,
            "kind": "lookup",
            "title": Path(path).stem,
        }
        for path, score in ranked
    ]


def main():
    parser = argparse.ArgumentParser(description="Local knowledge maintenance for Obsidian notes")
    parser.add_argument("--config", default=None, help="Config path")
    parser.add_argument("--preflight", action="store_true", help="Validate config, dependencies, Ollama, and model availability")
    parser.add_argument("--index", action="store_true", help="Build embeddings index")
    parser.add_argument("--tag", action="store_true", help="Generate tags/concepts/summary")
    parser.add_argument("--apply", action="store_true", help="Write changes to notes")
    parser.add_argument("--refresh-all", action="store_true", help="Regenerate metadata for all notes")
    parser.add_argument("--limit", type=int, help="Limit number of notes processed")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild vector DB")
    parser.add_argument("--preview", action="store_true", help="Log generated metadata JSON")
    parser.add_argument("--apply-preview", action="store_true", help="Apply the last preview.jsonl to notes")
    parser.add_argument("--quiet", action="store_true", help="Reduce progress output")
    scope_group = parser.add_mutually_exclusive_group()
    scope_group.add_argument("--current", action="store_true", help="Use current scope folders from config")
    scope_group.add_argument("--all", action="store_true", help="Use all scope folders from config")

    args = parser.parse_args()
    config_path = resolve_config_path(args.config)

    if args.preflight:
        result = run_preflight(config_path)
        print(json.dumps(result, ensure_ascii=True))
        return 0 if result["ok"] else 1

    config, config_check = load_config_with_diagnostics(config_path)
    if config is None:
        emit_stderr(
            "error",
            config_check["code"],
            config_check["message"],
            guidance=config_check.get("guidance"),
            context=config_check.get("context"),
        )
        return 1

    vault_root = Path(config.get("vault_root", "."))
    if not vault_root.is_absolute():
        vault_root = (config_path.parent / vault_root).resolve()
    # Scope selection
    if args.all and "notes_paths_all" in config:
        notes_paths = config["notes_paths_all"]
    elif args.current and "notes_paths_current" in config:
        notes_paths = config["notes_paths_current"]
    elif "notes_paths" in config:
        notes_paths = config["notes_paths"]
    else:
        notes_paths = [config["notes_path"]]
    db_path = vault_root / config["db_path"]
    state_path = vault_root / config["state_path"]
    log_path = vault_root / config["log_path"]
    preview_path = vault_root / config.get("preview_log_path", "Scripts/_Mindmap/_logs/preview.jsonl")

    embed_settings = get_embed_settings(config)
    llm_settings = get_llm_settings(config)
    if embed_settings["provider"] != "ollama":
        emit_stderr(
            "error",
            "EMBED_PROVIDER_UNSUPPORTED",
            f"Unsupported embed_provider: {embed_settings['provider']}",
            guidance="Use embed_provider `ollama`; non-Ollama embedding providers are not supported yet.",
            context={"embed_provider": embed_settings["provider"]},
        )
        return 1
    if llm_settings["provider"] not in {"ollama", "openai_compatible"}:
        emit_stderr(
            "error",
            "LLM_PROVIDER_UNSUPPORTED",
            f"Unsupported llm_provider: {llm_settings['provider']}",
            guidance="Use llm_provider `ollama` or `openai_compatible`.",
            context={"llm_provider": llm_settings["provider"]},
        )
        return 1
    embed_model = embed_settings["model"]
    llm_model = llm_settings["model"]
    mindmap_heading = config.get("mindmap_heading", config.get("related_heading", "## Mindmap"))
    write_mindmap_section = config.get("write_mindmap_section", config.get("write_related_section", False))
    controlled_tags_path = config.get("controlled_tags_path")
    tag_aliases_path = config.get("tag_aliases_path")
    allow_free_tags = config.get("allow_free_tags", True)
    min_tag_length = config.get("min_tag_length", 2)
    tag_max_words = config.get("tag_max_words", 3)
    min_tag_frequency = config.get("min_tag_frequency", 1)
    tag_frequency_fallback = config.get("tag_frequency_fallback", 1)
    concept_case = config.get("concept_case", "keep")
    related_strategy = config.get("related_strategy", "chunk")
    related_candidate_limit = config.get("related_candidate_limit", 40)
    related_overreach = config.get("related_overreach", 2)
    related_creative = config.get("related_creative", 2)
    related_creative_min = config.get("related_creative_min", 0.45)
    related_creative_max = config.get("related_creative_max", 0.7)
    apply_per_note = config.get("apply_per_note", True)
    ollama_timeout = int(config.get("ollama_timeout_seconds", 120))
    ollama_retries = int(config.get("ollama_retries", 1))
    ollama_backoff = float(config.get("ollama_backoff_seconds", 2.0))
    ollama_embed_timeout = int(config.get("ollama_embed_timeout_seconds", ollama_timeout))
    ollama_llm_timeout = int(config.get("ollama_llm_timeout_seconds", ollama_timeout))

    if args.apply_preview:
        preview_path = vault_root / config.get("preview_log_path", "Scripts/_Mindmap/_logs/preview.jsonl")
        if not preview_path.exists():
            emit_stderr(
                "error",
                "PREVIEW_MISSING",
                f"Preview file not found: {preview_path}",
                guidance="Run with --preview first or update preview_log_path in the config.",
                context={"preview_path": str(preview_path)},
            )
            return 1

        items = []
        for line in preview_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError as exc:
                emit_stderr(
                    "warn",
                    "PREVIEW_LINE_INVALID",
                    f"Skipping invalid preview line: {exc}",
                    context={"preview_path": str(preview_path)},
                )

        if not items:
            emit_stderr(
                "error",
                "PREVIEW_EMPTY",
                "No preview entries found.",
                guidance="Re-run with --preview before applying preview results.",
                context={"preview_path": str(preview_path)},
            )
            return 1

        log_lines = []
        for entry_index, entry in enumerate(items, start=1):
            file_path, issue = validate_preview_entry(entry, vault_root, entry_index)
            if issue:
                issue_context = dict(issue.get("context", {}))
                issue_context["preview_path"] = str(preview_path)
                emit_stderr(
                    issue["level"],
                    issue["code"],
                    issue["message"],
                    guidance=issue.get("guidance"),
                    context=issue_context,
                )
                log_lines.append(f"[skip] {issue['code']}: {entry.get('path', '<missing>') if isinstance(entry, dict) else '<invalid>'}")
                continue

            relpath = entry["path"]
            updates = {
                "summary": entry.get("summary", ""),
                "tags": entry.get("tags", []),
                "concepts": entry.get("concepts", []),
                "related": entry.get("related", []),
            }

            try:
                original = file_path.read_text(encoding="utf-8", errors="ignore")
                updated = update_frontmatter(original, updates, config["frontmatter_keys"])
                if write_mindmap_section:
                    updated = update_related_section(updated, mindmap_heading, updates["related"])
                else:
                    updated = strip_related_section(updated, mindmap_heading)
                file_path.write_text(updated, encoding="utf-8")
                log_lines.append(f"Applied preview: {relpath}")
            except Exception as exc:
                emit_stderr(
                    "warn",
                    "PREVIEW_APPLY_FAILED",
                    f"Skipping preview entry due to write failure: {exc}",
                    guidance="Fix the note or frontmatter format for this entry, then re-run --apply-preview.",
                    context={"entry_index": entry_index, "path": relpath, "preview_path": str(preview_path)},
                )
                log_lines.append(f"[error] PREVIEW_APPLY_FAILED: {relpath}")

        ensure_dir(log_path.parent)
        log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
        print("Applied preview to notes.")
        print(f"Log: {log_path}")
        return 0

    do_index = args.index or (not args.index and not args.tag)
    do_tag = args.tag or (not args.index and not args.tag)

    notes = list_notes(
        vault_root,
        notes_paths,
        config.get("min_note_words", 30),
        mindmap_heading,
    )
    allowed_paths = {n.relpath for n in notes}
    if args.limit:
        notes = notes[: args.limit]

    if not notes:
        print("No notes found.")
        return 0

    state = load_json(state_path, default={"files": {}})
    state_files = state.get("files", {})
    controlled_tags = []
    if controlled_tags_path:
        ctl_path = Path(controlled_tags_path)
        if not ctl_path.is_absolute():
            ctl_path = (config_path.parent / ctl_path).resolve()
        if ctl_path.exists():
            try:
                controlled_tags = json.loads(ctl_path.read_text(encoding="utf-8"))
            except Exception as exc:
                emit_stderr(
                    "warn",
                    "CONTROLLED_TAGS_INVALID",
                    f"Failed to load controlled tags: {exc}",
                    guidance="Fix the JSON file or remove controlled_tags_path from the config.",
                    context={"controlled_tags_path": str(ctl_path)},
                )
                controlled_tags = []
    tag_aliases = {}
    if tag_aliases_path:
        alias_path = Path(tag_aliases_path)
        if not alias_path.is_absolute():
            alias_path = (config_path.parent / alias_path).resolve()
        tag_aliases = load_tag_aliases(alias_path)

    # Initialize Chroma
    try:
        import chromadb
    except ModuleNotFoundError as exc:
        emit_stderr(
            "error",
            "DEPENDENCY_CHROMADB_MISSING",
            f"chromadb import failed: {exc}",
            guidance=dependency_install_guidance(),
        )
        return 1

    try:
        client = chromadb.PersistentClient(path=str(db_path))
    except Exception as exc:
        emit_stderr(
            "error",
            "CHROMADB_INIT_FAILED",
            f"Failed to initialize ChromaDB: {exc}",
            guidance="Check db_path permissions and clear any corrupted local database before retrying.",
            context={"db_path": str(db_path)},
        )
        return 1
    chunks_collection = "mindmap_chunks"
    notes_collection = "mindmap_notes"

    if args.rebuild:
        try:
            client.delete_collection(chunks_collection)
        except Exception:
            pass
        try:
            client.delete_collection(notes_collection)
        except Exception:
            pass

    chunks = client.get_or_create_collection(name=chunks_collection, metadata={"hnsw:space": "cosine"})
    notes_col = client.get_or_create_collection(name=notes_collection, metadata={"hnsw:space": "cosine"})

    log_lines = []
    preview_lines = []
    changed_notes = []
    index_failed_paths = set()
    run_failed = False
    provider_failure = False

    def log_event(line: str, also_print: bool = True, to_stderr: bool = False):
        log_lines.append(line)
        if not args.quiet and also_print:
            stream = sys.stderr if to_stderr else sys.stdout
            print(line, file=stream, flush=True)

    managed_omlx_process: Optional[subprocess.Popen] = None

    def cleanup_managed_omlx(reason: str = "run complete"):
        nonlocal managed_omlx_process
        if managed_omlx_process is None:
            return
        stop_managed_omlx_server(managed_omlx_process, log_event, reason=reason)
        managed_omlx_process = None

    if do_tag:
        try:
            managed_omlx_process = start_managed_omlx_server(config, llm_settings, log_event)
            if managed_omlx_process is not None:
                atexit.register(
                    stop_managed_omlx_server,
                    managed_omlx_process,
                    lambda line: print(line, file=sys.stderr, flush=True),
                    "process exit",
                )
        except Exception as exc:
            log_event(f"[error] oMLX startup failed: {exc}", to_stderr=True)
            ensure_dir(log_path.parent)
            log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
            return 1

    def write_note_update(note: Note, updates: Dict, related_items: List = None) -> bool:
        target_path, issue = resolve_vault_markdown_write_target(vault_root, note.relpath)
        if issue:
            issue_context = dict(issue.get("context", {}))
            issue_context["note"] = note.relpath
            raise RuntimeError(
                diagnostic_line(
                    issue["level"],
                    issue["code"],
                    issue["message"],
                    guidance=issue.get("guidance"),
                    context=issue_context,
                )
            )

        original = target_path.read_text(encoding="utf-8", errors="ignore")
        updated = update_frontmatter(original, updates, config["frontmatter_keys"])
        if write_mindmap_section:
            links = related_items or updates.get("related", [])
            updated = update_related_section(updated, mindmap_heading, links)
        else:
            updated = strip_related_section(updated, mindmap_heading)
        if updated != original:
            target_path.write_text(updated, encoding="utf-8")
            return True
        return False

    def refresh_state_for_note(note: Note) -> bool:
        try:
            text = note.path.read_text(encoding="utf-8", errors="ignore")
            _fm, body = parse_frontmatter(text)
            body = strip_related_section(body, mindmap_heading)
            state_files[note.relpath] = {"hash": file_signature(body)}
            return True
        except Exception as exc:
            log_event(
                diagnostic_line(
                    "warn",
                    "STATE_REFRESH_FAILED",
                    f"Failed to refresh note state: {exc}",
                    context={"note": note.relpath},
                ),
                to_stderr=True,
            )
            return False

    for note in notes:
        content_hash = file_signature(note.body)
        prev = state_files.get(note.relpath)
        if prev and prev.get("hash") == content_hash:
            continue
        changed_notes.append((note, content_hash))
    changed_paths = {note.relpath for note, _ in changed_notes}

    # Clean up removed notes
    current_paths = {n.relpath for n in notes}
    removed_paths = [p for p in state_files.keys() if p not in current_paths]
    if removed_paths:
        for path in removed_paths:
            chunks.delete(where={"path": path})
            notes_col.delete(where={"path": path})
        for path in removed_paths:
            state_files.pop(path, None)
        log_lines.append(f"Removed {len(removed_paths)} notes from index")

    # Indexing
    if do_index:
        notes_to_index = changed_notes
        if args.refresh_all:
            notes_to_index = [(n, file_signature(n.body)) for n in notes]
        elif notes_col.count() == 0:
            notes_to_index = [(n, file_signature(n.body)) for n in notes]

        total_index = len(notes_to_index)
        for idx, (note, content_hash) in enumerate(notes_to_index, start=1):
            if not args.quiet:
                print(f"[index] {idx}/{total_index} {note.relpath}", flush=True)
            note_chunks = chunk_text(
                note.body,
                config["chunk_target_tokens"],
                config["chunk_overlap_tokens"],
            )
            if not note_chunks:
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(f"[error] Skipping {note.relpath}: no indexable chunks", to_stderr=True)
                continue

            # Delete existing entries
            try:
                chunks.delete(where={"path": note.relpath})
                notes_col.delete(where={"path": note.relpath})
            except Exception as exc:
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(f"[error] Failed to clear index entries for {note.relpath}: {exc}", to_stderr=True)
                continue

            # Embed chunks in batches
            embeddings = []
            batch_size = 16
            for i in range(0, len(note_chunks), batch_size):
                batch = note_chunks[i : i + batch_size]
                try:
                    batch_embeddings = embed_texts(
                        embed_settings["base_url"],
                        embed_model,
                        batch,
                        timeout=ollama_embed_timeout,
                        retries=ollama_retries,
                        backoff_seconds=ollama_backoff,
                        log_fn=log_event,
                    )
                except Exception as exc:
                    index_failed_paths.add(note.relpath)
                    run_failed = True
                    log_event(f"[error] Embedding failed for {note.relpath}: {exc}", to_stderr=True)
                    embeddings = []
                    break
                embeddings.extend(batch_embeddings)
            if not embeddings:
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(f"[warn] Skipping {note.relpath}: no embeddings", to_stderr=True)
                continue
            if len(embeddings) != len(note_chunks):
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(
                    f"[warn] Skipping {note.relpath}: embedding count mismatch "
                    f"({len(embeddings)} embeddings for {len(note_chunks)} chunks)",
                    to_stderr=True,
                )
                continue

            # Store chunks
            ids = []
            metadatas = []
            documents = []
            for i, (chunk, emb) in enumerate(zip(note_chunks, embeddings, strict=True)):
                ids.append(f"{note.relpath}::chunk::{i}")
                metadatas.append({"path": note.relpath, "chunk": i})
                documents.append(chunk)
            try:
                chunks.add(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
            except Exception as exc:
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(f"[error] Failed to store chunks for {note.relpath}: {exc}", to_stderr=True)
                continue

            # Store note-level embedding
            note_embedding = average_vectors(embeddings)
            try:
                notes_col.add(
                    ids=[f"{note.relpath}::note"],
                    embeddings=[note_embedding],
                    metadatas=[{"path": note.relpath, "title": note.title}],
                    documents=[note.body[:2000]],
                )
            except Exception as exc:
                index_failed_paths.add(note.relpath)
                run_failed = True
                log_event(f"[error] Failed to store note embedding for {note.relpath}: {exc}", to_stderr=True)
                continue

            # A combined index/tag run must leave completion state to the tag
            # phase. Index-only runs retain the historical behavior.
            if can_mark_note_complete(
                tagging_enabled=do_tag,
                index_succeeded=note.relpath not in index_failed_paths,
            ):
                state_files[note.relpath] = {"hash": content_hash}
            log_lines.append(f"Indexed: {note.relpath} ({len(note_chunks)} chunks)")

    # Tagging + linking
    if do_tag:
        staged = []
        staged_write_ok = {}
        total_tag = len(notes)
        for idx, note in enumerate(notes, start=1):
            content_hash = file_signature(note.body)
            if note.relpath not in changed_paths and not args.refresh_all:
                continue
            if note.relpath in index_failed_paths:
                log_event(
                    f"[error] Skipping metadata for {note.relpath}: indexing failed; note remains pending.",
                    to_stderr=True,
                )
                continue
            if not args.quiet:
                print(f"[tag] {idx}/{total_tag} {note.relpath}", flush=True)

            # Similar notes
            related = []
            try:
                if related_strategy == "chunk":
                    candidates = related_from_chunks(
                        chunks,
                        note.relpath,
                        related_candidate_limit,
                        config.get("related_min_score", 0.0),
                    )
                    candidates = [(p, s) for p, s in candidates if p in allowed_paths]
                else:
                    note_id = f"{note.relpath}::note"
                    data = notes_col.get(ids=[note_id], include=["embeddings", "metadatas"])
                    embeddings = data.get("embeddings")
                    if embeddings is None or (hasattr(embeddings, "size") and embeddings.size == 0) or len(embeddings) == 0:
                        # Embed on the fly if missing
                        embedded = embed_texts(
                            embed_settings["base_url"],
                            embed_model,
                            [note.body[:4000]],
                            timeout=ollama_embed_timeout,
                            retries=ollama_retries,
                            backoff_seconds=ollama_backoff,
                            log_fn=log_event,
                        )
                        note_embedding = embedded[0]
                    else:
                        note_embedding = embeddings[0]
                    results = notes_col.query(
                        query_embeddings=[note_embedding],
                        n_results=max(10, config["related_limit"] + 1),
                        include=["metadatas", "distances"],
                    )
                    candidates = []
                    metas = results.get("metadatas", [[]])[0]
                    dists = results.get("distances", [[]])[0] if results.get("distances") else [None] * len(metas)
                    for meta, dist in zip(metas, dists):
                        path = meta.get("path")
                        if path and path != note.relpath:
                            if dist is not None:
                                score = 1 - dist
                                if score < config.get("related_min_score", 0.0):
                                    continue
                            else:
                                score = 0.0
                            if path in allowed_paths:
                                candidates.append((path, score))

                related_items = select_mindmap_links(
                    candidates,
                    note.relpath,
                    config["related_limit"],
                    related_overreach,
                    related_creative,
                    related_creative_min,
                    related_creative_max,
                )
                related = [path for path, _kind in related_items]
                if not args.quiet:
                    print(f"[related] {note.relpath} -> {len(related)}/{config['related_limit']}", flush=True)
            except Exception as exc:
                log_event(f"[warn] Related selection failed for {note.relpath}: {exc}", to_stderr=True)
                related_items = []
                related = []

            # LLM metadata
            try:
                metadata = llm_extract(
                    llm_settings["base_url"],
                    llm_model,
                    note.body,
                    config["tag_limit"],
                    config["concept_limit"],
                    controlled_tags,
                    allow_free_tags,
                    timeout=ollama_llm_timeout,
                    retries=ollama_retries,
                    backoff_seconds=ollama_backoff,
                    log_fn=log_event,
                    provider=llm_settings["provider"],
                    api_key=llm_settings["api_key"],
                    max_tokens=llm_settings["max_tokens"],
                    chat_template_kwargs=llm_settings["chat_template_kwargs"],
                )
            except Exception as exc:
                run_failed = True
                log_event(f"[error] Metadata extraction failed for {note.relpath}: {exc}", to_stderr=True)
                if is_provider_request_failure(exc):
                    provider_failure = True
                    break
                continue

            summary = metadata.get("summary", "").strip()
            raw_tags = normalize_list_field(metadata.get("tags"))
            tags = normalize_tags(raw_tags)
            tags = apply_tag_aliases(tags, tag_aliases)
            tags = filter_and_map_tags(tags, controlled_tags, allow_free_tags, min_tag_length, tag_max_words)[: config["tag_limit"]]
            raw_concepts = normalize_list_field(metadata.get("concepts"))
            concepts = normalize_concepts(
                raw_concepts,
                config["concept_limit"],
                config.get("concept_max_words", 4),
                concept_case,
            )

            staged.append({
                "note": note,
                "summary": summary,
                "tags": tags,
                "concepts": concepts,
                "related": related,
                "related_items": related_items,
            })

            if args.preview:
                preview = {
                    "path": note.relpath,
                    "summary": summary,
                    "tags": tags,
                    "concepts": concepts,
                    "related": related,
                }
                preview_lines.append(json.dumps(preview, ensure_ascii=True))

            if args.apply and apply_per_note:
                staged_write_ok[note.relpath] = False
                updates = {
                    "summary": summary,
                    "tags": tags,
                    "concepts": concepts,
                    "related": related,
                }
                try:
                    changed = write_note_update(note, updates, related_items)
                    staged_write_ok[note.relpath] = True
                    state = "Updated" if changed else "Unchanged"
                    log_event(f"[write] {state}: {note.relpath}")
                except Exception as exc:
                    run_failed = True
                    log_event(f"[error] Write failed for {note.relpath}: {exc}", to_stderr=True)

        # Apply tag frequency filtering across the staged set
        if staged:
            tag_sets = [s["tags"] for s in staged]
            if min_tag_frequency > 1:
                filtered_sets = apply_tag_frequency_filter(tag_sets, min_tag_frequency, tag_frequency_fallback)
            else:
                filtered_sets = tag_sets
            for item, filtered in zip(staged, filtered_sets):
                item["tags_filtered"] = filtered

        for item in staged:
            note = item["note"]
            final_tags = item.get("tags_filtered", item["tags"])
            updates = {
                "summary": item["summary"],
                "tags": final_tags,
                "concepts": item["concepts"],
                "related": item["related"],
            }

            if args.apply:
                if apply_per_note and final_tags == item["tags"]:
                    if staged_write_ok.get(note.relpath) and can_mark_note_complete(
                        tagging_enabled=do_tag,
                        index_succeeded=note.relpath not in index_failed_paths,
                        metadata_succeeded=True,
                        write_succeeded=True,
                    ):
                        if not refresh_state_for_note(note):
                            run_failed = True
                    continue
                try:
                    changed = write_note_update(note, updates, item.get("related_items"))
                    if can_mark_note_complete(
                        tagging_enabled=do_tag,
                        index_succeeded=note.relpath not in index_failed_paths,
                        metadata_succeeded=True,
                        write_succeeded=True,
                    ) and not refresh_state_for_note(note):
                        run_failed = True
                    state = "Updated" if changed else "Unchanged"
                    log_event(f"[write] {state}: {note.relpath}")
                except Exception as exc:
                    run_failed = True
                    log_event(f"[error] Write failed for {note.relpath}: {exc}", to_stderr=True)
            else:
                log_event(f"[dry-run] Would update metadata: {note.relpath}", also_print=False)

    cleanup_managed_omlx("provider failure" if provider_failure else "run complete")

    ensure_dir(log_path.parent)
    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    if args.preview and preview_lines:
        ensure_dir(preview_path.parent)
        preview_path.write_text("\n".join(preview_lines) + "\n", encoding="utf-8")

    print("Run completed with errors." if run_failed else "Run complete.")
    print(f"Log: {log_path}")
    if not args.apply:
        print("No note changes were made. Re-run with --apply to write updates.")

    save_json(state_path, {"files": state_files})
    return 1 if run_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
