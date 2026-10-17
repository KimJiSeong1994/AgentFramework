#!/usr/bin/env python3
"""Read-only sqlite query helper for otter's `db_query` (stdlib only).

stdin:  {"path": "<sqlite file>", "sql": "<one SELECT/WITH>", "timeout_ms": 15000, "max_rows": 51}
stdout: {"columns": [...], "rows": [[...], ...]}   or   {"error": "<message>"}

Why a subprocess: bun:sqlite has no custom scalar functions, and the fixture questions need `dist_m()` (haversine
metres) as a stand-in for PostGIS. The connection is opened with `?mode=ro`, an authorizer allows only
SELECT/READ/FUNCTION, and a progress handler enforces the wall-clock timeout.
"""
import json
import math
import sqlite3
import sys
import time


def dist_m(lon1, lat1, lon2, lat2):
    try:
        lon1, lat1, lon2, lat2 = float(lon1), float(lat1), float(lon2), float(lat2)
    except (TypeError, ValueError):
        return None
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


ALLOWED = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION}
# constant-expression / subquery / recursive CTE support
for name in ("SQLITE_RECURSIVE",):
    if hasattr(sqlite3, name):
        ALLOWED.add(getattr(sqlite3, name))


def authorizer(action, arg1, arg2, dbname, source):
    return sqlite3.SQLITE_OK if action in ALLOWED else sqlite3.SQLITE_DENY


def main():
    req = json.load(sys.stdin)
    path, sql = req["path"], req["sql"]
    timeout_ms = int(req.get("timeout_ms", 15000))
    max_rows = int(req.get("max_rows", 51))
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        print(json.dumps({"error": f"cannot open {path}: {exc}"}))
        return
    con.create_function("dist_m", 4, dist_m)
    con.set_authorizer(authorizer)
    deadline = time.monotonic() + timeout_ms / 1000.0

    def progress():
        return 1 if time.monotonic() > deadline else 0

    con.set_progress_handler(progress, 10000)
    try:
        cur = con.execute(sql)
        columns = [d[0] for d in (cur.description or [])]
        rows = []
        for row in cur:
            rows.append(list(row))
            if len(rows) >= max_rows:
                break
        print(json.dumps({"columns": columns, "rows": rows}, ensure_ascii=False, default=str))
    except sqlite3.OperationalError as exc:
        msg = str(exc)
        if "interrupted" in msg:
            msg = f"query exceeded {timeout_ms} ms; narrow it with WHERE or an aggregate"
        print(json.dumps({"error": msg}, ensure_ascii=False))
    except sqlite3.DatabaseError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
    finally:
        con.close()


if __name__ == "__main__":
    main()
