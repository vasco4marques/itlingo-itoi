#!/usr/bin/env python3
"""Import data from a pg_dump SQL file into the local Dockerized Postgres.

Streams the COPY blocks for t_workspaces, t_files and t_workspaces_git from the
dump, remaps dump workspace UUIDs to existing target UUIDs when the workspace
name already exists, and inserts only new rows (ON CONFLICT DO NOTHING).

Run a dry-run first (default), then re-run with --apply to actually insert.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import psycopg
from dotenv import dotenv_values


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DUMP = REPO_ROOT / "itlingo_itoi_20260521_030001.sql"
DEFAULT_ENV = REPO_ROOT / ".env"

# Tables we know how to import (others, including t_files_bck, are skipped).
TARGET_TABLES = ("t_workspaces", "t_files", "t_workspaces_git")
INSERT_BATCH = 200


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dump", type=Path, default=DEFAULT_DUMP, help="Path to the SQL dump file")
    p.add_argument("--env-file", type=Path, default=DEFAULT_ENV, help="Path to the .env file")
    p.add_argument("--host", default="localhost", help="Postgres host (default: localhost)")
    p.add_argument("--apply", action="store_true", help="Actually insert rows (otherwise dry-run)")
    return p.parse_args()


# ---------------------------------------------------------------------------
# Dump parsing
# ---------------------------------------------------------------------------

# pg_dump's text COPY format uses these backslash escapes inside a tab-delimited row.
_UNESCAPE = {
    "\\": "\\",
    "t": "\t",
    "n": "\n",
    "r": "\r",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}


def _unescape_field(raw: str) -> str | None:
    """Decode pg_dump text-format escapes for a single field. Returns None for \\N."""
    if raw == "\\N":
        return None
    out: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        ch = raw[i]
        if ch == "\\" and i + 1 < n:
            nxt = raw[i + 1]
            mapped = _UNESCAPE.get(nxt)
            if mapped is not None:
                out.append(mapped)
                i += 2
                continue
            # Unknown escape — keep the backslash and the character literally.
            out.append(ch)
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _decode_bytea(value: str | None) -> bytes | None:
    """Convert pg_dump's hex bytea representation (e.g. ``\\x4142``) to bytes."""
    if value is None:
        return None
    if value.startswith("\\x"):
        return bytes.fromhex(value[2:])
    # Fallback — treat as raw bytes (should not happen for our dump).
    return value.encode("utf-8")


@dataclass
class DumpData:
    workspaces: list[tuple[str, str]] = field(default_factory=list)  # (id, workspace)
    files: list[tuple[str, str, str | None, str | None, bytes | None]] = field(default_factory=list)
    # (filename, workspace_id, create_date, change_date, file)
    git: list[tuple[str, str | None]] = field(default_factory=list)  # (workspace_id, giturl)
    skipped_bck_rows: int = 0


def _iter_copy_blocks(dump_path: Path) -> Iterator[tuple[str, Iterator[str]]]:
    """Yield (table_name, line_iterator) for each ``COPY public.<table>`` block."""

    with dump_path.open("r", encoding="utf-8", errors="replace") as fh:
        current_table: str | None = None
        for line in fh:
            if current_table is None:
                if line.startswith("COPY public."):
                    # e.g. ``COPY public.t_files (filename, ...) FROM stdin;``
                    after = line[len("COPY public.") :]
                    table = after.split(" ", 1)[0]
                    current_table = table

                    def block_iter(file_handle=fh) -> Iterator[str]:
                        for inner in file_handle:
                            if inner.startswith("\\."):
                                return
                            # Strip trailing newline only — preserve any other whitespace.
                            yield inner[:-1] if inner.endswith("\n") else inner

                    yield current_table, block_iter()
                    current_table = None


