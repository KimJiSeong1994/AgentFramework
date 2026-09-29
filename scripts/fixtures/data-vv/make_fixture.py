#!/usr/bin/env python3
"""Stage-3 fixture: an offline sqlite copy of the vehicle_visit schema with synthetic rows, the static schema
description for `schema_lookup`, the example questions with their expected (sqlite) SQL, and an EvoOntology
workspace holding a code-generated ontology_v0 (terms/mappings/relations/constraints/evidence).

    python3 make_fixture.py [OUT_DIR]      # default: the directory of this file

Deterministic (seeded); stdlib only. The real project targets PostgreSQL+PostGIS on a remote production server, so
the dialect differences are captured in schema.json notes (json_extract instead of ->>, dist_m() instead of
ST_DWithin, ISO date strings) and in the expected SQL of queries.jsonl.
"""
import json
import math
import os
import random
import sqlite3
import sys
from datetime import date, timedelta

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(__file__))
random.seed(20260923)

# ----------------------------------------------------------------------------------------------- reference data
SIDO = ["경기", "충남", "충북", "전북", "전남", "경북", "경남", "강원"]
SIGUNGU = {
    "경기": ["안성시", "평택시", "이천시", "화성시"],
    "충남": ["천안시 동남구", "천안시 서북구", "아산시", "홍성군"],
    "충북": ["제천시", "음성군", "진천군"],
    "전북": ["부안군", "김제시", "정읍시"],
    "전남": ["나주시", "영암군"],
    "경북": ["영천시", "경주시"],
    "경남": ["양산시", "김해시"],
    "강원": ["횡성군", "원주시"],
}
LIVESTOCK = ["산란계", "육계", "오리", "종계", "토종닭", "메추리", "거위", "돼지", "한우"]
PURPOSES = ["사료운반", "가축운반", "분뇨운반", "왕진진료", "컨설팅", "계란운반", "약품운반"]
CENTER = {  # rough lon/lat per sido for plausible coordinates
    "경기": (127.2, 37.1), "충남": (126.9, 36.7), "충북": (128.0, 37.0), "전북": (126.8, 35.7),
    "전남": (126.8, 34.9), "경북": (128.9, 36.0), "경남": (128.8, 35.3), "강원": (128.1, 37.5),
}
BUAN = (126.73, 35.73)  # 전북 부안군


def jitter(c, km=15):
    lon, lat = c
    return (round(lon + random.uniform(-km, km) / 88.0, 5), round(lat + random.uniform(-km, km) / 111.0, 5))


def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ----------------------------------------------------------------------------------------------- tables
DDL = """
CREATE TABLE tb_vehicle_info (
  vehicle_management_id TEXT PRIMARY KEY,
  mobile_serial_number TEXT NOT NULL,
  vehicle_registration_number TEXT,
  vehicle_registration_date TEXT,
  vehicle_model TEXT,
  visit_purpose_code TEXT,
  visit_purpose_name TEXT,
  main_livestock_types TEXT
);
CREATE INDEX idx_vehicle_mobile ON tb_vehicle_info(mobile_serial_number);
CREATE TABLE tb_place_info (
  place_id TEXT PRIMARY KEY CHECK (place_id GLOB '[afh][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  place_type TEXT NOT NULL CHECK (place_type IN ('facility','farm','habitat')),
  place_name TEXT,
  address TEXT,
  legaldong_code TEXT,
  pnu TEXT,
  longitude REAL,
  latitude REAL,
  attrs TEXT,
  sido TEXT,
  sigungu TEXT,
  eupmyeondong TEXT,
  detail_address TEXT
);
CREATE INDEX idx_place_sido ON tb_place_info(sido, sigungu);
CREATE TABLE tb_visit_history (
  standard_date TEXT NOT NULL,
  mobile_serial_number TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_seconds INTEGER,
  place_id TEXT NOT NULL,
  place_type TEXT CHECK (place_type IN ('facility','farm','habitat')),
  place_name TEXT,
  gps_longitude REAL,
  gps_latitude REAL,
  PRIMARY KEY (standard_date, mobile_serial_number, start_time, place_id)
);
CREATE INDEX idx_visit_mobile_date ON tb_visit_history(mobile_serial_number, standard_date);
CREATE INDEX idx_visit_place_date ON tb_visit_history(place_id, standard_date);
CREATE TABLE tb_vehicle_risk_daily (
  standard_date TEXT NOT NULL,
  mobile_serial_number TEXT NOT NULL,
  risk_score REAL,
  risk_level TEXT CHECK (risk_level IN ('낮음','주의','위험')),
  risk_explanation TEXT,
  PRIMARY KEY (standard_date, mobile_serial_number)
);
CREATE TABLE tb_hpai_outbreak_farm (
  outbreak_id INTEGER PRIMARY KEY,
  season TEXT,
  category TEXT,
  report_date TEXT,
  place_id TEXT REFERENCES tb_place_info(place_id),
  sido TEXT,
  sigungu TEXT,
  address TEXT,
  livestock_type TEXT,
  genotype TEXT,
  livestock_count INTEGER,
  longitude REAL,
  latitude REAL,
  outbreak_history TEXT
);
CREATE TABLE tb_hpai_outbreak_wild (
  outbreak_id INTEGER PRIMARY KEY,
  season TEXT,
  detection_location TEXT,
  report_date TEXT,
  place_id TEXT REFERENCES tb_place_info(place_id),
  sido TEXT,
  sigungu TEXT,
  address TEXT,
  sample_type TEXT,
  pathogenicity TEXT,
  genotype TEXT,
  longitude REAL,
  latitude REAL
);
"""


