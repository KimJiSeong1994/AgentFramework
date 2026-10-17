#!/usr/bin/env python3
"""Build the static schema description used by otter's `schema_lookup` tool from PostgreSQL DDL files.

    python3 scripts/otter-schema-extract.py path/to/ddl/*.sql -o data/schema.json \
        --prefix <schema>. --dialect postgres

Extracts CREATE TABLE columns (name, type), PRIMARY KEY / REFERENCES, CHECK (...IN (...)) value lists, enum types,
and COMMENT ON TABLE/COLUMN strings. Regex-based and deliberately conservative: unknown constructs are skipped,
never guessed. Stdlib only. Review the output; add `notes` for dialect quirks (json ->>, PostGIS) by hand.
"""
import argparse
import json
import re
import sys


def strip_comments(sql: str) -> str:
    sql = re.sub(r"/\*[\s\S]*?\*/", " ", sql)
    return re.sub(r"--[^\n]*", " ", sql)


def split_top_level(body: str):
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def parse(sqls, prefix=""):
    enums = {}
    tables = {}
    comments_t, comments_c = {}, {}
    for sql in sqls:
        s = strip_comments(sql)
        for m in re.finditer(r"CREATE\s+TYPE\s+([\w.]+)\s+AS\s+ENUM\s*\(([^)]*)\)", s, re.I):
            enums[m.group(1).split(".")[-1].lower()] = re.findall(r"'([^']*)'", m.group(2))
        for m in re.finditer(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(", s, re.I):
            name = m.group(1).split(".")[-1]
            # find the matching closing paren
            i, depth = m.end(), 1
            while i < len(s) and depth:
                depth += 1 if s[i] == "(" else -1 if s[i] == ")" else 0
                i += 1
            body = s[m.end() : i - 1]
            t = {"description": "", "columns": [], "primary_key": [], "foreign_keys": [], "notes": []}
            tail = s[i : i + 200]
            pm = re.search(r"PARTITION\s+BY\s+(\w+)\s*\(([^)]*)\)", tail, re.I)
            if pm:
                t["partitions"] = f"{pm.group(1)} ({pm.group(2).strip()})"
            for part in split_top_level(body):
                up = part.upper()
                if up.startswith("PRIMARY KEY"):
                    t["primary_key"] = [c.strip() for c in re.search(r"\(([^)]*)\)", part).group(1).split(",")]
                elif up.startswith("CONSTRAINT") or up.startswith("UNIQUE") or up.startswith("CHECK") or up.startswith("FOREIGN KEY"):
                    pk = re.search(r"PRIMARY\s+KEY\s*\(([^)]*)\)", part, re.I)
                    if pk:
                        t["primary_key"] = [c.strip() for c in pk.group(1).split(",")]
                    fk = re.search(r"FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\w.]+)\s*\(([^)]*)\)", part, re.I)
                    if fk:
                        t["foreign_keys"].append(f"{fk.group(1).strip()} -> {fk.group(2).split('.')[-1]}.{fk.group(3).strip()}")
                    continue
                else:
                    cm = re.match(r"(\"?[\w]+\"?)\s+(.*)$", part, re.S)
                    if not cm:
                        continue
                    cname = cm.group(1).strip('"')
                    # the type runs up to the first constraint keyword (NOT NULL, DEFAULT, PRIMARY KEY, REFERENCES, ...)
                    km = re.search(r"\b(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|CHECK|UNIQUE|GENERATED|COLLATE|CONSTRAINT)\b", cm.group(2), re.I)
                    ctype = re.sub(r"\s+", " ", cm.group(2)[: km.start()] if km else cm.group(2)).strip()
                    rest = cm.group(2)[km.start():] if km else ""
                    if not ctype:
                        continue
                    col = {"name": cname, "type": ctype}
                    if re.search(r"\bPRIMARY\s+KEY\b", rest, re.I):
                        t["primary_key"].append(cname)
                    ref = re.search(r"REFERENCES\s+([\w.]+)\s*\(([^)]*)\)", rest, re.I)
                    if ref:
                        t["foreign_keys"].append(f"{cname} -> {ref.group(1).split('.')[-1]}.{ref.group(2).strip()}")
                    chk = re.search(r"CHECK\s*\(\s*\w+\s+IN\s*\(([^)]*)\)", rest, re.I)
                    if chk:
                        col["values"] = re.findall(r"'([^']*)'", chk.group(1))
                    et = ctype.split("(")[0].split(".")[-1].lower()
                    if et in enums:
                        col["values"] = enums[et]
                    t["columns"].append(col)
            tables[name] = t
        for m in re.finditer(r"COMMENT\s+ON\s+TABLE\s+([\w.]+)\s+IS\s+'((?:[^']|'')*)'", s, re.I):
            comments_t[m.group(1).split(".")[-1]] = m.group(2).replace("''", "'")
        for m in re.finditer(r"COMMENT\s+ON\s+COLUMN\s+([\w.]+)\.(\w+)\s+IS\s+'((?:[^']|'')*)'", s, re.I):
            comments_c[(m.group(1).split(".")[-1], m.group(2))] = m.group(3).replace("''", "'")
    for name, t in tables.items():
        t["description"] = comments_t.get(name, "")
        for c in t["columns"]:
            d = comments_c.get((name, c["name"]))
            if d:
                c["description"] = d
        for k in ("primary_key", "foreign_keys", "notes"):
            if not t[k]:
                del t[k]
    return tables


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--out", default="-")
    ap.add_argument("--prefix", default="")
    ap.add_argument("--dialect", default="postgres", choices=["postgres", "sqlite"])
    ap.add_argument("--note", action="append", default=[])
    a = ap.parse_args()
    sqls = [open(f, encoding="utf-8").read() for f in a.files]
    out = {"dialect": a.dialect, "table_prefix": a.prefix, "notes": a.note, "tables": parse(sqls, a.prefix)}
    text = json.dumps(out, ensure_ascii=False, indent=2)
    if a.out == "-":
        print(text)
    else:
        open(a.out, "w", encoding="utf-8").write(text + "\n")
        print(f"wrote {a.out}: {len(out['tables'])} tables, {sum(len(t['columns']) for t in out['tables'].values())} columns", file=sys.stderr)


if __name__ == "__main__":
    main()
