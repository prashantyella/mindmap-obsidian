#!/usr/bin/env python3
"""Local knowledge maintenance for Obsidian notes using Ollama + ChromaDB.

Default scope comes from config.json. Designed to be safe: no note changes unless --apply.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
import difflib
from io import StringIO
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Callable
from urllib import request

from ruamel.yaml import YAML


@dataclass
class Note:
    path: Path
    relpath: str
    title: str
    body: str


def load_json(path: Path, default=None):
    if not path.exists():
        return default if default is not None else {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def make_yaml_round_trip() -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.width = 4096
    yaml.indent(mapping=2, sequence=4, offset=2)
    return yaml


def make_yaml_safe() -> YAML:
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

    last_err = None
    attempts = max(1, retries + 1)
    for attempt in range(1, attempts + 1):
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:
            last_err = exc
            if log_fn:
                log_fn(f"[warn] Ollama request failed (attempt {attempt}/{attempts}): {exc}")
            if attempt < attempts:
                time.sleep(backoff_seconds * attempt)

    raise RuntimeError(f"Ollama request failed after {attempts} attempts: {last_err}")


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
) -> Dict:
    system = (
        "You label personal reflection notes. Return only JSON. "
        "Use concise, grounded language."
    )
    tag_rule = "Tags must be short, broad themes derived from the note (avoid overly specific phrases)."
    if controlled_tags:
        tag_rule += " Use only tags from this list:\n" + ", ".join(controlled_tags)
        if not allow_free_tags:
            tag_rule += "\nReturn only tags from the list."
    user = (
        "Extract metadata from the note.\n"
        f"Return JSON with keys: summary (1-2 sentences), tags (3-{tag_limit} kebab-case), "
        f"concepts (3-{concept_limit} core noun phrases).\n"
        "Rules:\n"
        f"- {tag_rule}\n"
        "- Tags must be lowercase kebab-case, no single letters, 1–3 words.\n"
        "- Concepts should be the core ideas only (no fluff).\n\n"
        "Note:\n" + text.strip()
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
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
    content = resp.get("message", {}).get("content", "")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Try to salvage JSON from response
        start = content.find("{")
        end = content.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(content[start : end + 1])
        raise


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

    # Graph lens shortcut (local graph)
    block.append('> [◎](obsidian://command?name=graph:open-local-graph)')

    clean = clean.rstrip() + "\n\n---\n\n"
    return clean + "\n".join(block) + "\n"


def ensure_dir(path: Path):
    path.mkdir(parents=True, exist_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Local knowledge maintenance for Obsidian notes")
    parser.add_argument("--config", default=None, help="Config path")
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

    if args.config:
        config_path = Path(args.config).resolve()
    else:
        # Try current working dir first, then script directory
        cwd_candidate = Path.cwd() / "config.json"
        script_candidate = Path(__file__).resolve().parent / "config.json"
        if cwd_candidate.exists():
            config_path = cwd_candidate.resolve()
        else:
            config_path = script_candidate
    config = load_json(config_path)
    if not config:
        print(f"Config not found: {config_path}")
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

    embed_model = config["embed_model"]
    llm_model = config["llm_model"]
    mindmap_heading = config.get("mindmap_heading", config.get("related_heading", "## Mindmap"))
    write_mindmap_section = config.get("write_mindmap_section", config.get("write_related_section", True))
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
            print(f"Preview file not found: {preview_path}")
            return 1

        items = []
        for line in preview_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue

        if not items:
            print("No preview entries found.")
            return 1

        log_lines = []
        for entry in items:
            relpath = entry.get("path")
            if not relpath:
                continue
            file_path = vault_root / relpath
            if not file_path.exists():
                log_lines.append(f"[skip] Missing: {relpath}")
                continue

            updates = {
                "summary": entry.get("summary", ""),
                "tags": entry.get("tags", []),
                "concepts": entry.get("concepts", []),
                "related": entry.get("related", []),
            }

            original = file_path.read_text(encoding="utf-8", errors="ignore")
            updated = update_frontmatter(original, updates, config["frontmatter_keys"])
            if write_mindmap_section:
                updated = update_related_section(updated, mindmap_heading, updates["related"])
            file_path.write_text(updated, encoding="utf-8")
            log_lines.append(f"Applied preview: {relpath}")

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
            except Exception:
                controlled_tags = []
    tag_aliases = {}
    if tag_aliases_path:
        alias_path = Path(tag_aliases_path)
        if not alias_path.is_absolute():
            alias_path = (config_path.parent / alias_path).resolve()
        tag_aliases = load_tag_aliases(alias_path)

    # Initialize Chroma
    import chromadb

    client = chromadb.PersistentClient(path=str(db_path))
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

    def log_event(line: str, also_print: bool = True, to_stderr: bool = False):
        log_lines.append(line)
        if not args.quiet and also_print:
            stream = sys.stderr if to_stderr else sys.stdout
            print(line, file=stream, flush=True)

    def write_note_update(note: Note, updates: Dict, related_items: List = None) -> bool:
        original = note.path.read_text(encoding="utf-8", errors="ignore")
        updated = update_frontmatter(original, updates, config["frontmatter_keys"])
        if write_mindmap_section:
            links = related_items or updates.get("related", [])
            updated = update_related_section(updated, mindmap_heading, links)
        if updated != original:
            note.path.write_text(updated, encoding="utf-8")
            return True
        return False

    def refresh_state_for_note(note: Note):
        try:
            text = note.path.read_text(encoding="utf-8", errors="ignore")
            _fm, body = parse_frontmatter(text)
            body = strip_related_section(body, mindmap_heading)
            state_files[note.relpath] = {"hash": file_signature(body)}
        except Exception:
            pass

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
                continue

            # Delete existing entries
            chunks.delete(where={"path": note.relpath})
            notes_col.delete(where={"path": note.relpath})

            # Embed chunks in batches
            embeddings = []
            batch_size = 16
            for i in range(0, len(note_chunks), batch_size):
                batch = note_chunks[i : i + batch_size]
                try:
                    batch_embeddings = embed_texts(
                        config["ollama_base_url"],
                        embed_model,
                        batch,
                        timeout=ollama_embed_timeout,
                        retries=ollama_retries,
                        backoff_seconds=ollama_backoff,
                        log_fn=log_event,
                    )
                except Exception as exc:
                    log_event(f"[error] Embedding failed for {note.relpath}: {exc}", to_stderr=True)
                    embeddings = []
                    break
                embeddings.extend(batch_embeddings)
            if not embeddings:
                log_event(f"[warn] Skipping {note.relpath}: no embeddings", to_stderr=True)
                continue

            # Store chunks
            ids = []
            metadatas = []
            documents = []
            for i, (chunk, emb) in enumerate(zip(note_chunks, embeddings)):
                ids.append(f"{note.relpath}::chunk::{i}")
                metadatas.append({"path": note.relpath, "chunk": i})
                documents.append(chunk)
            chunks.add(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)

            # Store note-level embedding
            note_embedding = average_vectors(embeddings)
            notes_col.add(
                ids=[f"{note.relpath}::note"],
                embeddings=[note_embedding],
                metadatas=[{"path": note.relpath, "title": note.title}],
                documents=[note.body[:2000]],
            )

            state_files[note.relpath] = {"hash": content_hash}
            log_lines.append(f"Indexed: {note.relpath} ({len(note_chunks)} chunks)")

    # Tagging + linking
    if do_tag:
        staged = []
        total_tag = len(notes)
        for idx, note in enumerate(notes, start=1):
            content_hash = file_signature(note.body)
            if note.relpath not in changed_paths and not args.refresh_all:
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
                            config["ollama_base_url"],
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
                    config["ollama_base_url"],
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
                )
            except Exception as exc:
                log_event(f"[error] Metadata extraction failed for {note.relpath}: {exc}", to_stderr=True)
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
                updates = {
                    "summary": summary,
                    "tags": tags,
                    "concepts": concepts,
                    "related": related,
                }
                try:
                    changed = write_note_update(note, updates, related_items)
                    refresh_state_for_note(note)
                    state = "Updated" if changed else "Unchanged"
                    log_event(f"[write] {state}: {note.relpath}")
                except Exception as exc:
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
                    continue
                try:
                    changed = write_note_update(note, updates, item.get("related_items"))
                    refresh_state_for_note(note)
                    state = "Updated" if changed else "Unchanged"
                    log_event(f"[write] {state}: {note.relpath}")
                except Exception as exc:
                    log_event(f"[error] Write failed for {note.relpath}: {exc}", to_stderr=True)
            else:
                log_event(f"[dry-run] Would update metadata: {note.relpath}", also_print=False)

    ensure_dir(log_path.parent)
    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    if args.preview and preview_lines:
        ensure_dir(preview_path.parent)
        preview_path.write_text("\n".join(preview_lines) + "\n", encoding="utf-8")

    print("Run complete.")
    print(f"Log: {log_path}")
    if not args.apply:
        print("No note changes were made. Re-run with --apply to write updates.")

    save_json(state_path, {"files": state_files})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