def build_db(path):
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.executescript(DDL)

    # ---- places
    places = []
    pid = 0
    for sido in SIDO:
        for sg in SIGUNGU[sido]:
            for _ in range(random.randint(6, 10)):
                pid += 1
                ptype = random.choices(["farm", "facility", "habitat"], [8, 1, 1])[0]
                prefix = {"farm": "a", "facility": "f", "habitat": "h"}[ptype]
                lon, lat = jitter(BUAN if sg == "부안군" else CENTER[sido], 8 if sg == "부안군" else 15)
                kinds = random.sample(LIVESTOCK, random.randint(1, 2)) if ptype == "farm" else []
                # make the fixture answers non-trivial: extra layer farms in 천안시, duck farms in 부안군
                if sg.startswith("천안시") and ptype == "farm" and random.random() < 0.5 and "산란계" not in kinds:
                    kinds.append("산란계")
                if sg == "부안군" and ptype == "farm" and random.random() < 0.6 and "오리" not in kinds:
                    kinds.append("오리")
                attrs = {"livestock_types": ",".join(kinds)} if kinds else {}
                places.append((f"{prefix}{pid:08d}", ptype, f"{sg} {ptype} {pid}", f"{sido} {sg} 어딘가 {pid}", None, None, lon, lat, json.dumps(attrs, ensure_ascii=False), sido, sg, None, None))
    con.executemany("INSERT INTO tb_place_info VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", places)
    farms = [p for p in places if p[1] == "farm"]

    # ---- vehicles (10-digit mobile serials, one fixed id for MAP-001)
    vehicles = []
    serials = ["0000125451"] + [f"{random.randint(1, 9999999999):010d}" for _ in range(59)]
    for i, ms in enumerate(serials):
        purpose = PURPOSES[i % len(PURPOSES)] if ms != "0000125451" else "사료운반"
        vehicles.append((f"VM{i:06d}", ms, f"{random.randint(10,99)}가{random.randint(1000,9999)}", "2022-03-01", "5t 트럭", f"P{PURPOSES.index(purpose):02d}", purpose, random.choice(LIVESTOCK[:5])))
    con.executemany("INSERT INTO tb_vehicle_info VALUES (?,?,?,?,?,?,?,?)", vehicles)

    # ---- visits (Dec 2024 + Feb 2025)
    visits = []
    seen = set()
    buan_duck = [p for p in farms if p[10] == "부안군" and "오리" in p[8]]
    risky = serials[1:9]  # vehicles that will be "위험" often
    for ms in serials:
        n = random.randint(6, 14)
        for _ in range(n):
            month = random.choice([(2024, 12), (2025, 2)])
            d = date(month[0], month[1], random.randint(1, 28))
            if ms in risky and random.random() < 0.7 and buan_duck:
                p = random.choice(buan_duck)
            else:
                p = random.choice(farms + [x for x in places if x[1] != "farm"][:10])
            start = f"{d.isoformat()} {random.randint(6,18):02d}:{random.randint(0,59):02d}:00"
            key = (d.isoformat(), ms, start, p[0])
            if key in seen:
                continue
            seen.add(key)
            visits.append((d.isoformat(), ms, start, None, random.randint(300, 5400), p[0], p[1], p[2], p[6], p[7]))
    # the MAP-001 vehicle: a clear December-2024 farm route
    ms = "0000125451"
    for i, p in enumerate(random.sample(farms, 5)):
        d = date(2024, 12, 3 + i * 5)
        start = f"{d.isoformat()} {8 + i:02d}:15:00"
        visits.append((d.isoformat(), ms, start, None, 1800, p[0], "farm", p[2], p[6], p[7]))
    con.executemany("INSERT INTO tb_visit_history VALUES (?,?,?,?,?,?,?,?,?,?)", visits)

    # ---- daily risk
    risk = {}
    for v in visits:
        key = (v[0], v[1])
        if key in risk:
            continue
        score = round(random.uniform(0.0, 1.6), 3)
        if v[1] in risky:
            score = round(random.uniform(1.0, 1.6), 3)
        level = "위험" if score >= 1.0 else "주의" if score >= 0.7 else "낮음"
        risk[key] = (v[0], v[1], score, level, f"{level}: 방문 위험 농장 수 기준")
    con.executemany("INSERT INTO tb_vehicle_risk_daily VALUES (?,?,?,?,?)", list(risk.values()))

    # MAP-002 must have an unambiguous top 3: give the three most active risky vehicles strictly distinct counts
    # (max of everyone else + 3/2/1) by adding Feb-2025 duck-farm visits on days they are already rated 위험.
    if buan_duck:
        q = ("SELECT h.mobile_serial_number, count(*) c FROM tb_visit_history h JOIN tb_place_info p ON p.place_id = h.place_id "
             "JOIN tb_vehicle_risk_daily r ON r.mobile_serial_number = h.mobile_serial_number AND r.standard_date = h.standard_date "
             "WHERE h.standard_date BETWEEN '2025-02-01' AND '2025-02-28' AND p.sigungu = '부안군' AND p.place_type = 'farm' "
             "AND json_extract(p.attrs, '$.livestock_types') LIKE '%오리%' AND r.risk_level = '위험' GROUP BY 1 ORDER BY c DESC")
        counts = dict(con.execute(q).fetchall())
        top = risky[:3]
        others = max([c for m, c in counts.items() if m not in top] or [0])
        extra = []
        for k, ms in enumerate(top):
            target = others + (3 - k)
            days = [d for (d, m) in risk if m == ms and d.startswith("2025-02")] or ["2025-02-10"]
            if ("2025-02-10", ms) not in risk and days == ["2025-02-10"]:
                risk[("2025-02-10", ms)] = ("2025-02-10", ms, 1.2, "위험", "위험: 방문 위험 농장 수 기준")
                con.execute("INSERT INTO tb_vehicle_risk_daily VALUES (?,?,?,?,?)", risk[("2025-02-10", ms)])
            n = counts.get(ms, 0)
            j = 0
            while n < target:
                d = days[j % len(days)]
                p = buan_duck[j % len(buan_duck)]
                start = f"{d} {20 + (j % 3):02d}:{(7 * j + k) % 60:02d}:00"
                key = (d, ms, start, p[0])
                j += 1
                if key in seen:
                    continue
                seen.add(key)
                extra.append((d, ms, start, None, 1200, p[0], p[1], p[2], p[6], p[7]))
                n += 1
        con.executemany("INSERT INTO tb_visit_history VALUES (?,?,?,?,?,?,?,?,?,?)", extra)
        visits.extend(extra)

    # ---- HPAI farm outbreaks (id 1392 fixed: 전북 부안군, 2024-12, H5N1)
    outbreaks = []
    buan_farms = [p for p in farms if p[10] == "부안군"]
    oid = 1300
    for i in range(40):
        oid += 1
        p = random.choice(farms)
        d = date(2024, random.choice([10, 11, 12]), random.randint(1, 28)) if i % 2 == 0 else date(2025, random.choice([1, 2]), random.randint(1, 28))
        geno = random.choice(["H5N1", "H5N1", "H5N6", "H5N8"])
        outbreaks.append((oid, "2024-2025", random.choice(["신고", "예찰", "예방적살처분"]), d.isoformat(), p[0], p[9], p[10], p[3], p[8] and json.loads(p[8]).get("livestock_types", "").split(",")[0] or "육계", geno, random.randint(3000, 80000), p[6], p[7], None))
    p = buan_farms[0]
    outbreaks.append((1392, "2024-2025", "신고", "2024-12-18", p[0], "전북", "부안군", p[3], "오리", "H5N1", 12000, p[6], p[7], None))
    # two more 부안군 outbreaks in Dec 2024 so HPAI-MAP-001 has several rows
    for k, p in enumerate(buan_farms[1:3]):
        outbreaks.append((1393 + k, "2024-2025", "예찰", f"2024-12-{20 + k:02d}", p[0], "전북", "부안군", p[3], "육계", "H5N1", 8000, p[6], p[7], None))
    con.executemany("INSERT INTO tb_hpai_outbreak_farm VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", outbreaks)

    # ---- wild bird detections: a few within 10 km / 21 days of outbreak 1392, the rest far away
    wild = []
    lon0, lat0 = p[6], p[7]
    ref = [o for o in outbreaks if o[0] == 1392][0]
    for i in range(40):
        oid = 2000 + i
        if i < 5:
            lon, lat = jitter((ref[11], ref[12]), 6)
            d = date(2024, 12, 18) - timedelta(days=random.randint(0, 20))
            sido, sg = "전북", "부안군"
        else:
            s = random.choice(SIDO)
            sg = random.choice(SIGUNGU[s])
            lon, lat = jitter(CENTER[s], 20)
            d = date(2024, random.choice([10, 11]), random.randint(1, 28))
            sido = s
        wild.append((oid, "2024-2025", f"{sg} 하천 {i}", d.isoformat(), None, sido, sg, f"{sido} {sg}", random.choice(["분변", "폐사체"]), "고병원성", random.choice(["H5N1", "H5N1", "H5N6"]), lon, lat))
    con.executemany("INSERT INTO tb_hpai_outbreak_wild VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", wild)
    con.commit()
    con.close()
    return {"places": len(places), "farms": len(farms), "vehicles": len(vehicles), "visits": len(visits), "risk": len(risk), "outbreak_farm": len(outbreaks), "outbreak_wild": len(wild)}