def parse_dump(dump_path: Path) -> DumpData:
    data = DumpData()
    for table, rows in _iter_copy_blocks(dump_path):
        if table == "t_files_bck":
            data.skipped_bck_rows = sum(1 for _ in rows)
            continue
        if table not in TARGET_TABLES:
            # Drain unknown blocks so the outer iterator advances.
            for _ in rows:
                pass
            continue

        if table == "t_workspaces":
            for line in rows:
                fields = line.split("\t")
                if len(fields) < 2:
                    continue
                ws_id = _unescape_field(fields[0])
                workspace = _unescape_field(fields[1])
                if ws_id is None or workspace is None:
                    continue
                data.workspaces.append((ws_id, workspace))

        elif table == "t_files":
            for line in rows:
                fields = line.split("\t")
                if len(fields) < 5:
                    continue
                filename = _unescape_field(fields[0])
                workspace_id = _unescape_field(fields[1])
                create_date = _unescape_field(fields[2])
                change_date = _unescape_field(fields[3])
                file_bytes = _decode_bytea(_unescape_field(fields[4]))
                if filename is None or workspace_id is None:
                    continue
                data.files.append(
                    (filename, workspace_id, create_date, change_date, file_bytes)
                )

        elif table == "t_workspaces_git":
            for line in rows:
                fields = line.split("\t")
                if len(fields) < 2:
                    continue
                workspace_id = _unescape_field(fields[0])
                giturl = _unescape_field(fields[1])
                if workspace_id is None:
                    continue
                data.git.append((workspace_id, giturl))

    return data


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def load_db_config(env_file: Path, host: str) -> dict[str, str]:
    if not env_file.exists():
        print(f"ERROR: env file not found: {env_file}", file=sys.stderr)
        sys.exit(2)
    env = dotenv_values(env_file)
    missing = [k for k in ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB") if not env.get(k)]
    if missing:
        print(f"ERROR: missing env vars in {env_file}: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)
    return {
        "user": env["POSTGRES_USER"],
        "password": env["POSTGRES_PASSWORD"],
        "dbname": env["POSTGRES_DB"],
        "host": host,
        "port": env.get("DB_HOST_PORT", "5433"),
    }


def ensure_schema(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ANY(%s)
            """,
            (list(TARGET_TABLES),),
        )
        found = {row[0] for row in cur.fetchall()}
    missing = sorted(set(TARGET_TABLES) - found)
    if missing:
        print(
            "ERROR: required tables missing in target DB: "
            + ", ".join(missing)
            + "\nBring the stack up first (e.g. `docker compose up -d db`).",
            file=sys.stderr,
        )
        sys.exit(3)


def fetch_existing(conn: psycopg.Connection) -> tuple[
    dict[str, str],  # workspace_name -> id
    set[str],  # existing workspace ids
    set[tuple[str, str]],  # (filename, workspace_id)
    set[str],  # existing git workspace_ids
    dict[str, int],  # per-table current row counts
]:
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, workspace FROM t_workspaces")
        ws_rows = cur.fetchall()
        name_to_id = {name: wid for wid, name in ws_rows}
        existing_ws_ids = {wid for wid, _ in ws_rows}
        counts["t_workspaces"] = len(ws_rows)

        cur.execute("SELECT filename, workspace_id::text FROM t_files")
        existing_files = {(fn, wid) for fn, wid in cur.fetchall()}
        counts["t_files"] = len(existing_files)

        cur.execute("SELECT workspace_id::text FROM t_workspaces_git")
        existing_git = {wid for (wid,) in cur.fetchall()}
        counts["t_workspaces_git"] = len(existing_git)

    return name_to_id, existing_ws_ids, existing_files, existing_git, counts


# ---------------------------------------------------------------------------
# Planning & applying
# ---------------------------------------------------------------------------


@dataclass
class ImportPlan:
    new_workspaces: list[tuple[str, str]]  # rows to insert: (id, workspace) using FINAL id
    workspaces_already_present: int
    remap: dict[str, str]  # dump uuid -> target uuid
    remapped_count: int  # how many dump uuids were remapped to a different target uuid
    new_files: list[tuple[str, str, str | None, str | None, bytes | None]]
    files_already_present: int
    new_git: list[tuple[str, str | None]]
    git_already_present: int
    target_counts: dict[str, int]


def build_plan(
    data: DumpData,
    name_to_id: dict[str, str],
    existing_ws_ids: set[str],
    existing_files: set[tuple[str, str]],
    existing_git: set[str],
    target_counts: dict[str, int],
) -> ImportPlan:
    remap: dict[str, str] = {}
    new_workspaces: list[tuple[str, str]] = []
    workspaces_already_present = 0
    remapped_count = 0

    # Workspaces inserted in *this* run also become "existing" for FK purposes.
    will_exist_ids = set(existing_ws_ids)

    for dump_id, workspace_name in data.workspaces:
        existing_by_name = name_to_id.get(workspace_name)
        if existing_by_name is not None:
            remap[dump_id] = existing_by_name
            workspaces_already_present += 1
            if existing_by_name != dump_id:
                remapped_count += 1
            continue
        if dump_id in existing_ws_ids:
            # UUID collision with a different name — remap to whatever workspace owns that uuid.
            remap[dump_id] = dump_id
            workspaces_already_present += 1
            continue
        remap[dump_id] = dump_id
        new_workspaces.append((dump_id, workspace_name))
        will_exist_ids.add(dump_id)

    new_files: list[tuple[str, str, str | None, str | None, bytes | None]] = []
    files_already_present = 0
    for filename, dump_ws_id, create_date, change_date, file_bytes in data.files:
        final_ws_id = remap.get(dump_ws_id, dump_ws_id)
        if final_ws_id not in will_exist_ids:
            # Orphan — workspace not in dump nor target. Skip to keep FK valid.
            files_already_present += 0  # explicit no-op
            continue
        if (filename, final_ws_id) in existing_files:
            files_already_present += 1
            continue
        new_files.append((filename, final_ws_id, create_date, change_date, file_bytes))

    new_git: list[tuple[str, str | None]] = []
    git_already_present = 0
    for dump_ws_id, giturl in data.git:
        final_ws_id = remap.get(dump_ws_id, dump_ws_id)
        if final_ws_id not in will_exist_ids:
            continue
        if final_ws_id in existing_git:
            git_already_present += 1
            continue
        new_git.append((final_ws_id, giturl))

    return ImportPlan(
        new_workspaces=new_workspaces,
        workspaces_already_present=workspaces_already_present,
        remap=remap,
        remapped_count=remapped_count,
        new_files=new_files,
        files_already_present=files_already_present,
        new_git=new_git,
        git_already_present=git_already_present,
        target_counts=target_counts,
    )


def apply_plan(conn: psycopg.Connection, plan: ImportPlan) -> dict[str, int]:
    inserted = {"t_workspaces": 0, "t_files": 0, "t_workspaces_git": 0}
    with conn.cursor() as cur:
        if plan.new_workspaces:
            for batch in _chunks(plan.new_workspaces, INSERT_BATCH):
                cur.executemany(
                    "INSERT INTO t_workspaces (id, workspace) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    batch,
                )
                inserted["t_workspaces"] += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

        if plan.new_files:
            for batch in _chunks(plan.new_files, INSERT_BATCH):
                cur.executemany(
                    """
                    INSERT INTO t_files (filename, workspace_id, create_date, change_date, file)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (filename, workspace_id) DO NOTHING
                    """,
                    batch,
                )
                inserted["t_files"] += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

        if plan.new_git:
            for batch in _chunks(plan.new_git, INSERT_BATCH):
                cur.executemany(
                    "INSERT INTO t_workspaces_git (workspace_id, giturl) VALUES (%s, %s) ON CONFLICT (workspace_id) DO NOTHING",
                    batch,
                )
                inserted["t_workspaces_git"] += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    return inserted


def _chunks(seq: list, size: int) -> Iterator[list]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def post_counts(conn: psycopg.Connection) -> dict[str, int]:
    counts: dict[str, int] = {}
    with conn.cursor() as cur:
        for table in TARGET_TABLES:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            counts[table] = cur.fetchone()[0]
    return counts


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def print_report(data: DumpData, plan: ImportPlan, apply_mode: bool, db_url: str, dump_path: Path) -> None:
    mode = "APPLY" if apply_mode else "DRY RUN (no changes will be made)"
    print(f"Dump:    {dump_path}")
    print(f"Target:  {db_url}")
    print(f"Mode:    {mode}")
    print()

    header = f"{'Table':<24}{'In dump':>10}{'In target':>12}{'New':>8}{'Already present':>20}{'Remapped workspaces':>24}"
    print(header)

    rows = [
        (
            "t_workspaces",
            len(data.workspaces),
            plan.target_counts["t_workspaces"],
            len(plan.new_workspaces),
            plan.workspaces_already_present,
            plan.remapped_count,
        ),
        (
            "t_files",
            len(data.files),
            plan.target_counts["t_files"],
            len(plan.new_files),
            plan.files_already_present,
            None,
        ),
        (
            "t_workspaces_git",
            len(data.git),
            plan.target_counts["t_workspaces_git"],
            len(plan.new_git),
            plan.git_already_present,
            None,
        ),
    ]
    for name, in_dump, in_target, new, already, remapped in rows:
        remap_str = "-" if remapped is None else f"{remapped}"
        print(f"{name:<24}{in_dump:>10}{in_target:>12}{new:>8}{already:>20}{remap_str:>24}")
    print(f"{'t_files_bck (skipped)':<24}{data.skipped_bck_rows:>10}{'-':>12}{'-':>8}{'-':>20}{'-':>24}")
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    args = parse_args()
    if not args.dump.exists():
        print(f"ERROR: dump file not found: {args.dump}", file=sys.stderr)
        return 2

    cfg = load_db_config(args.env_file, args.host)
    db_url = f"{cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']}"

    print(f"Parsing dump file: {args.dump} ...", flush=True)
    data = parse_dump(args.dump)
    print(
        f"  workspaces={len(data.workspaces)} files={len(data.files)} "
        f"git={len(data.git)} bck_skipped={data.skipped_bck_rows}",
        flush=True,
    )

    try:
        conn = psycopg.connect(
            host=cfg["host"],
            port=cfg["port"],
            user=cfg["user"],
            password=cfg["password"],
            dbname=cfg["dbname"],
            autocommit=False,
        )
    except psycopg.OperationalError as exc:
        print(f"ERROR: could not connect to Postgres at {db_url}: {exc}", file=sys.stderr)
        print("Bring the stack up first: `docker compose up -d db`", file=sys.stderr)
        return 4

    try:
        ensure_schema(conn)
        name_to_id, existing_ws_ids, existing_files, existing_git, target_counts = fetch_existing(conn)
        plan = build_plan(
            data,
            name_to_id,
            existing_ws_ids,
            existing_files,
            existing_git,
            target_counts,
        )

        print_report(data, plan, args.apply, db_url, args.dump)

        if not args.apply:
            print("(Re-run with --apply to perform the import.)")
            return 0

        try:
            inserted = apply_plan(conn, plan)
            conn.commit()
        except Exception as exc:
            conn.rollback()
            print(f"ERROR during insert, rolled back: {exc}", file=sys.stderr)
            return 5

        final_counts = post_counts(conn)
        print("Inserted:")
        for table in TARGET_TABLES:
            print(f"  {table}: +{inserted[table]} (now {final_counts[table]})")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