# ----------------------------------------------------------------------------------------------- schema.json
SCHEMA = {
    "dialect": "sqlite",
    "table_prefix": "",
    "notes": [
        "JSON columns: use json_extract(attrs, '$.livestock_types') (Postgres would use attrs->>'livestock_types').",
        "Distance: dist_m(lon1, lat1, lon2, lat2) returns metres (Postgres: ST_DWithin on geom).",
        "Dates are ISO strings 'YYYY-MM-DD'; compare with BETWEEN 'YYYY-MM-01' AND 'YYYY-MM-31'. date(x, '-21 days') works.",
        "sido values are short names: 경기, 충남, 충북, 전북, 전남, 경북, 경남, 강원. sigungu may carry a district suffix: use LIKE '천안시%'.",
    ],
    "tables": {
        "tb_place_info": {
            "description": "장소 허브: 농장(farm, place_id a...), 시설(facility, f...), 철새도래지(habitat, h...)",
            "columns": [
                {"name": "place_id", "type": "TEXT", "description": "9자리 id, 첫 글자 a/f/h"},
                {"name": "place_type", "type": "TEXT", "values": ["farm", "facility", "habitat"]},
                {"name": "place_name", "type": "TEXT"},
                {"name": "address", "type": "TEXT"},
                {"name": "longitude", "type": "REAL"},
                {"name": "latitude", "type": "REAL"},
                {"name": "attrs", "type": "TEXT(JSON)", "description": "속성 JSON; livestock_types = '산란계,육계' 같은 쉼표 목록 (부분일치 LIKE '%산란계%')"},
                {"name": "sido", "type": "TEXT", "description": "시도 약칭", "values": SIDO},
                {"name": "sigungu", "type": "TEXT", "description": "시군구 (예: '천안시 동남구', '제천시', '부안군')"},
                {"name": "eupmyeondong", "type": "TEXT"},
            ],
            "primary_key": ["place_id"],
        },
        "tb_vehicle_info": {
            "description": "축산 차량 1대 = 1행",
            "columns": [
                {"name": "vehicle_management_id", "type": "TEXT"},
                {"name": "mobile_serial_number", "type": "TEXT", "description": "단말 번호 10자리; 방문/위험도와의 조인 키"},
                {"name": "vehicle_registration_number", "type": "TEXT"},
                {"name": "vehicle_model", "type": "TEXT"},
                {"name": "visit_purpose_code", "type": "TEXT"},
                {"name": "visit_purpose_name", "type": "TEXT", "description": "방문 목적 (사료운반, 가축운반, 분뇨운반, 왕진진료, 컨설팅, 계란운반, 약품운반)", "values": PURPOSES},
                {"name": "main_livestock_types", "type": "TEXT"},
            ],
            "primary_key": ["vehicle_management_id"],
        },
        "tb_visit_history": {
            "description": "차량의 장소 방문 이벤트 1건 = 1행",
            "columns": [
                {"name": "standard_date", "type": "TEXT", "description": "방문일 YYYY-MM-DD"},
                {"name": "mobile_serial_number", "type": "TEXT", "description": "차량 단말 번호 (tb_vehicle_info.mobile_serial_number)"},
                {"name": "start_time", "type": "TEXT", "description": "방문 시작 'YYYY-MM-DD HH:MM:SS'"},
                {"name": "end_time", "type": "TEXT"},
                {"name": "duration_seconds", "type": "INTEGER"},
                {"name": "place_id", "type": "TEXT", "description": "tb_place_info.place_id"},
                {"name": "place_type", "type": "TEXT", "values": ["farm", "facility", "habitat"]},
                {"name": "place_name", "type": "TEXT"},
                {"name": "gps_longitude", "type": "REAL"},
                {"name": "gps_latitude", "type": "REAL"},
            ],
            "primary_key": ["standard_date", "mobile_serial_number", "start_time", "place_id"],
            "foreign_keys": ["place_id -> tb_place_info.place_id", "mobile_serial_number -> tb_vehicle_info.mobile_serial_number"],
        },
        "tb_vehicle_risk_daily": {
            "description": "차량·일 단위 위험도 1행",
            "columns": [
                {"name": "standard_date", "type": "TEXT"},
                {"name": "mobile_serial_number", "type": "TEXT"},
                {"name": "risk_score", "type": "REAL", "description": ">= 1.0 위험, >= 0.7 주의, 그 외 낮음"},
                {"name": "risk_level", "type": "TEXT", "values": ["낮음", "주의", "위험"]},
                {"name": "risk_explanation", "type": "TEXT"},
            ],
            "primary_key": ["standard_date", "mobile_serial_number"],
        },
        "tb_hpai_outbreak_farm": {
            "description": "농장 HPAI 발생 사건 1건 = 1행",
            "columns": [
                {"name": "outbreak_id", "type": "INTEGER"},
                {"name": "season", "type": "TEXT"},
                {"name": "category", "type": "TEXT", "values": ["신고", "예찰", "예방적살처분"]},
                {"name": "report_date", "type": "TEXT", "description": "YYYY-MM-DD"},
                {"name": "place_id", "type": "TEXT", "description": "tb_place_info.place_id (nullable)"},
                {"name": "sido", "type": "TEXT", "values": SIDO},
                {"name": "sigungu", "type": "TEXT"},
                {"name": "address", "type": "TEXT"},
                {"name": "livestock_type", "type": "TEXT"},
                {"name": "genotype", "type": "TEXT", "description": "혈청형/유전형, 예: H5N1 (LIKE '%H5N1%')"},
                {"name": "livestock_count", "type": "INTEGER"},
                {"name": "longitude", "type": "REAL"},
                {"name": "latitude", "type": "REAL"},
            ],
            "primary_key": ["outbreak_id"],
        },
        "tb_hpai_outbreak_wild": {
            "description": "야생조류 HPAI 검출 1건 = 1행",
            "columns": [
                {"name": "outbreak_id", "type": "INTEGER"},
                {"name": "season", "type": "TEXT"},
                {"name": "detection_location", "type": "TEXT"},
                {"name": "report_date", "type": "TEXT", "description": "YYYY-MM-DD"},
                {"name": "sido", "type": "TEXT"},
                {"name": "sigungu", "type": "TEXT"},
                {"name": "sample_type", "type": "TEXT"},
                {"name": "pathogenicity", "type": "TEXT"},
                {"name": "genotype", "type": "TEXT"},
                {"name": "longitude", "type": "REAL"},
                {"name": "latitude", "type": "REAL"},
            ],
            "primary_key": ["outbreak_id"],
        },
    },
}

# ----------------------------------------------------------------------------------------------- questions
QUERIES = [
    {"id": "TEXT-001", "question": "경기 농장 수 알려줘", "kind": "scalar", "sql": "SELECT count(place_id) AS farm_count FROM tb_place_info WHERE sido = '경기' AND place_type = 'farm'"},
    {"id": "TEXT-002", "question": "충남 천안시 산란계 농장 수 알려줘", "kind": "scalar", "sql": "SELECT count(place_id) AS farm_count FROM tb_place_info WHERE sido = '충남' AND sigungu LIKE '천안시%' AND place_type = 'farm' AND json_extract(attrs, '$.livestock_types') LIKE '%산란계%'"},
    {"id": "TEXT-003", "question": "H5N1 발생 농장 전체 건수 알려줘", "kind": "scalar", "sql": "SELECT count(outbreak_id) AS outbreak_count FROM tb_hpai_outbreak_farm WHERE genotype LIKE '%H5N1%'"},
    {"id": "TEXT-004", "question": "사료운반 차량 중 농장을 방문한 차량 수 알려줘", "kind": "scalar", "sql": "SELECT count(DISTINCT v.mobile_serial_number) AS vehicle_count FROM tb_vehicle_info v JOIN tb_visit_history h ON h.mobile_serial_number = v.mobile_serial_number WHERE v.visit_purpose_name LIKE '%사료운반%' AND h.place_type = 'farm'"},
    {"id": "TEXT-005", "question": "제천시 농장 갯수 알려줘", "kind": "scalar", "sql": "SELECT count(place_id) AS farm_count FROM tb_place_info WHERE sigungu = '제천시' AND place_type = 'farm'"},
    {"id": "MAP-001", "question": "차량 0000125451의 2024년 12월 농장 방문 동선 보여줘", "kind": "rows", "ordered": True, "compare": ["start_time"], "sql": "SELECT standard_date, start_time, place_id, place_name, gps_longitude, gps_latitude FROM tb_visit_history WHERE mobile_serial_number = '0000125451' AND standard_date BETWEEN '2024-12-01' AND '2024-12-31' AND place_type = 'farm' AND gps_longitude IS NOT NULL ORDER BY start_time"},
    {"id": "HPAI-MAP-001", "question": "2024년 12월 전북 부안군 HPAI 발생 농장 목록 보여줘", "kind": "rows", "ordered": False, "compare": ["outbreak_id"], "sql": "SELECT outbreak_id, report_date, place_id, livestock_type, genotype, longitude, latitude FROM tb_hpai_outbreak_farm WHERE report_date BETWEEN '2024-12-01' AND '2024-12-31' AND sido = '전북' AND sigungu = '부안군' AND longitude IS NOT NULL"},
    {"id": "HPAI-MAP-002", "question": "발생번호 1392 HPAI 발생 농장 반경 10km 안의 가금 농장 수 알려줘", "kind": "scalar", "tier": 2, "sql": "SELECT count(*) AS farm_count FROM tb_hpai_outbreak_farm o JOIN tb_place_info p ON p.place_type = 'farm' AND p.place_id <> o.place_id AND dist_m(o.longitude, o.latitude, p.longitude, p.latitude) <= 10000 WHERE o.outbreak_id = 1392 AND (json_extract(p.attrs, '$.livestock_types') LIKE '%닭%' OR json_extract(p.attrs, '$.livestock_types') LIKE '%계%' OR json_extract(p.attrs, '$.livestock_types') LIKE '%오리%' OR json_extract(p.attrs, '$.livestock_types') LIKE '%거위%' OR json_extract(p.attrs, '$.livestock_types') LIKE '%칠면조%' OR json_extract(p.attrs, '$.livestock_types') LIKE '%메추리%')"},
    {"id": "HPAI-MAP-003", "question": "발생번호 1392 HPAI 발생 농장 반경 10km, 발생 전 21일 안의 야생조류 검출 건수 알려줘", "kind": "scalar", "tier": 2, "sql": "SELECT count(*) AS wild_count FROM tb_hpai_outbreak_farm o JOIN tb_hpai_outbreak_wild w ON dist_m(o.longitude, o.latitude, w.longitude, w.latitude) <= 10000 AND w.report_date BETWEEN date(o.report_date, '-21 days') AND o.report_date WHERE o.outbreak_id = 1392"},
    {"id": "MAP-002", "question": "2025년 2월 전북 부안군 오리 농장을 가장 자주 방문한 위험 차량 3대의 단말 번호와 방문 횟수 알려줘", "kind": "rows", "ordered": True, "tier": 2, "compare": ["mobile_serial_number"], "sql": "SELECT h.mobile_serial_number, count(*) AS visit_count FROM tb_visit_history h JOIN tb_place_info p ON p.place_id = h.place_id JOIN tb_vehicle_risk_daily r ON r.mobile_serial_number = h.mobile_serial_number AND r.standard_date = h.standard_date WHERE h.standard_date BETWEEN '2025-02-01' AND '2025-02-28' AND p.sido = '전북' AND p.sigungu = '부안군' AND p.place_type = 'farm' AND json_extract(p.attrs, '$.livestock_types') LIKE '%오리%' AND r.risk_level = '위험' GROUP BY h.mobile_serial_number ORDER BY visit_count DESC, h.mobile_serial_number LIMIT 3"},
]


# ----------------------------------------------------------------------------------------------- ontology v0
def ontology(evidence_results):
    """Code-generated ontology_v0 from the DDL semantics + the example queries. Every record follows the vendored
    EvoOntology schema (terms/mappings/relations/constraints/evidence). Evidence results are trimmed to keep
    resolve_semantics responses small."""
    ev = []

    def evidence(eid, query, result, method="fixture query executed on vehicle_visit.sqlite"):
        ev.append({"id": eid, "source": "queries.jsonl", "query": query, "result": str(result)[:200], "validation_method": method, "timestamp": "2026-09-23"})
        return eid

    e_farm = evidence("ev-farm-count", QUERIES[0]["sql"], evidence_results.get("TEXT-001"))
    e_layer = evidence("ev-layer-farm", QUERIES[1]["sql"], evidence_results.get("TEXT-002"))
    e_h5n1 = evidence("ev-h5n1", QUERIES[2]["sql"], evidence_results.get("TEXT-003"))
    e_feed = evidence("ev-feed-vehicle", QUERIES[3]["sql"], evidence_results.get("TEXT-004"))
    e_route = evidence("ev-route", QUERIES[5]["sql"], evidence_results.get("MAP-001"))
    e_risk = evidence("ev-risk-level", "SELECT risk_level, count(*) FROM tb_vehicle_risk_daily GROUP BY 1", evidence_results.get("risk_levels"))
    e_dist = evidence("ev-dist", QUERIES[7]["sql"], evidence_results.get("HPAI-MAP-002"))
    e_wild = evidence("ev-wild", QUERIES[8]["sql"], evidence_results.get("HPAI-MAP-003"))

    terms = [
        {"id": "t-farm", "name": "농장", "type": "entity", "definition": "가축 사육 장소. tb_place_info에서 place_type='farm'인 행", "scope": "vehicle_visit", "aliases": ["farm", "농가", "사육농장", "축산농장", "농장 수", "농장 갯수", "농장수"], "evidence": [e_farm]},
        {"id": "t-place", "name": "장소", "type": "entity", "definition": "농장/시설/철새도래지를 아우르는 장소 허브 (tb_place_info)", "scope": "vehicle_visit", "aliases": ["place", "시설", "facility", "철새도래지", "habitat"], "evidence": []},
        {"id": "t-sido", "name": "시도", "type": "dimension", "definition": "장소·발생의 광역 지역. 약칭으로 저장 (경기, 충남, 충북, 전북, 전남, 경북, 경남, 강원)", "scope": "vehicle_visit", "aliases": ["sido", "지역", "도", "경기", "경기도", "충남", "충청남도", "충북", "충청북도", "전북", "전라북도", "전남", "경북", "경남", "강원"], "evidence": [e_farm]},
        {"id": "t-sigungu", "name": "시군구", "type": "dimension", "definition": "시·군·구 이름. 시에는 구가 붙을 수 있어 접두 일치(LIKE '천안시%')로 비교", "scope": "vehicle_visit", "aliases": ["sigungu", "시군구", "시", "군", "천안시", "제천시", "부안군", "안성시"], "evidence": [e_layer]},
        {"id": "t-livestock", "name": "축종", "type": "dimension", "definition": "농장이 기르는 가축 종류. attrs JSON의 livestock_types 쉼표 목록, 부분 일치로 검색", "scope": "vehicle_visit", "aliases": ["livestock", "livestock_types", "가축", "산란계", "육계", "오리", "종계", "토종닭", "메추리", "거위", "가금", "가금류", "닭", "돼지", "한우"], "evidence": [e_layer]},
        {"id": "t-outbreak-farm", "name": "HPAI 발생 농장", "type": "entity", "definition": "농장에서의 고병원성 조류인플루엔자 발생 사건 (tb_hpai_outbreak_farm, 1건 = 1행)", "scope": "vehicle_visit", "aliases": ["hpai", "HPAI", "AI 발생", "발생 농장", "발생농장", "조류인플루엔자", "outbreak", "발생 건수", "발생번호", "outbreak_id"], "evidence": [e_h5n1]},
        {"id": "t-genotype", "name": "유전형", "type": "dimension", "definition": "발생 바이러스의 혈청형/유전형 문자열 (예: H5N1). 부분 일치 LIKE '%H5N1%'", "scope": "vehicle_visit", "aliases": ["genotype", "혈청형", "H5N1", "H5N6", "H5N8", "형"], "evidence": [e_h5n1]},
        {"id": "t-vehicle", "name": "차량", "type": "entity", "definition": "축산 관계 차량 (tb_vehicle_info, 1대 = 1행). 단말 번호 mobile_serial_number가 방문·위험도와의 키", "scope": "vehicle_visit", "aliases": ["vehicle", "축산차량", "차량 수", "단말", "단말 번호", "mobile_serial_number", "차량번호"], "evidence": [e_feed]},
        {"id": "t-purpose", "name": "방문 목적", "type": "dimension", "definition": "차량의 방문 목적 (visit_purpose_name: 사료운반, 가축운반, 분뇨운반, 왕진진료, 컨설팅, 계란운반, 약품운반). 부분 일치", "scope": "vehicle_visit", "aliases": ["visit_purpose_name", "목적", "사료운반", "사료 운반", "사료운반차량", "가축운반", "분뇨운반", "왕진진료", "계란운반"], "evidence": [e_feed]},
        {"id": "t-visit", "name": "방문", "type": "entity", "definition": "차량이 장소에 도착한 이벤트 (tb_visit_history, 1건 = 1행). 동선은 start_time 순 정렬", "scope": "vehicle_visit", "aliases": ["visit", "방문 이력", "방문이력", "동선", "방문 기록", "방문 횟수", "방문한"], "evidence": [e_route]},
        {"id": "t-visit-date", "name": "방문일", "type": "dimension", "definition": "tb_visit_history.standard_date (YYYY-MM-DD). 월 질의는 BETWEEN 월초 AND 월말", "scope": "vehicle_visit", "aliases": ["standard_date", "날짜", "일자", "2024년 12월", "2025년 2월", "월"], "evidence": [e_route]},
        {"id": "t-risk", "name": "위험 차량", "type": "concept", "definition": "그날 위험도 등급이 '위험'인 차량 (tb_vehicle_risk_daily.risk_level='위험', risk_score>=1.0). 차량·일 단위", "scope": "vehicle_visit", "aliases": ["risk", "위험", "위험도", "risk_level", "위험 등급", "고위험 차량", "위험차량", "주의"], "evidence": [e_risk]},
        {"id": "t-distance", "name": "반경", "type": "concept", "definition": "두 좌표 사이 거리(m). sqlite 픽스처는 dist_m(lon1,lat1,lon2,lat2) <= 미터, Postgres는 ST_DWithin(geom, geom, m)", "scope": "vehicle_visit", "aliases": ["distance", "km", "10km", "3km", "주변", "인근", "반경 10km", "근처"], "evidence": [e_dist]},
        {"id": "t-poultry", "name": "가금", "type": "category", "definition": "조류 가축 전체: 닭(산란계, 육계, 종계, 토종닭), 오리, 거위, 칠면조, 메추리. 가금 농장 = livestock_types에 이들 중 하나라도 포함된 농장", "scope": "vehicle_visit", "aliases": ["poultry", "가금류", "가금 농장", "가금농장", "조류", "닭·오리"], "evidence": [e_dist]},
        {"id": "t-outbreak-wild", "name": "야생조류 검출", "type": "entity", "definition": "야생조류 HPAI 검출 건 (tb_hpai_outbreak_wild, 1건 = 1행)", "scope": "vehicle_visit", "aliases": ["wild", "야생조류", "철새", "야생 조류", "검출", "wild bird", "건수", "검출 건수", "야생조류 검출 건수", "야생조류 검출건수", "검출건수"], "evidence": [e_wild]},
    ]
    mappings = [
        {"id": "m-farm-count", "term_id": "t-farm", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "place_id", "semantic_filter": "place_type = 'farm'", "aggregation_semantics": "count(place_id) = 농장 수", "grain": "장소 1행", "validation": "TEXT-001 재현", "evidence_refs": [e_farm], "confidence": "high"},
        {"id": "m-sido", "term_id": "t-sido", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "sido", "semantic_filter": "sido = '<약칭>' (경기도→경기, 충청남도→충남)", "aggregation_semantics": "", "grain": "장소 1행", "validation": "TEXT-001", "evidence_refs": [e_farm], "confidence": "high"},
        {"id": "m-sigungu", "term_id": "t-sigungu", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "sigungu", "semantic_filter": "sigungu LIKE '<시>%' (구 접미 허용) 또는 sigungu = '<군>'", "aggregation_semantics": "", "grain": "장소 1행", "validation": "TEXT-002/005", "evidence_refs": [e_layer], "confidence": "high"},
        {"id": "m-livestock", "term_id": "t-livestock", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "attrs", "semantic_filter": "json_extract(attrs, '$.livestock_types') LIKE '%<축종>%'", "aggregation_semantics": "", "grain": "장소 1행", "validation": "TEXT-002", "evidence_refs": [e_layer], "confidence": "high"},
        {"id": "m-outbreak-count", "term_id": "t-outbreak-farm", "database_source": "vehicle_visit", "table": "tb_hpai_outbreak_farm", "column": "outbreak_id", "semantic_filter": "", "aggregation_semantics": "count(outbreak_id) = 발생 건수", "grain": "발생 1건", "validation": "TEXT-003", "evidence_refs": [e_h5n1], "confidence": "high"},
        {"id": "m-genotype", "term_id": "t-genotype", "database_source": "vehicle_visit", "table": "tb_hpai_outbreak_farm", "column": "genotype", "semantic_filter": "genotype LIKE '%H5N1%'", "aggregation_semantics": "", "grain": "발생 1건", "validation": "TEXT-003", "evidence_refs": [e_h5n1], "confidence": "high"},
        {"id": "m-outbreak-where", "term_id": "t-outbreak-farm", "database_source": "vehicle_visit", "table": "tb_hpai_outbreak_farm", "column": "sido, sigungu, report_date, longitude, latitude", "semantic_filter": "sido = '전북' AND sigungu = '부안군' AND report_date BETWEEN '2024-12-01' AND '2024-12-31' AND longitude IS NOT NULL", "aggregation_semantics": "행 목록 (지도용)", "grain": "발생 1건", "validation": "HPAI-MAP-001", "evidence_refs": [e_h5n1], "confidence": "high"},
        {"id": "m-vehicle", "term_id": "t-vehicle", "database_source": "vehicle_visit", "table": "tb_vehicle_info", "column": "mobile_serial_number", "semantic_filter": "", "aggregation_semantics": "count(DISTINCT mobile_serial_number) = 차량 수", "grain": "차량 1대", "validation": "TEXT-004", "evidence_refs": [e_feed], "confidence": "high"},
        {"id": "m-purpose", "term_id": "t-purpose", "database_source": "vehicle_visit", "table": "tb_vehicle_info", "column": "visit_purpose_name", "semantic_filter": "visit_purpose_name LIKE '%사료운반%'", "aggregation_semantics": "", "grain": "차량 1대", "validation": "TEXT-004", "evidence_refs": [e_feed], "confidence": "high"},
        {"id": "m-visit", "term_id": "t-visit", "database_source": "vehicle_visit", "table": "tb_visit_history", "column": "mobile_serial_number, place_id, place_type, start_time", "semantic_filter": "place_type = 'farm' (농장 방문); 차량 조인: mobile_serial_number; 장소 조인: place_id", "aggregation_semantics": "count(*) = 방문 횟수; 동선 = ORDER BY start_time", "grain": "방문 1건", "validation": "TEXT-004, MAP-001", "evidence_refs": [e_route, e_feed], "confidence": "high"},
        {"id": "m-visit-date", "term_id": "t-visit-date", "database_source": "vehicle_visit", "table": "tb_visit_history", "column": "standard_date", "semantic_filter": "standard_date BETWEEN 'YYYY-MM-01' AND 'YYYY-MM-31'", "aggregation_semantics": "", "grain": "방문 1건", "validation": "MAP-001", "evidence_refs": [e_route], "confidence": "high"},
        {"id": "m-risk", "term_id": "t-risk", "database_source": "vehicle_visit", "table": "tb_vehicle_risk_daily", "column": "risk_level", "semantic_filter": "risk_level = '위험' (조인: mobile_serial_number AND standard_date = 방문일)", "aggregation_semantics": "", "grain": "차량·일 1행", "validation": "MAP-002", "evidence_refs": [e_risk], "confidence": "high"},
        {"id": "m-poultry", "term_id": "t-poultry", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "attrs", "semantic_filter": "place_type = 'farm' AND (json_extract(attrs,'$.livestock_types') LIKE '%닭%' OR ... LIKE '%계%' OR ... LIKE '%오리%' OR ... LIKE '%거위%' OR ... LIKE '%칠면조%' OR ... LIKE '%메추리%')", "aggregation_semantics": "count(place_id) = 가금 농장 수", "grain": "장소 1행", "validation": "HPAI-MAP-002", "evidence_refs": [e_dist], "confidence": "high"},
        {"id": "m-distance", "term_id": "t-distance", "database_source": "vehicle_visit", "table": "tb_place_info", "column": "longitude, latitude", "semantic_filter": "dist_m(o.longitude, o.latitude, p.longitude, p.latitude) <= 10000", "aggregation_semantics": "", "grain": "장소 1행", "validation": "HPAI-MAP-002", "evidence_refs": [e_dist], "confidence": "medium"},
        {"id": "m-wild", "term_id": "t-outbreak-wild", "database_source": "vehicle_visit", "table": "tb_hpai_outbreak_wild", "column": "report_date, longitude, latitude", "semantic_filter": "report_date BETWEEN date(o.report_date, '-21 days') AND o.report_date", "aggregation_semantics": "count(*) = 검출 건수", "grain": "검출 1건", "validation": "HPAI-MAP-003", "evidence_refs": [e_wild], "confidence": "medium"},
    ]
    relations = [
        {"id": "r-farm-place", "source": "t-farm", "relation_type": "hierarchy", "target": "t-place", "connection_condition": "tb_place_info.place_type = 'farm'", "description": "농장은 장소의 한 종류"},
        {"id": "r-visit-vehicle", "source": "t-visit", "relation_type": "association", "target": "t-vehicle", "connection_condition": "tb_visit_history.mobile_serial_number = tb_vehicle_info.mobile_serial_number", "description": "방문한 차량"},
        {"id": "r-visit-place", "source": "t-visit", "relation_type": "association", "target": "t-place", "connection_condition": "tb_visit_history.place_id = tb_place_info.place_id", "description": "방문한 장소"},
        {"id": "r-risk-visit", "source": "t-risk", "relation_type": "association", "target": "t-visit", "connection_condition": "tb_vehicle_risk_daily.mobile_serial_number = tb_visit_history.mobile_serial_number AND tb_vehicle_risk_daily.standard_date = tb_visit_history.standard_date", "description": "방문일의 차량 위험도"},
        {"id": "r-outbreak-place", "source": "t-outbreak-farm", "relation_type": "association", "target": "t-place", "connection_condition": "tb_hpai_outbreak_farm.place_id = tb_place_info.place_id", "description": "발생 농장의 장소"},
        {"id": "r-wild-outbreak", "source": "t-outbreak-wild", "relation_type": "association", "target": "t-outbreak-farm", "connection_condition": "dist_m(...) <= 10000 AND report_date within 21 days before", "description": "발생 농장 주변·이전 3주의 야생조류 검출"},
    ]
    constraints = [
        {"id": "c-sido-short", "target": "t-sido", "constraint_type": "value_format", "trigger_keywords": ["경기도", "충청남도", "충청북도", "전라북도", "전라남도", "경상북도", "경상남도", "강원도"], "severity": "warn", "scope": "tb_place_info.sido, tb_hpai_outbreak_farm.sido", "description": "시도는 약칭(경기, 충남, 충북, 전북, 전남, 경북, 경남, 강원)으로 저장됨. 전체 이름으로 비교하면 0행"},
        {"id": "c-sigungu-prefix", "target": "t-sigungu", "constraint_type": "value_format", "trigger_keywords": ["시", "구", "천안시"], "severity": "warn", "scope": "tb_place_info.sigungu", "description": "시 아래에 구가 붙을 수 있으므로 시 단위 질의는 LIKE '<시>%'"},
        {"id": "c-livestock-like", "target": "t-livestock", "constraint_type": "value_format", "trigger_keywords": ["축종", "산란계", "오리", "육계", "가금"], "severity": "warn", "scope": "tb_place_info.attrs", "description": "livestock_types는 쉼표 목록이므로 json_extract(attrs,'$.livestock_types') LIKE '%<축종>%'"},
        {"id": "c-risk-values", "target": "t-risk", "constraint_type": "value_domain", "trigger_keywords": ["위험", "주의", "낮음", "위험도"], "severity": "block", "scope": "tb_vehicle_risk_daily.risk_level", "description": "risk_level 값은 정확히 '낮음' | '주의' | '위험'"},
        {"id": "c-read-only", "target": "t-visit", "constraint_type": "access", "trigger_keywords": ["삭제", "수정", "insert", "update"], "severity": "block", "scope": "all tables", "description": "읽기 전용. SELECT/WITH만 허용"},
        {"id": "c-radius-self", "target": "t-distance", "constraint_type": "convention", "trigger_keywords": ["반경", "주변", "인근", "근처"], "severity": "warn", "scope": "tb_hpai_outbreak_farm x tb_place_info", "description": "발생 농장 '주변/반경' 질의는 발생 농장 자신(place_id가 같은 행)을 제외하고 센다"},
        {"id": "c-window-inclusive", "target": "t-outbreak-wild", "constraint_type": "convention", "trigger_keywords": ["발생 전", "21일", "이전", "안의", "일 안"], "severity": "warn", "scope": "tb_hpai_outbreak_wild.report_date vs tb_hpai_outbreak_farm.report_date", "description": "'발생 전 N일 안' 창은 발생일 당일을 포함한다: w.report_date BETWEEN date(o.report_date, '-N days') AND o.report_date (엄격한 < 아님)"},
        {"id": "c-dialect", "target": "t-distance", "constraint_type": "dialect", "trigger_keywords": ["거리", "반경", "km", "ST_DWithin", "->>"], "severity": "info", "scope": "sqlite fixture", "description": "sqlite: json_extract(attrs,'$.k'), dist_m(lon1,lat1,lon2,lat2) 미터, date(x,'-21 days'); Postgres: attrs->>'k', ST_DWithin(geom,geom,m), INTERVAL"},
    ]
    return {"terms.json": terms, "mappings.json": mappings, "relations.json": relations, "constraints.json": constraints, "evidence.json": ev}


def main():
    os.makedirs(OUT, exist_ok=True)
    data_dir = os.path.join(OUT, "data")
    os.makedirs(data_dir, exist_ok=True)
    db = os.path.join(data_dir, "vehicle_visit.sqlite")
    counts = build_db(db)

    # expected results (sqlite with dist_m registered)
    con = sqlite3.connect(db)
    con.create_function("dist_m", 4, haversine_m)
    results = {}
    for q in QUERIES:
        rows = con.execute(q["sql"]).fetchall()
        results[q["id"]] = rows
    results["risk_levels"] = con.execute("SELECT risk_level, count(*) FROM tb_vehicle_risk_daily GROUP BY 1").fetchall()
    con.close()

    with open(os.path.join(data_dir, "schema.json"), "w", encoding="utf-8") as f:
        json.dump(SCHEMA, f, ensure_ascii=False, indent=2)
    # example data-task check suites (`delegate` kind:"data" tasks name one in `verify`; `default` is built in)
    checks_dir = os.path.join(data_dir, "checks")
    os.makedirs(checks_dir, exist_ok=True)
    with open(os.path.join(checks_dir, "farm-count.json"), "w", encoding="utf-8") as f:
        json.dump({"description": "a farm count answer: one non-negative number, filtered on place_type",
                   "checks": [
                       {"name": "single value", "sql": "SELECT count(*) FROM {answer} a", "expect": {"value": 1}},
                       {"name": "non-negative", "expect": {"value_min": 0}},
                       {"name": "filters farms", "expect": {"sql_contains": "place_type"}},
                       {"name": "not more than all farms", "sql": "SELECT (SELECT count(*) FROM {answer} a) <= (SELECT count(*) FROM tb_place_info WHERE place_type = 'farm')", "expect": {"value": 1}}]},
                  f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, "queries.jsonl"), "w", encoding="utf-8") as f:
        for q in QUERIES:
            rec = dict(q)
            rec["expected"] = [list(map(lambda v: v if not isinstance(v, float) else round(v, 5), r)) for r in results[q["id"]]]
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    ws = os.path.join(OUT, ".evoontology")
    vdir = os.path.join(ws, "versions", "ontology_v0")
    os.makedirs(vdir, exist_ok=True)
    for name, records in ontology({k: v for k, v in results.items()}).items():
        with open(os.path.join(vdir, name), "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)
    with open(os.path.join(ws, "active.json"), "w", encoding="utf-8") as f:
        json.dump({"active_version": "ontology_v0"}, f)
    with open(os.path.join(ws, "project.json"), "w", encoding="utf-8") as f:
        json.dump({
            "schema_version": 1,
            "mode": "rolling_trajectory",
            "data_source": db,
            "workload_source": os.path.join(OUT, "queries.jsonl"),
            "evaluation": {"protocol": "result_match", "judge": "code"},
            "boundary": {"note": "fixture: synthetic rows generated by make_fixture.py; ontology_v0 generated by code, not by the model"},
        }, f, ensure_ascii=False, indent=2)

    print(json.dumps({"db": db, "counts": counts, "expected": {k: (v[0] if len(v) == 1 else len(v)) for k, v in results.items() if k != "risk_levels"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
